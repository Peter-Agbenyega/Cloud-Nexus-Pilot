import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { inspect } from "node:util";
import { sourceLoader } from "./route-test-loader.mjs";

const sentinel = "DO_NOT_EXPOSE_SYNTHETIC_PROVIDER_SENTINEL";
const transcript = "Terraform stores the state of deployed resources.";
afterEach(() => {
  const store = globalThis.__cloudNexusStreamingStore;
  if (store?.cleanupInterval) clearInterval(store.cleanupInterval);
  globalThis.__cloudNexusStreamingStore = undefined;
});

function fixture(provider, result, owner = "owner-a") {
  const logs = [];
  let requests = 0;
  const env = { NODE_ENV: "test" };
  if (provider === "deepgram") env.DEEPGRAM_API_KEY = "synthetic-offline-key";
  if (provider === "openai") env.OPENAI_API_KEY = "synthetic-offline-key";
  const capture = (...args) => { logs.push(args.map((x) => inspect(x)).join(" ")); };
  const load = sourceLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: owner }) },
  }, {
    process: { env },
    console: { info: capture, warn: capture, error: capture, log: capture },
    fetch: async () => {
      requests++;
      if (result instanceof Error) throw result;
      if (!result) assert.fail("Unexpected provider invocation");
      return new Response(typeof result.body === "string" ? result.body : JSON.stringify(result.body), { status: result.status });
    },
  });
  return { load, logs, requests: () => requests, route: (name) => load(`@/app/api/${name}/route`) };
}

function audio(size = 1, contentType = "audio/webm") {
  return new Request("https://example.invalid/api/transcribe", {
    method: "POST", body: new Uint8Array(size),
    headers: { "content-type": contentType, "X-Chunk-Index": "7", "X-Transcript-Source": "system-audio" },
  });
}
const context = (id) => ({ params: Promise.resolve({ sessionId: id }) });
async function readEvent(reader) {
  let timer;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Expected in-memory SSE event")), 1500); }),
    ]);
    return new TextDecoder().decode(chunk.value);
  } finally { clearTimeout(timer); }
}
async function streamChunk(f, { sessionOwner = "owner-a", size = 1, contentType = "audio/webm" } = {}) {
  const store = f.load("@/lib/transcription/streaming-session-store");
  const session = store.createStreamingSession(sessionOwner);
  const response = await f.route("transcribe/stream/session/[sessionId]/events").GET(new Request("https://example.invalid/events"), context(session.id));
  if (response.status !== 200) return { response, session, store };
  const reader = response.body.getReader();
  try {
    await readEvent(reader); // Existing initial connected status.
    await readEvent(reader); // Store subscription's active status.
    const http = await f.route("transcribe/stream/session/[sessionId]/chunk").POST(audio(size, contentType), context(session.id));
    const text = await http.text();
    let event = "";
    if (size && contentType === "audio/webm") event = await readEvent(reader);
    return { http, text, event };
  } finally {
    await reader.cancel();
    store.stopStreamingSession(session.id, sessionOwner);
  }
}

for (const provider of ["deepgram", "openai"]) {
  for (const body of [sentinel, { error: { message: sentinel, code: sentinel, type: sentinel }, err_msg: sentinel, err_code: sentinel, reason: sentinel }]) {
    test(`${provider} upstream ${typeof body} failure is absent from HTTP, SSE and logs`, async () => {
      const f = fixture(provider, { status: 429, body });
      const direct = await f.route("transcribe").POST(audio());
      assert.equal(direct.status, 429);
      const directText = await direct.text();
      const streamed = await streamChunk(f);
      assert.equal(streamed.http.status, 400); // Existing chunk failure status contract.
      const observed = directText + streamed.text + streamed.event + f.logs.join("\n");
      assert.doesNotMatch(observed, new RegExp(sentinel));
      for (const text of [directText, streamed.text]) assert.equal(Object.hasOwn(JSON.parse(text).error, "detail"), false);
      const event = JSON.parse(streamed.event.replace(/^data: /, ""));
      assert.equal(event.type, "chunk-error");
      assert.equal(event.error.code, "transcript_processing_failed");
      assert.equal(Object.hasOwn(event.error, "detail"), false);
      assert.ok(f.logs.length > 0);
      assert.equal(f.requests(), 2);
    });
  }
}

test("unknown transport exception fields cannot become public errors or logs", async () => {
  const error = Object.assign(new Error(sentinel), { code: sentinel, detail: sentinel, status: 418 });
  const f = fixture("openai", error);
  const direct = await f.route("transcribe").POST(audio());
  assert.equal(direct.status, 500);
  const streamed = await streamChunk(f);
  assert.equal(streamed.http.status, 400);
  const observed = await direct.text() + streamed.text + streamed.event + f.logs.join("\n");
  assert.doesNotMatch(observed, new RegExp(sentinel));
});

test("known provider error codes never authorize upstream message/detail text", async () => {
  for (const [code, upstreamStatus, status, chunkStatus] of [
    ["transcript_processing_failed", 502, 502, 400],
    ["transcript_backend_unavailable", 418, 503, 503],
    ["transcript_validation_failed", 500, 400, 400],
  ]) {
    const f = fixture("openai", Object.assign(new Error(sentinel), { code, status: upstreamStatus, detail: sentinel }));
    const direct = await f.route("transcribe").POST(audio());
    assert.equal(direct.status, status);
    const streamed = await streamChunk(f);
    assert.equal(streamed.http.status, chunkStatus);
    const observed = await direct.text() + streamed.text + streamed.event + f.logs.join("\n");
    assert.doesNotMatch(observed, new RegExp(sentinel));
    assert.equal(JSON.parse(streamed.text).error.code, code);
  }
});

