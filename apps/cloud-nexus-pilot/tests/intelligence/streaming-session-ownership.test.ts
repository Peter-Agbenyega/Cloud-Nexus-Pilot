import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createStreamingSession, getStreamingSession, stopStreamingSession, subscribeToStreamingSession, processStreamingSessionChunk } from "../../lib/transcription/streaming-session-store";

after(() => {
  const store = globalThis.__cloudNexusStreamingStore;
  if (store?.cleanupInterval) clearInterval(store.cleanupInterval);
  globalThis.__cloudNexusStreamingStore = undefined;
});

test("a streaming session cannot be read, subscribed to or stopped by another account", () => {
  const session = createStreamingSession("owner-a");
  assert.equal(getStreamingSession(session.id, "owner-b"), null);
  assert.equal(subscribeToStreamingSession(session.id, "owner-b", () => {}), null);
  assert.equal(stopStreamingSession(session.id, "owner-b"), false);
  assert.equal(getStreamingSession(session.id, "owner-a")?.id, session.id);
  assert.equal(stopStreamingSession(session.id, "owner-a"), true);
  assert.equal(getStreamingSession(session.id, "owner-a"), null);
});

test("cross-account chunk ingest is rejected before provider invocation", async () => {
  const session = createStreamingSession("owner-a");
  const result = await processStreamingSessionChunk({ ownerId: "owner-b", sessionId: session.id, chunkIndex: 0, source: "microphone", contentType: "audio/webm", arrayBuffer: new ArrayBuffer(1) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "transcript_stream_session_missing");
  assert.equal(stopStreamingSession(session.id, "owner-a"), true);
});

test("empty owners cannot create or access streaming sessions", () => {
  assert.throws(() => createStreamingSession(""), /owner/);
  assert.equal(getStreamingSession("unknown", ""), null);
});
