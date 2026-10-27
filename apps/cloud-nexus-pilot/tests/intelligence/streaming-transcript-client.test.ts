import assert from "node:assert/strict";
import { test } from "node:test";
import { createStreamingTranscriptClient } from "../../features/transcription/streaming-transcript-service";
import { loadSavedTranscriptSession, deleteSavedTranscriptSession, listOwnedTranscriptSessions } from "../../features/transcription/saved-session-service";

class FakeEventSource {
  static current: FakeEventSource; static failBeforeOpen = false;
  onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null; closed = 0;
  constructor() { FakeEventSource.current = this; queueMicrotask(() => FakeEventSource.failBeforeOpen ? this.onerror?.() : this.onopen?.()); }
  close() { this.closed += 1; }
  emit(payload: unknown) { this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) } as MessageEvent<string>); }
}
const result = (index: number) => ({ text: `Final transcript ${index}`, chunkIndex: index, source: "microphone", contentType: "audio/wav" });
const params = (index: number) => ({ chunkIndex: index, source: "microphone" as const, contentType: "audio/wav", blob: new Blob([new Uint8Array(100)]) });
function fixtures(t: { after: (fn: () => void) => void }, chunkFetch?: (init?: RequestInit) => Promise<Response>) {
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "fetch", "EventSource"]) old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    if (input.endsWith("/chunk")) return chunkFetch ? chunkFetch(init) : Response.json({ ok: true }, { status: 202 });
    if (input.endsWith("/stop")) return Response.json({ ok: true });
    return Response.json({ sessionId: "owned-session" }, { status: 201 });
  } });
  t.after(() => {
    for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    FakeEventSource.failBeforeOpen = false;
  });
  return calls;
}

test("transcript transport rejects malformed/cross-session events, deduplicates uploads and orders final delivery", async (t) => {
  const calls = fixtures(t); const delivered: number[] = [];
  const client = await createStreamingTranscriptClient({ onTranscript: r => delivered.push(r.chunkIndex) });
  const first = client.sendChunk(params(0));
  assert.equal(client.sendChunk(params(0)), first);
  const second = client.sendChunk(params(1));
  const events = FakeEventSource.current;
  assert.doesNotThrow(() => events.emit("not-json"));
  assert.doesNotThrow(() => events.emit(null));
  events.emit({ type: "chunk-result", sessionId: "another-owner-session", chunkIndex: 0, response: result(0) });
  events.emit({ type: "chunk-result", sessionId: client.sessionId, chunkIndex: 0, response: { ...result(0), source: "system-audio" } });
  events.emit({ type: "chunk-result", sessionId: client.sessionId, chunkIndex: 1, response: result(1) });
  assert.deepEqual(delivered, []);
  events.emit({ type: "chunk-result", sessionId: client.sessionId, chunkIndex: 0, response: result(0) });
  await Promise.all([first, second]);
  assert.deepEqual(delivered, [0, 1]);
  events.emit({ type: "chunk-result", sessionId: client.sessionId, chunkIndex: 0, response: result(0) });
  await client.sendChunk(params(0));
  assert.equal(calls.filter(c => c.url.endsWith("/chunk")).length, 2);
  const stop1 = client.stop(), stop2 = client.stop();
  assert.equal(stop1, stop2); await stop1;
  await assert.rejects(client.sendChunk(params(2)), /stopped/);
  assert.equal(calls.filter(c => c.url.endsWith("/stop")).length, 1);
});

test("durable HTTP acknowledgement completes during event reconnect and does not duplicate its later SSE final", async (t) => {
  let saved = 0; const delivered: number[] = [];
  fixtures(t, async init => Response.json({ ok: true, saved: true, response: result(Number(new Headers(init?.headers).get("X-Chunk-Index"))) }, { status: 202 }));
  const client = await createStreamingTranscriptClient({ onSaveAcknowledged: () => { saved += 1; }, onTranscript: r => delivered.push(r.chunkIndex) });
  FakeEventSource.current.onerror?.();
  const value = await client.sendChunk(params(0));
  assert.equal(value.text, result(0).text); assert.equal(saved, 1);
  FakeEventSource.current.emit({ type: "chunk-result", sessionId: client.sessionId, chunkIndex: 0, response: result(0) });
  assert.deepEqual(delivered, [0]); await client.stop();
});

