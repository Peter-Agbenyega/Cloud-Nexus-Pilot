import { requireProviderUser } from "@/lib/server/provider-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasDeepgram = Boolean(process.env.DEEPGRAM_API_KEY?.trim());
  let loopback = false;
  try { loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").hostname); } catch { /* invalid endpoint is not certified */ }
  const fixture = process.env.NEXT_PUBLIC_PILOT_TEST_FIXTURE === "1" && loopback && hasOpenAi;
  return Response.json({
    transcriptionProvider: hasDeepgram ? "Deepgram" : hasOpenAi ? (fixture ? "Synthetic fixture" : "OpenAI") : null,
    guidanceProvider: hasOpenAi ? (fixture ? "Synthetic fixture" : "OpenAI") : null,
    syntheticFixture: fixture,
    speechRecognitionConfigured: hasDeepgram || (hasOpenAi && !fixture),
    questionSpecificGuidanceConfigured: hasOpenAi && !fixture,
    acceptedAudio: "Complete PCM16 WAV",
    rawAudioRetained: false,
    sessionLimitMinutes: 30,
    note: "Configuration information only. Account allowance is enforced before processing; live provider availability is not certified by this response.",
  }, { headers: { "cache-control": "private, no-store" } });
}
