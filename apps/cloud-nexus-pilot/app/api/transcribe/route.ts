import { NextResponse } from "next/server";

import {
  OpenAiTranscriptionError,
  transcribeWithOpenAi,
} from "@/lib/transcription/openai-transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const arrayBuffer = await request.arrayBuffer();
    const response = await transcribeWithOpenAi({
      arrayBuffer,
      requestContentType: request.headers.get("content-type")?.trim() || "audio/webm",
      chunkIndexHeader: request.headers.get("X-Chunk-Index"),
      sourceHeader: request.headers.get("X-Transcript-Source"),
    });
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof OpenAiTranscriptionError) {
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
