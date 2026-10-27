export type SavedTranscriptEvent = { id?: string; sequence: number; text: string; source: "microphone" | "system-audio"; provider_result?: { chunkIndex?: number }; captured_at?: string };
export type SavedTranscriptSession = { sessionId: string; status: string; saved: true; events: SavedTranscriptEvent[]; guidance?: unknown[]; captureGap: string; audioRetained?: boolean; hasMore?: boolean; nextCursor?: number };

function pathFor(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("The saved session identifier is invalid.");
  return `/api/transcribe/stream/session/${encodeURIComponent(sessionId)}`;
}

export async function loadSavedTranscriptSession(sessionId: string): Promise<SavedTranscriptSession> {
  const response = await fetch(pathFor(sessionId), { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("Saved session is unavailable for this signed-in account. Sign in to its owner account or choose another session.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Saved session returned no data.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) { void reader.cancel(); throw new Error("Saved session is too large for browser recovery. Use the bounded server export."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder().decode(combined)) as SavedTranscriptSession;
  if (value.sessionId !== sessionId || value.saved !== true || !Array.isArray(value.events) || value.events.length > 1000) {
    throw new Error("Saved session returned an invalid response.");
  }
  if (value.hasMore) throw new Error("This session exceeds the current recovery/export page limit. Saved work remains on the server; retrieve additional pages with nextCursor. No complete export was produced.");
  const seen = new Set<number>();
  value.events = value.events.filter((event) => {
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || seen.has(event.sequence) ||
        typeof event.text !== "string" || (event.source !== "microphone" && event.source !== "system-audio")) return false;
    seen.add(event.sequence);
    return true;
  }).sort((a, b) => a.sequence - b.sequence);
  return value;
}

export async function deleteSavedTranscriptSession(sessionId: string): Promise<void> {
  const response = await fetch(pathFor(sessionId), { method: "DELETE", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("The server did not acknowledge deletion. Saved data may still exist.");
  const payload = await response.json() as { deleted?: boolean; sessionId?: string };
  if (payload.deleted !== true || payload.sessionId !== sessionId) throw new Error("The server did not acknowledge deletion.");
}

export type OwnedTranscriptSessionSummary = { sessionId: string; status: string; createdAt: string; updatedAt: string };

/** Metadata is discovered through authenticated account storage, never browser-local guesses. */
export async function listOwnedTranscriptSessions(signal?: AbortSignal): Promise<OwnedTranscriptSessionSummary[]> {
  const response = await fetch("/api/transcribe/stream/session", {
    cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Saved sessions could not be listed for this signed-in account. Sign in and retry; no local history was substituted.");
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65_536) throw new Error("Saved session metadata exceeded the browser limit.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const value = JSON.parse(text) as { sessions?: unknown; limit?: unknown };
  if (!value || value.limit !== 100 || !Array.isArray(value.sessions) || value.sessions.length > 100) throw new Error("Saved session metadata was invalid.");
  const seen = new Set<string>();
  const sessions: OwnedTranscriptSessionSummary[] = [];
  for (const row of value.sessions) {
    if (!row || typeof row !== "object" || typeof row.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.sessionId) ||
        typeof row.status !== "string" || row.status.length > 64 || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string" ||
        row.createdAt.length > 80 || row.updatedAt.length > 80 || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt))) {
      throw new Error("Saved session metadata was invalid.");
    }
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId); sessions.push({ sessionId: row.sessionId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt });
  }
  return sessions;
}
