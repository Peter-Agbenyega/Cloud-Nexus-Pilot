import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGuidanceAssociation, ensureOwnedGuidanceSession, readFinalGuidance, requestOwnedGuidance, savedGuidanceAssociations } from "../../features/transcription/guidance-session-client";

const question = "How should I explain my actual Kubernetes experience?";
function stubFetch(t: { after: (fn: () => void) => void }, handler: typeof fetch) {
  const original = globalThis.fetch; globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}
function guidanceResponse(content = '{"gist":"Explain verified evidence","key_points":[],"full_answer":"Use your supplied evidence; identify missing experience honestly."}') {
  return new Response(`data: ${JSON.stringify({ type: "final", content })}\n\ndata: {"type":"done"}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("guidance association is stable but changes with the question or transcript revision", async () => {
  const segments = [{ id: "event-1", chunkIndex: 0, text: "I did not operate that service.", source: "microphone" }];
  const first = await buildGuidanceAssociation(question, segments);
  assert.deepEqual(await buildGuidanceAssociation(question, segments), first);
  assert.match(first.questionId, /^question:[a-f0-9]{64}$/);
  assert.match(first.transcriptRevision, /^transcript:[a-f0-9]{64}$/);
  assert.notEqual((await buildGuidanceAssociation("What did I actually deploy?", segments)).questionId, first.questionId);
  assert.notEqual((await buildGuidanceAssociation(question, [{ ...segments[0]!, text: "I operated the service." }])).transcriptRevision, first.transcriptRevision);
});

test("typed guidance creates an acknowledged owned session without audio and sends that association to the provider route", async (t) => {
  const calls: string[] = []; let body: Record<string, unknown> = {};
  stubFetch(t, async (url, init) => {
    calls.push(String(url));
    if (String(url) === "/api/transcribe/stream/session") return Response.json({ sessionId: "owned-typed", saved: true }, { status: 201 });
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return guidanceResponse();
  });
  const signal = new AbortController().signal;
  const result = await requestOwnedGuidance({ question, segments: [], body: { sessionId: "forged", userId: "arbitrary-header-is-not-identity" }, signal,
    ensureSession: parent => ensureOwnedGuidanceSession(null, parent) });
  assert.deepEqual(calls, ["/api/transcribe/stream/session", "/api/generate-guidance"]);
  assert.equal(result.sessionId, "owned-typed"); assert.equal(body.sessionId, "owned-typed");
  assert.equal(body.question, question); assert.match(String(body.questionId), /^question:/); assert.match(String(body.transcriptRevision), /^transcript:/);
  assert.match(await readFinalGuidance(result.response, signal), /verified evidence/);
});

test("an owned active live session is reused; an ended typed session creates a fresh owned session", async (t) => {
  const calls: string[] = []; let state = "active";
  stubFetch(t, async url => {
    calls.push(String(url));
    if (String(url).endsWith("/existing")) return Response.json({ sessionId: "existing", saved: true, status: state });
    return Response.json({ sessionId: "new-owned", saved: true }, { status: 201 });
  });
  assert.equal(await ensureOwnedGuidanceSession("existing"), "existing");
  assert.equal(calls.length, 1);
  state = "ended";
  assert.equal(await ensureOwnedGuidanceSession("existing"), "new-owned");
  assert.equal(calls.at(-1), "/api/transcribe/stream/session");
});

test("unauthenticated or unacknowledged owned-session creation cannot reach guidance", async (t) => {
  let guidanceCalls = 0; let status = 401;
  stubFetch(t, async url => {
    if (String(url).includes("generate-guidance")) { guidanceCalls += 1; return guidanceResponse(); }
    return Response.json(status === 401 ? { error: { code: "authentication_required" } } : { sessionId: "unacknowledged", saved: false }, { status });
  });
  const run = () => requestOwnedGuidance({ question, segments: [], body: {}, signal: new AbortController().signal, ensureSession: signal => ensureOwnedGuidanceSession(null, signal) });
  await assert.rejects(run(), /could not be created/); status = 201;
  await assert.rejects(run(), /did not acknowledge/);
  assert.equal(guidanceCalls, 0);
});

test("cancellation after session preparation prevents the guidance request", async (t) => {
  let guidanceCalls = 0; const controller = new AbortController();
  stubFetch(t, async () => { guidanceCalls += 1; return guidanceResponse(); });
  await assert.rejects(requestOwnedGuidance({ question, segments: [], body: {}, signal: controller.signal,
    ensureSession: async () => { controller.abort(); return "owned"; } }), { name: "AbortError" });
  assert.equal(guidanceCalls, 0);
});

test("recovery displays only committed guidance with its saved question and revision association", () => {
  const items = savedGuidanceAssociations({ guidance: [
    { state: "unknown", operation_id: "pending", result: { gist: "unverified", full_answer: "do not display" } },
    { state: "succeeded", operation_id: "done", created_at: "2026-10-27T00:00:00Z", result: {
      question, questionId: "question:one", transcriptRevision: "transcript:one", headline: "Use actual evidence", speakNow: "Describe what you actually did.", keyPoints: ["Verified examples", 42], full_answer: "Clearly separate hypothetical designs from personal experience.",
    } },
  ] });
  assert.equal(items.length, 1); assert.equal(items[0]?.question, question);
  assert.equal(items[0]?.questionId, "question:one"); assert.equal(items[0]?.transcriptRevision, "transcript:one");
  assert.deepEqual(items[0]?.keyPoints, ["Verified examples"]);
});

test("completed guidance handles split UTF-8 and CRLF, and cancels/releases its reader", async () => {
  const content = JSON.stringify({ gist: "Café", key_points: [], full_answer: "Use verified résumé evidence." });
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: "final", content })}\r\n\r\ndata: {"type":"done"}\r\n\r\n`);
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); }, cancel() { cancelled += 1; } });
  assert.equal(await readFinalGuidance(new Response(stream), new AbortController().signal), content);
  assert.equal(cancelled, 1); assert.equal(stream.locked, false);
});

