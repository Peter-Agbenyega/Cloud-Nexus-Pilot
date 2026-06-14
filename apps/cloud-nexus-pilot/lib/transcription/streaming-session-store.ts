import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";
import {
  isDeepgramTranscriptionConfigured,
  transcribeWithDeepgram,
} from "@/lib/transcription/deepgram-transcribe";
import { transcribeWithOpenAi } from "@/lib/transcription/openai-transcribe";
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

export function createStreamingSession() {
  const id = crypto.randomUUID();
  const now = Date.now();
  const session: StreamingSession = {
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

export function getStreamingSession(sessionId: string): StreamingSession | null {
  return getStore().sessions.get(sessionId) ?? null;
}

export function stopStreamingSession(sessionId: string): boolean {
  const session = getStreamingSession(sessionId);
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
  listener: SessionListener
): (() => void) | null {
  const session = getStreamingSession(sessionId);
  if (!session || session.stopped) return null;

  session.listeners.add(listener);
  emit(session, { type: "status", sessionId, status: "active" });
  return () => {
    session.listeners.delete(listener);
  };
}

export async function processStreamingSessionChunk(params: {
  sessionId: string;
  chunkIndex: number;
  source: TranscriptSource;
  contentType: string;
  arrayBuffer: ArrayBuffer;
}): Promise<{ ok: true } | { ok: false; code: string; message: string; detail?: string }> {
  const session = getStreamingSession(params.sessionId);
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
    const detail =
      error instanceof Error && "detail" in error && typeof error.detail === "string"
        ? error.detail
        : "";
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "transcript_processing_failed";
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Streaming transcription failed for the latest chunk.";

    emit(session, {
      type: "chunk-error",
      sessionId: session.id,
      chunkIndex: params.chunkIndex,
      error: {
        code,
        message,
        detail: detail || undefined,
      },
    });
    console.warn("[transcription][stream-session] chunk-process-error", {
      sessionId: session.id,
      chunkIndex: params.chunkIndex,
      code,
      message,
      detail,
    });
    return {
      ok: false,
      code,
      message,
      detail: detail || undefined,
    };
  }
}
