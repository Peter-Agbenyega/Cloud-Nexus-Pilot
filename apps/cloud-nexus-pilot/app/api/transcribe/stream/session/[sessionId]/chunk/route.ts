import { requireProviderUser } from "@/lib/server/provider-auth";
import { NextResponse } from "next/server";

import { processStreamingSessionChunk } from "@/lib/transcription/streaming-session-store";
import { toPublicTranscriptionError } from "@/lib/transcription/public-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSafeTranscriptSource(value: string | null): "microphone" | "system-audio" {
  if (value === "system-audio") return "system-audio";
  return "microphone";
}

function toChunkIndex(value: string | null): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

const ACCEPTED_CONTENT_TYPES = new Set([
  "audio/wav",
  "audio/webm",
  "audio/mpeg",
  "audio/mpga",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "video/webm",
]);

function toHttpStatus(code: string): number {
  if (code === "transcript_stream_session_missing") return 404;
  if (code === "transcript_backend_unavailable") return 503;
  return 400;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const auth = await requireProviderUser();
  if (auth.response) return auth.response;
  const { sessionId } = await context.params;
  const contentTypeHeader = request.headers.get("content-type")?.trim() || "";
  const chunkIndexHeader = request.headers.get("X-Chunk-Index");
  const chunkIndex = toChunkIndex(chunkIndexHeader);
  const source = toSafeTranscriptSource(request.headers.get("X-Transcript-Source"));

  // Route-level validation — returns structured errors before hitting the session store.
  const mimeType = contentTypeHeader.split(";")[0]?.trim().toLowerCase() || "";
  if (!mimeType || !ACCEPTED_CONTENT_TYPES.has(mimeType)) {
    const safe = toPublicTranscriptionError({ code: "invalid_content_type" });
    console.warn("[transcription][stream-session] chunk-rejected: invalid_content_type", {
      sessionId,
      chunkIndex,
      code: safe.error.code,
    });
    return NextResponse.json({ error: safe.error }, { status: safe.status });
  }

  const arrayBuffer = await request.arrayBuffer();

  if (arrayBuffer.byteLength === 0) {
    const safe = toPublicTranscriptionError({ code: "empty_payload" });
    console.warn("[transcription][stream-session] chunk-rejected: empty_payload", {
      sessionId,
      chunkIndex,
      code: safe.error.code,
    });
    return NextResponse.json({ error: safe.error }, { status: safe.status });
  }

  const contentType = contentTypeHeader || "audio/webm";
  console.info("[transcription][stream-session] chunk-received", {
    sessionId,
    chunkIndex,
    contentType,
    bytes: arrayBuffer.byteLength,
    source,
  });

  // Await chunk processing so the route only returns 202 after the session store has
  // finished transcription dispatch and SSE emission for this chunk.
  const result = await processStreamingSessionChunk({
    ownerId: auth.userId,
    sessionId,
    chunkIndex,
    source,
    contentType,
    arrayBuffer,
  });

  if (!result.ok) {
    const { error: publicError } = toPublicTranscriptionError(result);
    const status = toHttpStatus(publicError.code);
    console.warn("[transcription][stream-session] chunk-failed", {
      sessionId,
      chunkIndex,
      code: publicError.code,
      status,
    });
    return NextResponse.json({ error: publicError }, { status });
  }

  console.info("[transcription][stream-session] chunk-accepted", {
    sessionId,
    chunkIndex,
    contentType,
    bytes: arrayBuffer.byteLength,
  });

  return NextResponse.json(
    {
      sessionId,
      accepted: true,
      chunkIndex,
      status: "queued-for-session-transcription",
    },
    { status: 202 }
  );
}
