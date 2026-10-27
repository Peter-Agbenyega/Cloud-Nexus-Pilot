import type { SavedTranscriptSession } from "./saved-session-service";

function sessionPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid session identifier.");
  return `/api/transcribe/stream/session/${encodeURIComponent(sessionId)}`;
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("The session service returned no data.");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("The saved session exceeds the browser response limit.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session response.");
    return value as Record<string, unknown>;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Called only by an explicit Generate action; identity is verified by the existing server routes. */
export async function ensureOwnedGuidanceSession(existingId?: string | null, parentSignal?: AbortSignal): Promise<string> {
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
  signal.throwIfAborted();
  if (existingId) {
    const prior = await fetch(sessionPath(existingId), { cache: "no-store", signal });
    if (prior.ok) {
      const value = await responseObject(prior);
      if (value.sessionId !== existingId || value.saved !== true) throw new Error("The server could not verify this owned session.");
      if (value.status === "active") return existingId;
    } else if (prior.status !== 404) {
      await prior.body?.cancel().catch(() => {});
      throw new Error("Sign in to an ordinary account with available session storage before generating guidance.");
    } else { await prior.body?.cancel().catch(() => {}); }
  }
  signal.throwIfAborted();
  const response = await fetch("/api/transcribe/stream/session", { method: "POST", signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error("An authenticated owned session could not be created. Guidance was not requested.");
  }
  const value = await responseObject(response);
  if (typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId) || value.saved !== true) {
    throw new Error("The server did not acknowledge the owned session.");
  }
  return value.sessionId;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function buildGuidanceAssociation(question: string, segments: ReadonlyArray<{ id: string; text: string; source: string; chunkIndex: number }>) {
  const normalized = question.trim().slice(0, 500);
  const [questionHash, revision] = await Promise.all([
    digest(normalized),
    digest(JSON.stringify(segments.slice(-8).map(segment => ({ id: segment.id, text: segment.text.slice(-1200), source: segment.source, chunkIndex: segment.chunkIndex })))),
  ]);
  return { question: normalized, questionId: `question:${questionHash}`, transcriptRevision: `transcript:${revision}` };
}

export type SavedGuidanceAssociation = {
  operationId: string; createdAt: string; question: string; questionId: string | null; transcriptRevision: string | null;
  headline: string; speakNow: string; keyPoints: string[]; fullAnswer: string;
};
export function savedGuidanceAssociations(session: Pick<SavedTranscriptSession, "guidance">): SavedGuidanceAssociation[] {
  return (session.guidance ?? []).flatMap((raw): SavedGuidanceAssociation[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (item.state !== "succeeded" || typeof item.operation_id !== "string" || !item.result || typeof item.result !== "object") return [];
    const result = item.result as Record<string, unknown>;
    const speak = typeof result.speakNow === "string" ? result.speakNow : result.gist;
    if (typeof speak !== "string" || typeof result.full_answer !== "string") return [];
    const points = Array.isArray(result.keyPoints) ? result.keyPoints : result.key_points;
    return [{ operationId: item.operation_id, createdAt: typeof item.created_at === "string" ? item.created_at : "",
      question: typeof result.question === "string" ? result.question.slice(0, 500) : "Question details were not retained for this earlier turn.",
      questionId: typeof result.questionId === "string" ? result.questionId : null,
      transcriptRevision: typeof result.transcriptRevision === "string" ? result.transcriptRevision : null,
      headline: typeof result.headline === "string" ? result.headline.slice(0, 120) : "Saved guidance",
      speakNow: speak.slice(0, 3000), keyPoints: Array.isArray(points) ? points.filter((point): point is string => typeof point === "string").slice(0, 5).map(point => point.slice(0, 300)) : [],
      fullAnswer: result.full_answer.slice(0, 12_000) }];
  });
}

/** Consume only a bounded, completed final payload; abandoned streams always release their reader. */
export async function readFinalGuidance(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Guidance is unavailable right now.");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", final = "", bytes = 0, receivedDone = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!receivedDone) {
      signal.throwIfAborted();
      const part = await reader.read(); signal.throwIfAborted();
      bytes += part.value?.byteLength ?? 0;
      if (bytes > 262_144) throw new Error("Guidance response exceeded its limit.");
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const text = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        if (text) {
          const payload = JSON.parse(text) as Record<string, unknown>;
          if (payload.type === "error") throw new Error(typeof payload.message === "string" ? payload.message.slice(0, 500) : "Guidance failed.");
          if (payload.type === "final" && typeof payload.content === "string") {
            if (payload.content.length > 32_768) throw new Error("Guidance response exceeded its limit.");
            final = payload.content;
          }
          if (payload.type === "done") receivedDone = true;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > 65_536) throw new Error("Guidance event exceeded its limit.");
      if (part.done && !receivedDone) throw new Error("Guidance ended before completion. Reload saved work before retrying.");
    }
    if (!final.trim()) throw new Error("Guidance returned no completed answer.");
    return final;
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function requestOwnedGuidance(input: {
  question: string;
  segments: ReadonlyArray<{ id: string; text: string; source: string; chunkIndex: number }>;
  body: Record<string, unknown>;
  ensureSession: (signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
}): Promise<{ sessionId: string; response: Response; signal: AbortSignal }> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const sessionId = await input.ensureSession(signal);
  const association = await buildGuidanceAssociation(input.question, input.segments);
  signal.throwIfAborted();
  const response = await fetch("/api/generate-guidance", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ ...input.body, ...association, sessionId }), signal,
  });
  return { sessionId, response, signal };
}