test("provider HTTP failures retain their existing file-route status", async () => {
  for (const provider of ["deepgram", "openai"]) {
    for (const status of [400, 401, 403, 422, 429, 500, 503]) {
      const f = fixture(provider, { status, body: sentinel });
      const response = await f.route("transcribe").POST(audio());
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text() + f.logs.join("\n"), new RegExp(sentinel));
    }
  }
});

test("exported provider exceptions sanitize caller-supplied diagnostic fields", () => {
  for (const [provider, name] of [["deepgram", "DeepgramTranscriptionError"], ["openai", "OpenAiTranscriptionError"]]) {
    const f = fixture(provider, null);
    const ErrorClass = f.load(`@/lib/transcription/${provider}-transcribe`)[name];
    const error = new ErrorClass({ status: 429, code: "transcript_processing_failed", message: sentinel, detail: sentinel });
    assert.equal(error.status, 429);
    assert.equal(error.detail, "");
    assert.doesNotMatch(error.message, new RegExp(sentinel));
  }
});

test("SSE boundary sanitizes even a raw error supplied by the session store", async () => {
  const load = sourceLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "owner-a" }) },
    "@/lib/transcription/streaming-session-store": {
      getStreamingSession: () => ({ stopped: false }),
      subscribeToStreamingSession: (sessionId, _owner, listener) => {
        listener({ type: "chunk-error", sessionId, chunkIndex: 7, error: { code: sentinel, message: sentinel, detail: sentinel } });
        return () => {};
      },
    },
  }, { console: { info() {} } });
  const response = await load("@/app/api/transcribe/stream/session/[sessionId]/events/route").GET(new Request("https://example.invalid/events"), context("synthetic-session"));
  const reader = response.body.getReader();
  try {
    await readEvent(reader);
    const event = await readEvent(reader);
    assert.doesNotMatch(event, new RegExp(sentinel));
    const payload = JSON.parse(event.replace(/^data: /, ""));
    assert.equal(payload.error.code, "transcript_processing_failed");
    assert.equal(Object.hasOwn(payload.error, "detail"), false);
  } finally { await reader.cancel(); }
});

test("chunk HTTP boundary sanitizes raw store errors and error logs", async () => {
  const logs = [];
  const capture = (...args) => logs.push(inspect(args));
  const load = sourceLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "owner-a" }) },
    "@/lib/transcription/streaming-session-store": {
      processStreamingSessionChunk: async () => ({ ok: false, code: "transcript_processing_failed", message: sentinel, detail: sentinel }),
    },
  }, { console: { info: capture, warn: capture } });
  const response = await load("@/app/api/transcribe/stream/session/[sessionId]/chunk/route").POST(audio(), context("synthetic-session"));
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.doesNotMatch(text + logs.join("\n"), new RegExp(sentinel));
  assert.equal(Object.hasOwn(JSON.parse(text).error, "detail"), false);
});

test("unknown and hostile error fields fail closed without being stringified", () => {
  const normalize = fixture(null, null).load("@/lib/transcription/public-error").toPublicTranscriptionError;
  for (const error of [
    null, sentinel,
    { code: "__proto__", status: 418, message: sentinel },
    { code: "constructor", status: 418, detail: sentinel },
    { get code() { throw new Error(sentinel); } },
  ]) {
    const safe = normalize(error);
    assert.equal(safe.status, 500);
    assert.equal(safe.error.code, "transcript_processing_failed");
    assert.doesNotMatch(JSON.stringify(safe), new RegExp(sentinel));
  }
});

test("missing provider and empty audio retain 503/400 behavior without provider work", async () => {
  const missing = fixture(null, null);
  assert.equal((await missing.route("transcribe").POST(audio())).status, 503);
  assert.equal((await streamChunk(missing)).http.status, 503);
  assert.equal(missing.requests(), 0);
  const empty = fixture("openai", null);
  assert.equal((await empty.route("transcribe").POST(audio(0))).status, 400);
  assert.equal((await streamChunk(empty, { size: 0 })).http.status, 400);
  assert.equal((await streamChunk(empty, { contentType: "text/plain" })).http.status, 415);
  assert.equal(empty.requests(), 0);
});

test("foreign stream rejection remains 404 before provider work", async () => {
  const f = fixture("openai", null, "owner-b");
  const store = f.load("@/lib/transcription/streaming-session-store");
  const session = store.createStreamingSession("owner-a");
  const events = await f.route("transcribe/stream/session/[sessionId]/events").GET(new Request("https://example.invalid/events"), context(session.id));
  const chunk = await f.route("transcribe/stream/session/[sessionId]/chunk").POST(audio(), context(session.id));
  assert.equal(events.status, 404);
  assert.equal(chunk.status, 404);
  assert.equal(f.requests(), 0);
  store.stopStreamingSession(session.id, "owner-a");
});

for (const provider of ["deepgram", "openai"]) {
  test(`${provider} successful HTTP and streamed transcript contracts are preserved`, async () => {
    const body = provider === "deepgram" ? { results: { channels: [{ alternatives: [{ transcript }] }] }, metadata: { duration: 0.5 } } : { text: transcript };
    const f = fixture(provider, { status: 200, body });
    const direct = await f.route("transcribe").POST(audio());
    assert.equal(direct.status, 200);
    const payload = await direct.json();
    assert.equal(payload.text, transcript);
    assert.equal(payload.chunkIndex, 7);
    assert.equal(payload.source, "system-audio");
    const streamed = await streamChunk(f);
    assert.equal(streamed.http.status, 202);
    const event = JSON.parse(streamed.event.replace(/^data: /, ""));
    assert.equal(event.type, "chunk-result");
    assert.deepEqual(event.response, payload);
  });
}
