import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";
import { toPublicTranscriptionError } from "./public-error";
const shouldDebugLogs = process.env.NODE_ENV !== "production";

type SessionEvent =
  | { type: "status"; sessionId: string; status: "created" | "active" | "stopped" }
  | {
      type: "chunk-result";
      sessionId: string;
      chunkIndex: number;
      response: TranscriptionResponse;
    }
  | {
      type: "chunk-error";
      sessionId: string;
      chunkIndex: number;
      error: { code: string; message: string; detail?: string };
    };

type SessionListener = (event: SessionEvent) => void;

type StreamingSession = {
  ownerId: string;
  id: string;
  createdAt: number;
  lastActivityAt: number;
  listeners: Set<SessionListener>;
  stopped: boolean;
};

const SESSION_TTL_MS = 10 * 60 * 1000;

type SessionStore = {
  sessions: Map<string, StreamingSession>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
};

declare global {
  var __cloudNexusStreamingStore: SessionStore | undefined;
}

function getStore(): SessionStore {
  if (!globalThis.__cloudNexusStreamingStore) {
    globalThis.__cloudNexusStreamingStore = {
      sessions: new Map(),
      cleanupInterval: null,
    };
  }

  if (!globalThis.__cloudNexusStreamingStore.cleanupInterval) {
    globalThis.__cloudNexusStreamingStore.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of globalThis.__cloudNexusStreamingStore?.sessions ?? []) {
        if (now - session.lastActivityAt > SESSION_TTL_MS) {
          session.stopped = true;
          session.listeners.clear();
          globalThis.__cloudNexusStreamingStore?.sessions.delete(id);
        }
      }
    }, 60_000);
  }

  return globalThis.__cloudNexusStreamingStore;
}

function emit(session: StreamingSession, event: SessionEvent) {
  if (shouldDebugLogs) {
    console.info("[transcription][stream-session] event-publish", {
      sessionId: session.id,
      type: event.type,
      chunkIndex: "chunkIndex" in event ? event.chunkIndex : undefined,
      listeners: session.listeners.size,
    });
  }
  for (const listener of session.listeners) {
    listener(event);
  }
}

export function createStreamingSession(ownerId: string) {
  if (!ownerId) throw new Error("A session owner is required.");
  const id = crypto.randomUUID();
  const now = Date.now();
  const session: StreamingSession = {
    ownerId,
    id,
    createdAt: now,
    lastActivityAt: now,
    listeners: new Set(),
    stopped: false,
  };

  getStore().sessions.set(id, session);
  emit(session, { type: "status", sessionId: id, status: "created" });
  return session;
}

export function getStreamingSession(sessionId: string, ownerId: string): StreamingSession | null {
  const session = getStore().sessions.get(sessionId);
  return ownerId && session?.ownerId === ownerId ? session : null;
}

export function stopStreamingSession(sessionId: string, ownerId: string): boolean {
  const session = getStreamingSession(sessionId, ownerId);
  if (!session) return false;
  session.stopped = true;
  session.lastActivityAt = Date.now();
  emit(session, { type: "status", sessionId, status: "stopped" });
  session.listeners.clear();
  getStore().sessions.delete(sessionId);
  return true;
}

export function subscribeToStreamingSession(
  sessionId: string,
  ownerId: string,
  listener: SessionListener
): (() => void) | null {
  const session = getStreamingSession(sessionId, ownerId);
  if (!session || session.stopped) return null;

  session.listeners.add(listener);
  emit(session, { type: "status", sessionId, status: "active" });
  return () => {
    session.listeners.delete(listener);
  };
}

export async function processStreamingSessionChunk(params: {
  ownerId: string;
  sessionId: string;
  chunkIndex: number;
  source: TranscriptSource;
  contentType: string;
  arrayBuffer: ArrayBuffer;
}): Promise<{ ok: true } | { ok: false; code: string; message: string; detail?: string }> {
  const session = getStreamingSession(params.sessionId, params.ownerId);
  if (!session || session.stopped) {
    return {
      ok: false,
      code: "transcript_stream_session_missing",
      message: "Streaming transcription session is unavailable or already stopped.",
    };
  }

  session.lastActivityAt = Date.now();
  if (shouldDebugLogs) {
    console.info("[transcription][stream-session] chunk-process-start", {
      sessionId: session.id,
      chunkIndex: params.chunkIndex,
      bytes: params.arrayBuffer.byteLength,
      contentType: params.contentType,
      source: params.source,
    });
  }

  try {
    const { isDeepgramTranscriptionConfigured, transcribeWithDeepgram } = await import("@/lib/transcription/deepgram-transcribe");
    const { transcribeWithOpenAi } = await import("@/lib/transcription/openai-transcribe");
    const transcribe = isDeepgramTranscriptionConfigured()
      ? transcribeWithDeepgram
      : transcribeWithOpenAi;
    const response = await transcribe({
      arrayBuffer: params.arrayBuffer,
      requestContentType: params.contentType,
      chunkIndexHeader: String(params.chunkIndex),
      sourceHeader: params.source,
    });
    emit(session, {
      type: "chunk-result",
      sessionId: session.id,
      chunkIndex: params.chunkIndex,
      response,
    });
    if (shouldDebugLogs) {
      console.info("[transcription][stream-session] chunk-process-success", {
        sessionId: session.id,
        chunkIndex: params.chunkIndex,
        textLength: response.text.length,
        hasText: Boolean(response.text.trim()),
      });
    }
    return { ok: true };
  } catch (error) {
    const { status, error: publicError } = toPublicTranscriptionError(error);

    emit(session, {
      type: "chunk-error",
      sessionId: session.id,
      chunkIndex: params.chunkIndex,
      error: publicError,
    });
    console.warn("[transcription][stream-session] chunk-process-error", {
      sessionId: session.id,
      chunkIndex: params.chunkIndex,
      code: publicError.code,
      status,
    });
    return {
      ok: false,
      ...publicError,
    };
  }
}