test("chunk deadline aborts its upload; repeated stop closes resources without new uploads", async (t) => {
  let signal: AbortSignal | undefined;
  fixtures(t, async init => {
    signal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  });
  const client = await createStreamingTranscriptClient({ chunkTimeoutMs: 20 });
  await assert.rejects(client.sendChunk(params(0)), /Timed out/);
  assert.equal(signal?.aborted, true);
  await client.stop(); assert.equal(FakeEventSource.current.closed, 1);
});

test("pre-open event failure rejects immediately and stops the orphaned owned session", async (t) => {
  const calls = fixtures(t); FakeEventSource.failBeforeOpen = true;
  await assert.rejects(createStreamingTranscriptClient({ connectTimeoutMs: 1000 }), /failed before connecting/);
  assert.equal(FakeEventSource.current.closed, 1);
  assert.equal(calls.filter(c => c.url.endsWith("/stop")).length, 1);
});

test("recovery uses owned server records, orders and deduplicates events, and verifies deletion acknowledgement", async (t) => {
  fixtures(t);
  const calls: Array<{ url: string; method?: string }> = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    if (init?.method === "DELETE") return Response.json({ sessionId: "owned-session", deleted: true });
    return Response.json({ sessionId: "owned-session", saved: true, status: "stopped", captureGap: "No raw audio retained.", events: [
      { sequence: 2, text: "second", source: "microphone" }, { sequence: 1, text: "first", source: "microphone" },
      { sequence: 2, text: "duplicate", source: "microphone" },
    ] });
  } });
  const saved = await loadSavedTranscriptSession("owned-session");
  assert.deepEqual(saved.events.map(e => e.text), ["first", "second"]);
  await deleteSavedTranscriptSession("owned-session");
  assert.equal(calls.at(-1)?.method, "DELETE");
  await assert.rejects(loadSavedTranscriptSession("../other"), /identifier/);
});

test("cross-account recovery/deletion denial never falls back to another account's local record", async (t) => {
  fixtures(t);
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({ error: { code: "session_unavailable" } }, { status: 404 }) });
  await assert.rejects(loadSavedTranscriptSession("owned-session"), /unavailable for this signed-in account/);
  await assert.rejects(deleteSavedTranscriptSession("owned-session"), /did not acknowledge deletion/);
});

test("upload queue bounds concurrent count and individual bytes, then stop aborts all pending work", async (t) => {
  const calls = fixtures(t);
  const client = await createStreamingTranscriptClient();
  const pending = Array.from({ length: 6 }, (_, index) => client.sendChunk(params(index)).catch(error => error));
  await assert.rejects(client.sendChunk(params(6)), /queue is full/);
  await assert.rejects(client.sendChunk({ ...params(7), blob: new Blob([new Uint8Array(1024 * 1024 + 1)]) }), /queue is full/);
  assert.equal(calls.filter(call => call.url.endsWith("/chunk")).length, 6);
  await client.stop();
  const results = await Promise.all(pending);
  assert.ok(results.every(value => value instanceof Error));
});

test("account session discovery works without a remembered browser cursor and bounds metadata to recent100", async (t) => {
  fixtures(t); let requested = "";
  const row = { sessionId: "owned-session", status: "ended", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T01:00:00Z" };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
    requested = url; return Response.json({ sessions: [row, row, { ...row, sessionId: "another-owned-session", status: "active" }], limit: 100 });
  } });
  const sessions = await listOwnedTranscriptSessions();
  assert.equal(requested, "/api/transcribe/stream/session");
  assert.deepEqual(sessions.map(session => session.sessionId), ["owned-session", "another-owned-session"]);
});

test("denied account session discovery returns no browser-local substitute", async (t) => {
  fixtures(t);
  for (const status of [401, 403, 503]) {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({ error: { code: "unavailable" } }, { status }) });
    await assert.rejects(listOwnedTranscriptSessions(), /no local history was substituted/);
  }
});

test("malformed, oversized and over-count session lists are rejected instead of becoming selectable IDs", async (t) => {
  fixtures(t);
  const row = { sessionId: "owned-session", status: "active", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T01:00:00Z" };
  for (const payload of [{ sessions: [{ ...row, sessionId: "../another-account" }], limit: 100 }, { sessions: Array.from({ length: 101 }, () => row), limit: 100 }]) {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json(payload) });
    await assert.rejects(listOwnedTranscriptSessions(), /metadata was invalid/);
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => new Response("x".repeat(65_537)) });
  await assert.rejects(listOwnedTranscriptSessions(), /exceeded the browser limit/);
});
