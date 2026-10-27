import { requireProviderUser } from "@/lib/server/provider-auth";
import { createProtectedTranscriptionHandler } from "@/lib/server/protected-transcription";
import { processingRepository } from "@/lib/server/processing-repository";
import { isDeepgramTranscriptionConfigured, transcribeWithDeepgram } from "@/lib/transcription/deepgram-transcribe";
import { transcribeWithOpenAi } from "@/lib/transcription/openai-transcribe";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createProtectedTranscriptionHandler({ authorize: requireProviderUser, repository: processingRepository,
  transcribe: (input) => (isDeepgramTranscriptionConfigured() ? transcribeWithDeepgram : transcribeWithOpenAi)(input),
});

export async function POST(request: Request) { return handle(request); }
