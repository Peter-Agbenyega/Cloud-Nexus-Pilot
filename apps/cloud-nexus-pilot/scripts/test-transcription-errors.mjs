import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { sourceLoader } from "./route-test-loader.mjs";

const sentinel = "DO_NOT_EXPOSE_SYNTHETIC_PROVIDER_SENTINEL";
const transcript = "Terraform stores the state of deployed resources.";

function fixture(provider, result, owner = "owner-a") {
  const logs = [];
  let requests = 0;
  const sessions = new Map(), operations = new Map();
  let BoundaryError;
  const env = { NODE_ENV: "test" };
  if (provider === "deepgram") env.DEEPGRAM_API_KEY = "synthetic-offline-key";
  if (provider === "openai") env.OPENAI_API_KEY = "synthetic-offline-key";
  const capture = (...args) => { logs.push(args.map((x) => inspect(x)).join(" ")); };
  const repository = {
    async read(principal, id, after = 0) {
      const session = sessions.get(id);
      if (!session || session.ownerId !== principal.userId) throw new BoundaryError(404, "transcript_stream_session_missing", "Unavailable");
      return { ...session, events: session.events.filter((event) => event.sequence > after) };
    },
    async reserve(principal, input) {
      if (input.sessionId) await repository.read(principal, input.sessionId);
      operations.set(input.operationId, input);
      return { acquired: true, state: "reserved" };
    },
    async complete(_principal, input) {
      const operation = operations.get(input.operationId);
      if (input.outcome === "succeeded" && operation?.sessionId) {
        const session = sessions.get(operation.sessionId);
        session.events.push({ sequence: session.events.length + 1, provider_result: input.result });
      }
      return { state: input.outcome, result: input.result };
    },
  };
  const load = sourceLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: owner }) },
    "@/lib/server/processing-repository": { processingRepository: repository },
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
  BoundaryError = load("@/lib/server/request-boundary").RequestBoundaryError;
  return { load, logs, repository, requests: () => requests, route: (name) => load(`@/app/api/${name}/route`),
    create(sessionOwner) { const session = { ownerId: sessionOwner, sessionId: crypto.randomUUID(), status: "active", events: [] }; sessions.set(session.sessionId, session); return session; },
  };
}

function audio(size = 1, contentType = "audio/wav") {
  const bytes = new Uint8Array(size ? 364 : 0);
  if (size) {
    const view = new DataView(bytes.buffer);
    const write = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);
    write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVE"); write(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, "data"); view.setUint32(40, bytes.length - 44, true);
  }
  return new Request("https://example.invalid/api/transcribe", {
    method: "POST", body: bytes,
    headers: { "content-type": contentType, "X-Chunk-Index": "7", "X-Transcript-Source": "system-audio" },
  });
}

const context = (id) => ({ params: Promise.resolve({ sessionId: id }) });
async function readEvent(reader) {
  let timer;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Expected durable SSE event")), 1500); }),
    ]);
    return new TextDecoder().decode(chunk.value);
  } finally { clearTimeout(timer); }
}
async function streamChunk(f, { sessionOwner = "owner-a", size = 1, contentType = "audio/wav" } = {}) {
  const session = f.create(sessionOwner);
  const response = await f.route("transcribe/stream/session/[sessionId]/events").GET(new Request("https://example.invalid/events"), context(session.sessionId));
  if (response.status !== 200) return { response, session };
  const reader = response.body.getReader();
  try {
    await readEvent(reader); // Connected status.
    await readEvent(reader); // Initial polling heartbeat.
    const http = await f.route("transcribe/stream/session/[sessionId]/chunk").POST(audio(size, contentType), context(session.sessionId));
    const text = await http.text();
    session.status = "ended";
    let event = "";
    // The durable stream publishes only committed final records. Provider
    // failures remain safe HTTP errors, not fabricated final transcript events.
    for (let count = 0; count < 4; count++) {
      const next = await readEvent(reader);
      event += next;
      if (/"type":"(?:chunk-result|status)"/.test(next)) break;
    }
    return { http, text, event };
  } finally { await reader.cancel(); }
}

for (const provider of ["deepgram", "openai"]) {
  for (const body of [sentinel, { error: { message: sentinel, code: sentinel, type: sentinel }, err_msg: sentinel, err_code: sentinel, reason: sentinel }]) {
    test(`${provider} upstream ${typeof body} failure is absent from HTTP, SSE and logs`, async () => {
      const f = fixture(provider, { status: 429, body });
      const direct = await f.route("transcribe").POST(audio());
      assert.equal(direct.status, 429);
      const directText = await direct.text();
      const streamed = await streamChunk(f);
      assert.equal(streamed.http.status, 429);
      const observed = directText + streamed.text + streamed.event + f.logs.join("\n");
      assert.doesNotMatch(observed, new RegExp(sentinel));
      for (const text of [directText, streamed.text]) assert.equal(Object.hasOwn(JSON.parse(text).error, "detail"), false);
      assert.doesNotMatch(streamed.event, /"type":"chunk-result"/);
      assert.equal(JSON.parse(streamed.text).error.code, "transcript_processing_failed");
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
  assert.equal(streamed.http.status, 500);
  const observed = await direct.text() + streamed.text + streamed.event + f.logs.join("\n");
  assert.doesNotMatch(observed, new RegExp(sentinel));
});

test("known provider error codes never authorize upstream message/detail text", async () => {
  for (const [code, upstreamStatus, status, chunkStatus] of [
    ["transcript_processing_failed", 502, 502, 502],
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

test("SSE boundary closes safely on raw repository errors without exposing payloads", async () => {
  let reads = 0;
  const load = sourceLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "owner-a" }) },
    "@/lib/server/processing-repository": { processingRepository: {
      async read() { if (++reads > 1) throw Object.assign(new Error(sentinel), { detail: sentinel }); return { status: "active", events: [] }; },
    } },
  }, { console: { info() {} } });
  const response = await load("@/app/api/transcribe/stream/session/[sessionId]/events/route").GET(new Request("https://example.invalid/events"), context("synthetic-session"));
  const events = await response.text();
  assert.doesNotMatch(events, new RegExp(sentinel));
  assert.match(events, /"type":"status"/);
  assert.doesNotMatch(events, /"type":"chunk-result"/);
});

test("chunk HTTP boundary sanitizes raw repository errors and error logs", async () => {
  const logs = [];
  const capture = (...args) => logs.push(inspect(args));
  const load = sourceLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "owner-a" }) },
    "@/lib/server/processing-repository": { processingRepository: {
      async read() { throw Object.assign(new Error(sentinel), { code: "transcript_processing_failed", detail: sentinel }); },
      reserve() { assert.fail("reserved despite failed owned read"); },
    } },
  }, { console: { info: capture, warn: capture } });
  const response = await load("@/app/api/transcribe/stream/session/[sessionId]/chunk/route").POST(audio(), context("synthetic-session"));
  assert.equal(response.status, 500);
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
  const session = f.create("owner-a");
  const events = await f.route("transcribe/stream/session/[sessionId]/events").GET(new Request("https://example.invalid/events"), context(session.sessionId));
  const chunk = await f.route("transcribe/stream/session/[sessionId]/chunk").POST(audio(), context(session.sessionId));
  assert.equal(events.status, 404);
  assert.equal(chunk.status, 404);
  assert.equal(f.requests(), 0);
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
    const event = JSON.parse(streamed.event.split("\n").find((line) => line.startsWith("data: ")).slice(6));
    assert.equal(event.type, "chunk-result");
    assert.deepEqual(event.response, payload);
  });
}
