import { acquireIngress } from "./ingress-admission";
import { toPublicTranscriptionError } from "../transcription/public-error";
import { createHash } from "node:crypto";
import type { ProviderAuthorization } from "./provider-auth-policy";
import { processingRepository } from "./processing-repository";
import { assertSameOrigin, boundaryResponse, processingScope, readBoundedBytes, RequestBoundaryError, validateAudio, withAbort } from "./request-boundary";
import type { TranscriptionResponse } from "../contracts/transcription";

export type Transcriber = (input: { arrayBuffer: ArrayBuffer; requestContentType: string; chunkIndexHeader: string | null; sourceHeader: string | null; signal: AbortSignal }) => Promise<TranscriptionResponse>;
export const MAX_AUDIO_BYTES = 2_000_000;

export function createProtectedTranscriptionHandler(dependencies: {
  authorize: (request?: Request) => Promise<ProviderAuthorization>;
  repository: typeof processingRepository;
  transcribe: Transcriber;
}) {
  return async (request: Request, sessionId?: string): Promise<Response> => {
    const auth = await dependencies.authorize(request);
    if (auth.response) return auth.response;
    const scope = processingScope(request.signal);
    let reservation: { operationId: string; requestHash: string; units: number } | undefined;
    let releaseIngress: (() => void) | undefined;
    let providerStarted = false;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertSameOrigin(request);
      if (sessionId) {
        const session = await dependencies.repository.read(auth, sessionId, 0, scope.signal);
        if (session.status !== "active") throw new RequestBoundaryError(409, "session_stopped", "This session is stopped.");
      }
      releaseIngress = acquireIngress(auth.userId);
      const contentType = request.headers.get("content-type") || "";
      let chunkHeader = request.headers.get("x-chunk-index") ?? "0";
      if (!/^\d{1,8}$/.test(chunkHeader)) throw new RequestBoundaryError(400, "invalid_chunk_index", "A valid chunk index is required.");
      chunkHeader = String(Number(chunkHeader));
      const source = request.headers.get("x-transcript-source") ?? "microphone";
      if (!["microphone", "system-audio"].includes(source)) throw new RequestBoundaryError(400, "invalid_audio_source", "Choose a supported audio source.");
      const bytes = await readBoundedBytes(request, MAX_AUDIO_BYTES);
      if (bytes.byteLength === 0) throw new RequestBoundaryError(400, "empty_payload", "Audio chunk is empty.");
      validateAudio(bytes, contentType);
      const hash = createHash("sha256").update(contentType).update(source).update(new Uint8Array(bytes)).digest("hex");
      const suppliedId = request.headers.get("x-request-id");
      if (suppliedId && !/^[A-Za-z0-9:_-]{1,128}$/.test(suppliedId)) throw new RequestBoundaryError(400, "invalid_operation_id", "Invalid operation identifier.");
      const operationId = sessionId ? `chunk:${sessionId}:${chunkHeader}` : suppliedId ?? `file:${hash}`;
      const held = await dependencies.repository.reserve(auth, { sessionId, operationId, requestHash: hash, maxUnits: bytes.byteLength, kind: "transcription" }, scope.signal);
      if (!held.acquired) {
        if (held.state === "succeeded") return Response.json(sessionId ? { ok: true, response: held.result, saved: true, replay: true } : held.result);
        if (["quota_exhausted", "concurrency_exceeded"].includes(held.state)) throw new RequestBoundaryError(429, "quota_exhausted", "Processing allowance or concurrency is exhausted.");
        throw new RequestBoundaryError(409, "operation_not_replayable", "This operation is pending, stopped or has an unknown outcome. Reload saved results before retrying.");
      }
      reservation = { operationId, requestHash: hash, units: bytes.byteLength };
      scope.signal.throwIfAborted();
      providerStarted = true;
      if (sessionId) {
        const watch = async () => {
          try {
            const current = await dependencies.repository.read(auth, sessionId, 0, scope.signal);
            if (current.status !== "active") scope.abort();
            else if (!scope.signal.aborted) watchTimer = setTimeout(() => void watch(), 2_000);
          } catch { scope.abort(); }
        };
        watchTimer = setTimeout(() => void watch(), 2_000);
      }
      const result = await withAbort(dependencies.transcribe({ arrayBuffer: bytes, requestContentType: contentType, chunkIndexHeader: chunkHeader, sourceHeader: source, signal: scope.signal }), scope.signal);
      scope.signal.throwIfAborted();
      if (typeof result.text !== "string" || result.text.length > 100_000 || result.chunkIndex !== Number(chunkHeader) || result.source !== source) {
        throw new RequestBoundaryError(502, "invalid_provider_result", "The transcription service returned an invalid result.");
      }
      const finalResult: TranscriptionResponse = { text: result.text, source: result.source, chunkIndex: result.chunkIndex,
        contentType, durationMs: typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0 ? result.durationMs : null,
        speakerId: null };
      const committed = await dependencies.repository.complete(auth, { ...reservation, usedUnits: bytes.byteLength, outcome: "succeeded", result: finalResult, text: finalResult.text, source });
      const settled = committed as { state?: string };
      if (settled.state && settled.state !== "succeeded") throw new RequestBoundaryError(409, "processing_outcome_unknown", "This operation could not be finalized. Reload saved work.");
      return Response.json(sessionId ? { ok: true, response: finalResult, saved: true } : finalResult, { status: sessionId ? 202 : 200 });
    } catch (error) {
      if (reservation) {
        await dependencies.repository.complete(auth, { ...reservation, usedUnits: providerStarted ? reservation.units : 0, outcome: providerStarted ? "unknown" : "failed", result: { error: { code: "processing_incomplete" } } }).catch(() => {});
      }
      if (scope.signal.aborted) return boundaryResponse(new RequestBoundaryError(408, "processing_interrupted", "Processing stopped or exceeded its deadline. Saved work remains available."));
      if (error instanceof RequestBoundaryError) return boundaryResponse(error);
      const safe = toPublicTranscriptionError(error);
      return Response.json({ error: safe.error }, { status: safe.status });
    } finally { releaseIngress?.(); clearTimeout(watchTimer); scope.abort(); scope.dispose(); }
  };
}
