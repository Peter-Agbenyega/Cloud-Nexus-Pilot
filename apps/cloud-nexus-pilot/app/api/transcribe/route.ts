import { requireProviderUser } from "@/lib/server/provider-auth";
import { NextResponse } from "next/server";
import { toPublicTranscriptionError } from "@/lib/transcription/public-error";

import {
  isDeepgramTranscriptionConfigured,
  transcribeWithDeepgram,
} from "@/lib/transcription/deepgram-transcribe";
import {
  transcribeWithOpenAi,
} from "@/lib/transcription/openai-transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireProviderUser();
  if (auth.response) return auth.response;
  try {
    const arrayBuffer = await request.arrayBuffer();
    const transcribe = isDeepgramTranscriptionConfigured()
      ? transcribeWithDeepgram
      : transcribeWithOpenAi;
    const response = await transcribe({
      arrayBuffer,
      requestContentType: request.headers.get("content-type")?.trim() || "audio/webm",
      chunkIndexHeader: request.headers.get("X-Chunk-Index"),
      sourceHeader: request.headers.get("X-Transcript-Source"),
    });
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    const safe = toPublicTranscriptionError(error);
    return NextResponse.json({ error: safe.error }, { status: safe.status });
  }
}
