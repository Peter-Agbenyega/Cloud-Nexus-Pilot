import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";

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
  abort: AbortController;
  promise: Promise<TranscriptionResponse>;
  source: TranscriptSource;
  bytes: number;
  response?: TranscriptionResponse;
  error?: Error;
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
    | "sse-reconnecting"
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
  onSaveAcknowledged?: (sessionId: string) => void;
  connectTimeoutMs?: number;
  chunkTimeoutMs?: number;
}): Promise<StreamingTranscriptClient> {
  const connectTimeoutMs = options?.connectTimeoutMs ?? 3_000;
  const chunkTimeoutMs = options?.chunkTimeoutMs ?? 15_000;
  const createAbort = new AbortController();
  const createTimer = window.setTimeout(() => createAbort.abort(), connectTimeoutMs);
  options?.onLog?.({ event: "session-create-attempt" });
  let sessionId: string;
  try {
    const response = await fetch("/api/transcribe/stream/session", { method: "POST", signal: createAbort.signal });
    if (!response.ok) throw new Error("Unable to create streaming transcription session.");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("sessionId" in body) ||
        typeof body.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.sessionId)) {
      throw new Error("The session service returned an invalid session identifier.");
    }
    sessionId = body.sessionId;
  } finally { window.clearTimeout(createTimer); }
  options?.onLog?.({ event: "session-create-success", sessionId });
  const sessionPath = `/api/transcribe/stream/session/${encodeURIComponent(sessionId)}`;
  const pendingChunks = new Map<number, ChunkResolver>();
  const deliveryOrder: number[] = [];
  const completed = new Map<number, TranscriptionResponse>();
  let eventSource: EventSource;
  try { eventSource = new EventSource(`${sessionPath}/events`); } catch (error) {
    await fetch(`${sessionPath}/stop`, { method: "POST", signal: AbortSignal.timeout(connectTimeoutMs) }).catch(() => undefined);
    throw error;
  }
  let isStopped = false;
  let stopPromise: Promise<void> | undefined;
  let openSettled = false;
  let resolveOpen: () => void;
  let rejectOpen: (error: Error) => void;
  const waitForOpen = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const openTimer = window.setTimeout(() => {
    if (openSettled) return;
    openSettled = true;
    rejectOpen(new Error("Streaming transcript event channel did not connect in time."));
  }, connectTimeoutMs);

  // Deliver final chunks in upload order even if the provider/SSE completes out of order.
  const drain = () => {
    while (deliveryOrder.length) {
      const index = deliveryOrder[0]!;
      const item = pendingChunks.get(index);
      if (!item || (!item.response && !item.error)) return;
      deliveryOrder.shift();
      pendingChunks.delete(index);
      window.clearTimeout(item.timeoutId);
      if (item.error) item.reject(item.error);
      else if (item.response) {
        completed.set(index, item.response);
        if (completed.size > 128) completed.delete(completed.keys().next().value!);
        item.resolve(item.response);
        try { options?.onTranscript?.(item.response); } catch {
          options?.onLog?.({ event: "chunk-reject", sessionId, chunkIndex: index, detail: "Transcript display callback failed." });
        }
      }
    }
  };
  const rejectChunk = (index: number, error: Error) => {
    const pending = pendingChunks.get(index);
    if (!pending || pending.response || pending.error) return;
    pending.error = error;
    pending.abort.abort();
    window.clearTimeout(pending.timeoutId);
    drain();
  };
  const rejectAll = (error: Error) => {
    for (const index of [...pendingChunks.keys()]) rejectChunk(index, error);
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    isStopped = true;
    if (!openSettled) {
      openSettled = true;
      rejectOpen(new Error("Streaming transcription session was stopped."));
    }
    window.clearTimeout(openTimer);
    eventSource.close();
    rejectAll(new Error("Streaming transcription session was stopped."));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), connectTimeoutMs);
    stopPromise = fetch(`${sessionPath}/stop`, { method: "POST", signal: controller.signal })
      .then(() => undefined, () => undefined).finally(() => window.clearTimeout(timer));
    return stopPromise;
  };
  eventSource.onopen = () => {
    if (isStopped) return;
    if (!openSettled) {
      openSettled = true;
      window.clearTimeout(openTimer);
      resolveOpen();
    }
    options?.onLog?.({ event: "sse-connect-open", sessionId });
  };
  eventSource.onerror = () => {
    if (isStopped) return;
    const alreadyOpened = openSettled;
    const error = new Error(alreadyOpened
      ? "Streaming transcript event channel disconnected; retained results remain available."
      : "Streaming transcript event channel failed before connecting.");
    if (!openSettled) {
      openSettled = true;
      window.clearTimeout(openTimer);
      rejectOpen(error);
    }
    // EventSource reconnects with its retained event cursor. The bounded HTTP
    // acknowledgement can still complete uploads while the event channel recovers.
    options?.onLog?.({ event: alreadyOpened ? "sse-reconnecting" : "sse-connect-error", sessionId, detail: error.message });
  };
  eventSource.onmessage = (message) => {
    if (isStopped || !message.data) return;
    let payload: StreamEventPayload;
    try { payload = JSON.parse(message.data) as StreamEventPayload; } catch { return; }
    if (!payload || typeof payload !== "object" || payload.sessionId !== sessionId ||
        !("chunkIndex" in payload) || !Number.isSafeInteger(payload.chunkIndex) || payload.chunkIndex < 0) return;
    const item = pendingChunks.get(payload.chunkIndex);
    if (!item || item.response || item.error) return;
    if (payload.type === "chunk-result") {
      const response = payload.response;
      if (!response || typeof response.text !== "string" || response.text.length > 100_000 ||
          response.chunkIndex !== payload.chunkIndex || response.source !== item.source ||
          typeof response.contentType !== "string") return;
      item.response = response;
      window.clearTimeout(item.timeoutId);
      drain();
    } else if (payload.type === "chunk-error") {
      rejectChunk(payload.chunkIndex, new Error(typeof payload.error?.message === "string"
        ? payload.error.message.slice(0, 500) : "Streaming transcription failed."));
    }
  };
  try { await waitForOpen; } catch (error) { await stop(); throw error; }
  return {
    sessionId,
    sendChunk(params) {
      if (isStopped) return Promise.reject(new Error("Streaming transcription session was stopped."));
      if (!Number.isSafeInteger(params.chunkIndex) || params.chunkIndex < 0 || params.blob.size === 0) {
        return Promise.reject(new Error("Audio chunks require a valid index and nonempty audio."));
      }
      const existing = pendingChunks.get(params.chunkIndex);
      if (existing) return existing.promise;
      const prior = completed.get(params.chunkIndex);
      if (prior) return Promise.resolve(prior);
      const queuedBytes = [...pendingChunks.values()].reduce((sum, item) => sum + item.bytes, 0);
      if (pendingChunks.size >= 6 || params.blob.size > 1024 * 1024 || queuedBytes + params.blob.size > 4 * 1024 * 1024) {
        return Promise.reject(new Error("Audio upload queue is full. Pause capture and retry."));
      }
      const abort = new AbortController();
      let resolve!: (value: TranscriptionResponse) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<TranscriptionResponse>((ok, fail) => { resolve = ok; reject = fail; });
      const timeoutId = window.setTimeout(() => {
        rejectChunk(params.chunkIndex, new Error("Timed out waiting for transcription. This audio may not have been saved."));
      }, chunkTimeoutMs);
      pendingChunks.set(params.chunkIndex, { resolve, reject, timeoutId, abort, promise, source: params.source, bytes: params.blob.size });
      deliveryOrder.push(params.chunkIndex);
      void fetch(`${sessionPath}/chunk`, {
        method: "POST",
        headers: { "Content-Type": params.contentType, "X-Chunk-Index": String(params.chunkIndex), "X-Transcript-Source": params.source },
        body: params.blob,
        signal: abort.signal,
      }).then(async (response) => {
        if (!response.ok) {
          let message = "Unable to process the latest audio chunk.";
          try {
            const body = await response.json() as { error?: { message?: string } };
            if (typeof body.error?.message === "string") message = body.error.message.slice(0, 500);
          } catch { /* Keep the stable error if a gateway returns non-JSON. */ }
          rejectChunk(params.chunkIndex, new Error(message));
          return;
        }
        // A durable HTTP acknowledgement is sufficient even if SSE reconnects.
        // Older servers return no response; their validated SSE event still resolves.
        try {
          const body = await response.json() as { response?: TranscriptionResponse; saved?: boolean };
          const result = body.response;
          if (body.saved === true && result && typeof result.text === "string" &&
              result.text.length <= 100_000 && result.chunkIndex === params.chunkIndex &&
              result.source === params.source && typeof result.contentType === "string") {
            try { options?.onSaveAcknowledged?.(sessionId); } catch { /* Saving is acknowledged independently of display callbacks. */ }
            const item = pendingChunks.get(params.chunkIndex);
            if (item && !item.response && !item.error) {
              item.response = result;
              window.clearTimeout(item.timeoutId);
              drain();
            }
          }
        } catch { /* Legacy acceptance without a result waits for bounded SSE. */ }
      }).catch((error: unknown) => rejectChunk(params.chunkIndex, new Error(toErrorMessage(error, "Audio upload failed."))));
      return promise;
    },
    stop,
  };
}
