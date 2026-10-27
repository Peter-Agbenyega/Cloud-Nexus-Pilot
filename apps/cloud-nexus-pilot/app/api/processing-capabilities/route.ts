import { requireProviderUser } from "@/lib/server/provider-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  return Response.json({
    transcriptionProvider: process.env.DEEPGRAM_API_KEY?.trim() ? "Deepgram" : process.env.OPENAI_API_KEY?.trim() ? "OpenAI" : null,
    guidanceProvider: process.env.OPENAI_API_KEY?.trim() ? "OpenAI" : null,
    syntheticFixture: process.env.NEXT_PUBLIC_PILOT_TEST_FIXTURE === "1",
    acceptedAudio: "Complete PCM16 WAV",
    rawAudioRetained: false,
    sessionLimitMinutes: 30,
    note: "Configuration information only. Account allowance is enforced before processing; live provider availability is not certified by this response.",
  }, { headers: { "cache-control": "private, no-store" } });
}
