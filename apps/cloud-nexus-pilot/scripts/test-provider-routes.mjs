import assert from "node:assert/strict";
import { after, test } from "node:test";
import { routeLoader, sourceLoader } from "./route-test-loader.mjs";

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
const permittedRepository = {
  reserve: async () => ({ acquired: true, state: "reserved" }),
  complete: async () => ({ state: "succeeded" }),
};
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
      "@/lib/server/processing-repository": { processingRepository: { create: unexpected, read: unexpected, reserve: unexpected, complete: unexpected } },
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
      "@/lib/server/processing-repository": { processingRepository: permittedRepository },
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

test("verified ordinary user guidance publishes validated final and done contracts", async () => {
  const output = JSON.stringify({ headline: "Infrastructure as code", speakNow: "Terraform manages infrastructure as code.", keyPoints: ["Review plans before applying."], full_answer: "Terraform manages infrastructure as code." });
  const { POST } = routeLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "synthetic-owner" }) },
      "@/lib/server/processing-repository": { processingRepository: permittedRepository },
    "@/lib/llm-providers": { selectConfiguredLLMProvider: () => ({ async *streamText() { yield output; } }) },
  })("generate-guidance");
  const result = await events(await POST(request({ question: "What is Terraform?" })));
  assert.deepEqual(result.map((e) => e.type), ["start", "final", "done"]);
  assert.equal(JSON.parse(result[1].content).speakNow, "Terraform manages infrastructure as code.");
});

test("stream creation binds the verified user and ignores a caller-supplied owner", async () => {
  const { POST } = routeLoader({
    "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "verified-owner" }) },
    "@/lib/server/processing-repository": { processingRepository: { create(principal) {
      assert.equal(principal.userId, "verified-owner");
      return { sessionId: "synthetic-session", createdAt: 1 };
    } } },
  })("transcribe/stream/session");
  assert.equal((await POST(request({ ownerId: "forged-owner" }))).status, 201);
});

for (const action of ["events", "stop", "chunk"]) {
  test(`stream ${action} passes verified ownership and denies foreign sessions`, async () => {
    const checkOwner = (principal, id) => {
      assert.equal(id, "foreign-session");
      assert.equal(principal.userId, "verified-owner");
    };
    let calls = 0;
    let BoundaryError;
    const unavailable = (principal, id) => {
      calls++; checkOwner(principal, id);
      throw new BoundaryError(404, "transcript_stream_session_missing", "Unavailable");
    };
    const load = sourceLoader({
      "@/lib/server/provider-auth": { requireProviderUser: async () => ({ userId: "verified-owner" }) },
      "@/lib/server/processing-repository": { processingRepository: {
        read: unavailable, stop: unavailable,
        reserve() { assert.fail("reserved foreign session"); },
        complete() { assert.fail("completed foreign session"); },
      } },
    });
    BoundaryError = load("@/lib/server/request-boundary").RequestBoundaryError;
    const route = load(`@/app/api/transcribe/stream/session/[sessionId]/${action}/route`);
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
    "@/lib/server/processing-repository": { processingRepository: permittedRepository },
    "@/lib/transcription/deepgram-transcribe": { DeepgramTranscriptionError: class extends Error {}, isDeepgramTranscriptionConfigured: () => false },
    "@/lib/transcription/openai-transcribe": { OpenAiTranscriptionError: class extends Error {}, transcribeWithOpenAi: async () => { throw new Error("private provider details"); } },
  })("transcribe");
  const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]]) bytes.set(new TextEncoder().encode(text), offset);
  view.setUint32(4,40,true); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); view.setUint32(40,4,true);
  const response = await POST(new Request("https://example.invalid/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: bytes }));
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
