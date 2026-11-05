// Explicit local acceptance profile. All identities/data stay in the recovery stack.
export function validateLiveProfile(env, mode) {
  const fail = message => { throw new Error(message); };
  if (!["build", "start"].includes(mode)) fail("Use build or start.");
  if (env.PILOT_LIVE_ACCEPTANCE !== "1" || env.NEXT_PUBLIC_PILOT_LIVE_ACCEPTANCE !== "1") fail("Explicit live acceptance flags are required.");
  if (env.NEXT_PUBLIC_PILOT_TEST_FIXTURE !== "0") fail("Disable synthetic mode explicitly for live acceptance.");
  if (env.NEXT_PUBLIC_PILOT_ALLOW_LOOPBACK !== "1" || env.PILOT_RECOVERY_STACK !== "1") fail("Recovery isolation flags are required.");
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "PILOT_DATA_API_URL"])
    if (env[key] !== "http://127.0.0.1:59090") fail("Live acceptance requires the existing recovery identity and data endpoint.");
  if (env.OPENAI_BASE_URL !== "https://api.openai.com/v1") fail("Live acceptance permits only the official OpenAI endpoint.");
  if (env.DEEPGRAM_API_KEY) fail("This acceptance profile uses OpenAI only.");
  if (env.OPENAI_MODEL !== "gpt-4o-mini" || env.OPENAI_TRANSCRIPTION_MODEL !== "gpt-4o-mini-transcribe-2025-12-15") fail("Unexpected acceptance models.");
  if (env.PILOT_LOCAL_FRONTEND_PORT !== "43102" || env.PILOT_LOCAL_REALTIME_PORT !== "43311" ||
      env.NEXT_PUBLIC_SITE_URL !== "http://127.0.0.1:43102" || env.PILOT_PUBLIC_ORIGIN !== "http://127.0.0.1:43102" ||
      env.NEXT_PUBLIC_PILOT_REALTIME_WS_URL !== "ws://127.0.0.1:43311/ws/session")
    fail("Live acceptance requires separate approved loopback ports.");
  if (!env.SUPABASE_PUBLISHABLE_KEY || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.PILOT_PROCESSING_SERVICE_KEY)
    fail("Recovery identity and settlement configuration are required.");
  if (mode === "start") {
    for (const [key, role] of [["NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon"], ["SUPABASE_PUBLISHABLE_KEY", "anon"], ["PILOT_PROCESSING_SERVICE_KEY", "service_role"]]) {
      let claims;
      try { claims = JSON.parse(Buffer.from(env[key].split(".")[1], "base64url").toString("utf8")); } catch { fail("Recovery token format is invalid."); }
      if (claims.role !== role || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 + 300) fail("Recovery credentials must be renewed before live startup.");
    }
  }
  if (mode === "start" && (!env.OPENAI_API_KEY?.trim() || /^(local-|synthetic|your[_-]|replace|<)/i.test(env.OPENAI_API_KEY.trim())))
    fail("Configure an authorized live OpenAI key privately before starting.");
}
