import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";
const shouldDebugLogs = process.env.NODE_ENV !== "production";

type StreamEventPayload =
  | { type: "status"; status: string; sessionId: string }
  | { type: "chunk-result"; sessionId: string; chunkIndex: number; response: TranscriptionResponse }
  | {
      type: "chunk-error";
      sessionId: string;
      chunkIndex: number;
      error: { code: string; message: string; detail?: string };
    };

type ChunkResolver = {
  resolve: (value: TranscriptionResponse) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

export type StreamingTranscriptClient = {
  sessionId: string;
  sendChunk: (params: {
    chunkIndex: number;
    source: TranscriptSource;
    contentType: string;
    blob: Blob;
  }) => Promise<TranscriptionResponse>;
  stop: () => Promise<void>;
};

type StreamingClientLog = {
  event:
    | "session-create-attempt"
    | "session-create-success"
    | "session-create-failed"
    | "sse-connect-attempt"
    | "sse-connect-open"
    | "sse-connect-error"
    | "chunk-ingest-attempt"
    | "chunk-ingest-success"
    | "chunk-ingest-failed"
    | "chunk-ingest-timeout"
    | "chunk-resolve"
    | "chunk-reject"
    | "sse-event-received"
    | "session-stop";
  detail?: string;
  sessionId?: string;
  chunkIndex?: number;
  status?: number;
};

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export async function createStreamingTranscriptClient(options?: {
  onLog?: (entry: StreamingClientLog) => void;
  onTranscript?: (response: TranscriptionResponse) => void;
  connectTimeoutMs?: number;
  chunkTimeoutMs?: number;
}): Promise<StreamingTranscriptClient> {
  options?.onLog?.({ event: "session-create-attempt" });
  const createResponse = await fetch("/api/transcribe/stream/session", {
    method: "POST",
  });

  if (!createResponse.ok) {
    options?.onLog?.({
      event: "session-create-failed",
      status: createResponse.status,
      detail: "Streaming session create route returned a non-OK response.",
    });
    throw new Error("Unable to create streaming transcription session.");
  }

  const createPayload = (await createResponse.json()) as {
    sessionId: string;
  };
  const sessionId = createPayload.sessionId;
  options?.onLog?.({ event: "session-create-success", sessionId });

  const pendingChunks = new Map<number, ChunkResolver>();
  options?.onLog?.({ event: "sse-connect-attempt", sessionId });
  const eventSource = new EventSource(`/api/transcribe/stream/session/${sessionId}/events`);
  const connectTimeoutMs = options?.connectTimeoutMs ?? 3_000;
  const chunkTimeoutMs = options?.chunkTimeoutMs ?? 15_000;
  let isStopped = false;

  const clearPendingChunk = (chunkIndex: number) => {
    const pending = pendingChunks.get(chunkIndex);
    if (!pending) return null;
    window.clearTimeout(pending.timeoutId);
    pendingChunks.delete(chunkIndex);
    return pending;
  };

  const resolvePendingChunk = (chunkIndex: number, response: TranscriptionResponse) => {
    const pending = clearPendingChunk(chunkIndex);
    if (!pending) return;
    options?.onLog?.({
      event: "chunk-resolve",
      sessionId,
      chunkIndex,
      detail: "Chunk result promise resolved from SSE event.",
    });
    if (shouldDebugLogs) {
      console.log("[transcription][streaming] chunk-result-resolved", {
        sessionId,
        chunkIndex,
        textLength: response.text.length,
        hasText: Boolean(response.text.trim()),
      });
    }
    pending.resolve(response);
    options?.onTranscript?.(response);
  };

  const rejectPendingChunk = (
    chunkIndex: number,
    reason: Error,
    event: "chunk-reject" | "chunk-ingest-timeout"
  ) => {
    const pending = clearPendingChunk(chunkIndex);
    if (!pending) return;
    options?.onLog?.({
      event,
      sessionId,
      chunkIndex,
      detail: reason.message,
    });
    console.warn("[transcription][streaming] chunk-result-rejected", {
      sessionId,
      chunkIndex,
      reason: reason.message,
      event,
    });
    pending.reject(reason);
  };

  const rejectAllPendingChunks = (reason: Error) => {
    for (const chunkIndex of [...pendingChunks.keys()]) {
      rejectPendingChunk(chunkIndex, reason, "chunk-reject");
    }
  };

  const waitForOpen = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      options?.onLog?.({
        event: "sse-connect-error",
        sessionId,
        detail: `Timed out waiting for SSE open after ${connectTimeoutMs}ms.`,
      });
      reject(new Error("Streaming transcript event channel did not connect in time."));
    }, connectTimeoutMs);

    eventSource.onopen = () => {
      window.clearTimeout(timeout);
      options?.onLog?.({ event: "sse-connect-open", sessionId });
      resolve();
    };

    eventSource.onerror = () => {
      window.clearTimeout(timeout);
      options?.onLog?.({
        event: "sse-connect-error",
        sessionId,
        detail: "EventSource emitted an error before the stream opened.",
      });
      reject(new Error("Streaming transcript event channel failed before connecting."));
    };
  });

  eventSource.onmessage = (message) => {
    if (!message.data) return;
    const payload = JSON.parse(message.data) as StreamEventPayload;
    options?.onLog?.({
      event: "sse-event-received",
      sessionId,
      chunkIndex: "chunkIndex" in payload ? payload.chunkIndex : undefined,
      detail: `SSE event received: ${payload.type}`,
    });
    if (shouldDebugLogs) {
      console.log("[transcription][streaming] sse-event-received", {
        sessionId,
        type: payload.type,
        chunkIndex: "chunkIndex" in payload ? payload.chunkIndex : undefined,
        hasText:
          payload.type === "chunk-result"
            ? Boolean(payload.response.text?.trim())
            : undefined,
        textLength: payload.type === "chunk-result" ? payload.response.text.length : undefined,
      });
    }

    if (payload.type === "chunk-result") {
      resolvePendingChunk(payload.chunkIndex, payload.response);
      return;
    }

    if (payload.type === "chunk-error") {
      rejectPendingChunk(
        payload.chunkIndex,
        new Error(
          [payload.error.code, payload.error.message, payload.error.detail || ""]
            .filter(Boolean)
            .join(": ")
        ),
        "chunk-reject"
      );
    }
  };

  eventSource.onerror = () => {
    if (isStopped) return;
    options?.onLog?.({
      event: "sse-connect-error",
      sessionId,
      detail: "EventSource emitted an error.",
    });
    rejectAllPendingChunks(new Error("Streaming transcript event channel disconnected."));
  };

  try {
    await waitForOpen;
  } catch (error) {
    eventSource.close();
    throw error;
  }

  return {
    sessionId,
    async sendChunk(params) {
      options?.onLog?.({
        event: "chunk-ingest-attempt",
        sessionId,
        chunkIndex: params.chunkIndex,
      });
      if (shouldDebugLogs) {
        console.log("[transcription][streaming] chunk-send-attempt", {
          sessionId,
          chunkIndex: params.chunkIndex,
          contentType: params.contentType,
          bytes: params.blob.size,
          source: params.source,
        });
      }
      const pending = new Promise<TranscriptionResponse>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          const timeoutError = new Error(
            `Timed out waiting ${chunkTimeoutMs}ms for streaming chunk result ${params.chunkIndex}.`
          );
          options?.onLog?.({
            event: "chunk-ingest-timeout",
            sessionId,
            chunkIndex: params.chunkIndex,
            detail: timeoutError.message,
          });
          console.error("[transcription][streaming] chunk-send-timeout", {
            sessionId,
            chunkIndex: params.chunkIndex,
            timeoutMs: chunkTimeoutMs,
          });
          rejectPendingChunk(params.chunkIndex, timeoutError, "chunk-ingest-timeout");
        }, chunkTimeoutMs);

        pendingChunks.set(params.chunkIndex, {
          resolve,
          reject,
          timeoutId,
        });
      });

      void fetch(`/api/transcribe/stream/session/${sessionId}/chunk`, {
        method: "POST",
        headers: {
          "Content-Type": params.contentType,
          "X-Chunk-Index": String(params.chunkIndex),
          "X-Transcript-Source": params.source,
        },
        body: params.blob,
      })
        .then(async (response) => {
          if (!response.ok) {
            const fallback = "Unable to send audio chunk to streaming transcription session.";
            try {
              const body = (await response.json()) as {
                error?: { code?: string; message?: string; detail?: string };
              };
              const errorCode = body.error?.code || "unknown_error";
              const errorMessage = body.error?.message || fallback;
              const errorDetail = body.error?.detail || "";
              options?.onLog?.({
                event: "chunk-ingest-failed",
                sessionId,
                chunkIndex: params.chunkIndex,
                status: response.status,
                detail: [errorCode, errorMessage, errorDetail].filter(Boolean).join(": "),
              });
              console.error("[transcription][streaming] chunk-ingest-failed", {
                sessionId,
                chunkIndex: params.chunkIndex,
                status: response.status,
                errorCode,
                errorMessage,
                errorDetail,
                bytes: params.blob.size,
                contentType: params.contentType,
              });
              rejectPendingChunk(
                params.chunkIndex,
                new Error([errorCode, errorMessage, errorDetail].filter(Boolean).join(": ")),
                "chunk-reject"
              );
            } catch (error) {
              const msg = toErrorMessage(error, fallback);
              options?.onLog?.({
                event: "chunk-ingest-failed",
                sessionId,
                chunkIndex: params.chunkIndex,
                status: response.status,
                detail: msg,
              });
              console.error("[transcription][streaming] chunk-ingest-failed (body-parse-error)", {
                sessionId,
                chunkIndex: params.chunkIndex,
                status: response.status,
                parseError: msg,
                bytes: params.blob.size,
                contentType: params.contentType,
              });
              rejectPendingChunk(
                params.chunkIndex,
                new Error(msg),
                "chunk-reject"
              );
            }
            return;
          }

          options?.onLog?.({
            event: "chunk-ingest-success",
            sessionId,
            chunkIndex: params.chunkIndex,
            status: response.status,
          });
          if (shouldDebugLogs) {
            console.log("[transcription][streaming] chunk-send-success", {
              sessionId,
              chunkIndex: params.chunkIndex,
              status: response.status,
            });
          }
        })
        .catch((error) => {
          const message = toErrorMessage(
            error,
            "Unable to send audio chunk to streaming transcription session."
          );
          rejectPendingChunk(params.chunkIndex, new Error(message), "chunk-reject");
        });

      return pending;
    },
    async stop() {
      isStopped = true;
      options?.onLog?.({ event: "session-stop", sessionId });
      eventSource.close();
      rejectAllPendingChunks(new Error("Streaming transcription session was stopped."));

      await fetch(`/api/transcribe/stream/session/${sessionId}/stop`, {
        method: "POST",
      }).catch(() => undefined);
    },
  };
}
