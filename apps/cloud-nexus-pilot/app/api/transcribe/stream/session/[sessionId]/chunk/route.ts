import { NextResponse } from "next/server";

import { processStreamingSessionChunk } from "@/lib/transcription/streaming-session-store";

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

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const arrayBuffer = await request.arrayBuffer();
  const chunkIndex = toChunkIndex(request.headers.get("X-Chunk-Index"));
  const source = toSafeTranscriptSource(request.headers.get("X-Transcript-Source"));
  const contentType = request.headers.get("content-type")?.trim() || "audio/webm";
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
    sessionId,
    chunkIndex,
    source,
    contentType,
    arrayBuffer,
  });

  if (!result.ok) {
    console.warn("[transcription][stream-session] chunk-failed", {
      sessionId,
      chunkIndex,
      code: result.code,
      message: result.message,
    });
    const status = result.code === "transcript_stream_session_missing" ? 404 : 400;
    return NextResponse.json(
      {
        error: {
          code: result.code,
          message: result.message,
          detail: result.detail,
        },
      },
      { status }
    );
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
