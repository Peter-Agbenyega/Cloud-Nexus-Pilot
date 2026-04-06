import { NextResponse } from "next/server";

import {
  DeepgramTranscriptionError,
  transcribeWithDeepgram,
} from "@/lib/transcription/deepgram-transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // Legacy note:
    // This route remains available for file-upload and other non-live transcription requests only.
    // Live Copilot streaming must continue to use the persistent /api/transcribe/stream/session path.
    const arrayBuffer = await request.arrayBuffer();
    const response = await transcribeWithDeepgram({
      arrayBuffer,
      requestContentType: request.headers.get("content-type")?.trim() || "audio/webm",
      chunkIndexHeader: request.headers.get("X-Chunk-Index"),
      sourceHeader: request.headers.get("X-Transcript-Source"),
    });
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof DeepgramTranscriptionError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
            detail: error.detail || undefined,
          },
        },
        { status: error.status }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: "transcript_processing_failed",
          message: "Unexpected transcription failure in the server route.",
        },
      },
      { status: 500 }
    );
  }
}
