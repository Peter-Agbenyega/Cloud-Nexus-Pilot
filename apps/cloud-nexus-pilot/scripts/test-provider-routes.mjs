import assert from "node:assert/strict";
import { after, test } from "node:test";
import { routeLoader } from "./route-test-loader.mjs";

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network request in route regression"); };
after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0, "No network calls are allowed in this suite"); });
const request = (body) => new Request("https://example.invalid/api/test", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});
const events = async (response) => (await response.text()).trim().split("\n\n")
  .map((line) => JSON.parse(line.replace(/^data: /, "")));
const denied = (status) => ({ requireProviderUser: async () => ({ response: Response.json({ error: "auth denied" }, { status }) }) });

for (const route of ["interview-context", "interview-report", "debug-diagnosis", "generate-guidance", "mock-interview"]) {
  test(`${route} rejects malformed and non-object bodies without a provider call`, async () => {
    const { POST } = routeLoader({ "@/lib/llm-providers": { selectConfiguredLLMProvider: () => null } })(route);
    for (const body of ["null", "[]", '"text"', "42", "true", "{broken", ""]) {
      const response = await POST(request(body));
      assert.equal(response.status, 400, `${route}: ${body}`);
    }
  });
}

for (const status of [401, 403, 503]) {
  test(`provider-backed routes stop before provider or session work on auth ${status}`, async () => {
    const unexpected = () => { assert.fail("provider/session work before authorization"); };
    const load = routeLoader({
      "@/lib/server/provider-auth": denied(status),
      "@/lib/llm-providers": { selectConfiguredLLMProvider: () => ({ streamText: unexpected }) },
      "@/lib/transcription/streaming-session-store": { createStreamingSession: unexpected },
    });
    for (const route of ["transcribe", "transcribe/stream/session", "generate-guidance"]) {
      assert.equal((await load(route).POST(request({ question: "What is Terraform?" }))).status, status);
    }
  });
}

test("guidance without a configured provider emits error and done, never a final answer", async () => {
  const { POST } = routeLoader({ "@/lib/llm-providers": { selectConfiguredLLMProvider: () => null } })("generate-guidance");
  const response = await POST(request({ question: "What is Terraform?" }));
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.deepEqual((await events(response)).map((e) => e.type), ["start", "error", "done"]);
});

for (const [name, output] of [["provider exception", null], ["malformed model output", "not JSON"]]) {
  test(`guidance ${name} finishes with an error and done`, async () => {
    const { POST } = routeLoader({
      "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "synthetic-owner" }) },
      "@/lib/llm-providers": { selectConfiguredLLMProvider: () => ({ async *streamText() {
        if (output === null) throw new Error("private provider details");
        yield output;
      } }) },
    })("generate-guidance");
    const result = await events(await POST(request({ question: "What is Terraform?" })));
    assert.equal(result.at(-1).type, "done");
    assert.equal(result.at(-2).type, "error");
    assert.ok(!result.some((e) => e.type === "final"));
    assert.doesNotMatch(JSON.stringify(result), /private provider details/);
  });
}

test("verified ordinary user guidance preserves token, final and done contracts", async () => {
  const output = JSON.stringify({ headline: "Infrastructure as code", speakNow: "Terraform manages infrastructure as code.", keyPoints: ["Review plans before applying."], full_answer: "Terraform manages infrastructure as code." });
  const { POST } = routeLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "synthetic-owner" }) },
    "@/lib/llm-providers": { selectConfiguredLLMProvider: () => ({ async *streamText() { yield output; } }) },
  })("generate-guidance");
  const result = await events(await POST(request({ question: "What is Terraform?" })));
  assert.deepEqual(result.map((e) => e.type), ["start", "token", "final", "done"]);
  assert.equal(result[1].token, output);
  assert.equal(JSON.parse(result[2].content).speakNow, "Terraform manages infrastructure as code.");
});

test("stream creation binds the verified user and ignores a caller-supplied owner", async () => {
  const { POST } = routeLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "verified-owner" }) },
    "@/lib/transcription/streaming-session-store": { createStreamingSession(owner) {
      assert.equal(owner, "verified-owner");
      return { id: "synthetic-session", createdAt: 1 };
    } },
  })("transcribe/stream/session");
  assert.equal((await POST(request({ ownerId: "forged-owner" }))).status, 201);
});

for (const action of ["events", "stop", "chunk"]) {
  test(`stream ${action} passes verified ownership and denies foreign sessions`, async () => {
    const checkOwner = (id, owner) => {
      assert.equal(id, "foreign-session");
      assert.equal(owner, "verified-owner");
    };
    let calls = 0;
    const route = routeLoader({
      "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "verified-owner" }) },
      "@/lib/transcription/streaming-session-store": {
        getStreamingSession(id, owner) { calls++; checkOwner(id, owner); return null; },
        stopStreamingSession(id, owner) { calls++; checkOwner(id, owner); return false; },
        processStreamingSessionChunk(input) {
          calls++; checkOwner(input.sessionId, input.ownerId);
          return { ok: false, code: "transcript_stream_session_missing", message: "Not found" };
        },
        subscribeToStreamingSession() { assert.fail("subscribed to a foreign session"); },
      },
    })(`transcribe/stream/session/[sessionId]/${action}`);
    const audio = new Request("https://example.invalid/api/test", { method: "POST", body: new Uint8Array([1]), headers: { "content-type": "audio/webm" } });
    const context = { params: Promise.resolve({ sessionId: "foreign-session" }) };
    const response = await (route.POST ?? route.GET)(audio, context);
    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  });
}

test("transcription hides unexpected provider details", async () => {
  const { POST } = routeLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "verified-owner" }) },
    "@/lib/transcription/deepgram-transcribe": { DeepgramTranscriptionError: class extends Error {}, isDeepgramTranscriptionConfigured: () => false },
    "@/lib/transcription/openai-transcribe": { OpenAiTranscriptionError: class extends Error {}, transcribeWithOpenAi: async () => { throw new Error("private provider details"); } },
  })("transcribe");
  const response = await POST(request({}));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private provider details/);
});

test("valid deterministic tools keep their response contracts", async () => {
  const load = routeLoader();
  for (const [route, body, field] of [
    ["interview-context", { question: "Walk me through how you would debug this Terraform AccessDenied error in AWS." }, "context"],
    ["interview-report", { transcriptText: "Interviewer: What is Terraform? Candidate: Terraform manages infrastructure as code." }, "report"],
    ["debug-diagnosis", { text: "Error: connection refused 127.0.0.1:5432" }, "diagnosis"],
  ]) {
    const response = await load(route).POST(request(body));
    assert.equal(response.status, 200, route);
    assert.ok((await response.json())[field], route);
  }
});