test("truncated, malformed, oversized or cancelled guidance is not presented as a completed answer", async () => {
  await assert.rejects(readFinalGuidance(new Response('data: {"type":"final","content":"partial"}\n\n'), new AbortController().signal), /before completion/);
  await assert.rejects(readFinalGuidance(new Response('data: not-json\n\n'), new AbortController().signal));
  await assert.rejects(readFinalGuidance(new Response("x".repeat(262_145)), new AbortController().signal), /exceeded/);
  const controller = new AbortController(); const stream = new ReadableStream<Uint8Array>({});
  const pending = readFinalGuidance(new Response(stream), controller.signal); controller.abort();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(stream.locked, false);
});


test("provisional words arrive before final completion and never resolve the saved answer early", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const previews: string[] = [];
  let previewSeen!: () => void;
  const previewReady = new Promise<void>(resolve => { previewSeen = resolve; });
  let completed = false;
  const pending = readFinalGuidance(new Response(stream), new AbortController().signal, {
    onPreview(text) { previews.push(text); previewSeen(); },
  }).then(value => { completed = true; return value; });
  const emit = (value: object) => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  emit({ type: "preview", speakNow: "Kubernetes manages containers.", draft: true });
  await previewReady;
  assert.deepEqual(previews, ["Kubernetes manages containers."]);
  assert.equal(completed, false, "a draft must not resolve the persisted final contract");
  const final = JSON.stringify({ speakNow: previews[0], full_answer: "The completed saved answer." });
  emit({ type: "final", content: final }); emit({ type: "done" });
  assert.equal(await pending, final);
  assert.equal(stream.locked, false);
});

test("provider errors and cancellation clear provisional text without yielding a completed answer", async () => {
  for (const reason of ["error", "abort"] as const) {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const controller = new AbortController(), previews: string[] = [];
    let shown!: () => void;
    const ready = new Promise<void>(resolve => { shown = resolve; });
    const pending = readFinalGuidance(new Response(stream), controller.signal, {
      onPreview(text) { previews.push(text); shown(); },
    });
    const rejection = assert.rejects(pending);
    source.enqueue(new TextEncoder().encode('data: {"type":"preview","speakNow":"Draft answer starts here.","draft":true}\n\n'));
    await ready;
    if (reason === "abort") controller.abort();
    else source.enqueue(new TextEncoder().encode('data: {"type":"error","message":"The answer could not be completed."}\n\n'));
    await rejection;
    assert.deepEqual(previews, ["Draft answer starts here.", ""]);
    assert.equal(stream.locked, false);
  }
});

test("invalid previews are rejected before callback delivery", async () => {
  for (const preview of [{ type: "preview", speakNow: "Not marked as draft." }, { type: "preview", speakNow: "x".repeat(2401), draft: true }]) {
    let calls = 0;
    await assert.rejects(readFinalGuidance(new Response(`data: ${JSON.stringify(preview)}\n\n`), new AbortController().signal, {
      onPreview() { calls += 1; },
    }), /preview is invalid/);
    assert.equal(calls, 0);
  }
});
