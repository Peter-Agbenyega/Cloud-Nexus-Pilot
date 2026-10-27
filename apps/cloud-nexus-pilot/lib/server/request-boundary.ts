// Shared transport boundary. Content-Length is only an early rejection hint;
// every actual stream chunk is counted and the reader is cancelled on failure.
export class RequestBoundaryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function boundaryResponse(error: unknown): Response {
  const safe = error instanceof RequestBoundaryError ? error : new RequestBoundaryError(500, "processing_failed", "Processing failed. Retry safely.");
  return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status });
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  // Framework/proxy request URLs may use an internal host. Only explicit server
  // configuration selects the browser origin; never trust forwarded host input.
  const configured = process.env.PILOT_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_SITE_URL;
  let expected: string;
  try { expected = new URL(configured || request.url).origin; }
  catch { throw new RequestBoundaryError(503, "application_origin_unavailable", "Application origin is not configured correctly."); }
  if ((!origin && request.headers.has("cookie")) || (origin && origin !== expected) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestBoundaryError(403, "origin_rejected", "This action must originate from the application.");
  }
}

export function processingScope(parent: AbortSignal, timeoutMs = 30_000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, abort, dispose() { clearTimeout(timer); parent.removeEventListener("abort", abort); } };
}

export async function readBoundedBytes(request: Request, maxBytes: number, timeoutMs = 10_000): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid body limit");
  const claimed = request.headers.get("content-length");
  if (claimed !== null && (!/^\d+$/.test(claimed) || !Number.isSafeInteger(Number(claimed)))) {
    throw new RequestBoundaryError(400, "invalid_content_length", "Invalid content length.");
  }
  if (claimed && Number(claimed) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBoundaryError(413, "payload_too_large", "The input exceeds the allowed size.");
  }
  const scope = processingScope(request.signal, timeoutMs);
  const reader = request.body?.getReader();
  if (!reader) { scope.dispose(); return new ArrayBuffer(0); }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const error = new RequestBoundaryError(408, "request_interrupted", "Input was interrupted or timed out.");
    rejectAbort(error);
    void reader.cancel().catch(() => {});
  };
  scope.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (scope.signal.aborted) throw new RequestBoundaryError(408, "request_interrupted", "Input was interrupted.");
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (scope.signal.aborted) throw new RequestBoundaryError(408, "request_interrupted", "Input was interrupted.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new RequestBoundaryError(413, "payload_too_large", "The input exceeds the allowed size.");
      chunks.push(chunk.value);
    }
    if (claimed !== null && bytes !== Number(claimed)) throw new RequestBoundaryError(400, "content_length_mismatch", "Input length did not match its declaration.");
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output.buffer;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof RequestBoundaryError) throw error;
    throw new RequestBoundaryError(400, "invalid_body", "The input stream could not be read.");
  } finally {
    chunks.length = 0;
    scope.signal.removeEventListener("abort", onAbort);
    scope.dispose();
    reader.releaseLock();
  }
}

export async function readBoundedJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  assertSameOrigin(request);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestBoundaryError(415, "invalid_content_type", "A JSON object is required.");
  }
  try {
    const bytes = await readBoundedBytes(request, maxBytes);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (++nodes > 5000 || item.depth > 16) throw new Error("JSON structure exceeds its limit");
      if (item.value && typeof item.value === "object") {
        for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBoundaryError) throw error;
    throw new RequestBoundaryError(400, "invalid_json", "A valid JSON object is required.");
  }
}

export function validateAudio(bytes: ArrayBuffer, contentType: string): void {
  const fail = () => { throw new RequestBoundaryError(415, "invalid_audio", "This path supports complete PCM16 WAV audio only. Use PCM live capture or upload a finalized PCM16 WAV file."); };
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "audio/wav" || bytes.byteLength < 46) fail();
  const data = new DataView(bytes);
  const text = (offset: number, size: number) => new TextDecoder().decode(new Uint8Array(bytes, offset, size));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE" || data.getUint32(4, true) + 8 !== bytes.byteLength) fail();
  let offset = 12, format = false, frames = false, blockAlign = 0;
  while (offset + 8 <= bytes.byteLength) {
    const name = text(offset, 4), size = data.getUint32(offset + 4, true), start = offset + 8;
    if (size > bytes.byteLength - start) fail();
    if (name === "fmt ") {
      if (format || size < 16) fail();
      const encoding = data.getUint16(start, true), channels = data.getUint16(start + 2, true);
      const rate = data.getUint32(start + 4, true), byteRate = data.getUint32(start + 8, true);
      blockAlign = data.getUint16(start + 12, true);
      if (encoding !== 1 || ![1, 2].includes(channels) || rate < 8000 || rate > 96000 || data.getUint16(start + 14, true) !== 16 || blockAlign !== channels * 2 || byteRate !== rate * blockAlign) fail();
      format = true;
    } else if (name === "data") {
      if (!format || frames || size === 0 || size % blockAlign !== 0) fail();
      frames = true;
    }
    offset = start + size + (size % 2);
  }
  if (!format || !frames || offset !== bytes.byteLength) fail();
}

export async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new RequestBoundaryError(408, "processing_interrupted", "Processing was interrupted or timed out."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
