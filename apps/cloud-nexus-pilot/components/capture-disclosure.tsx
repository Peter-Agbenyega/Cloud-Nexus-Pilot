"use client";

import { useEffect, useState } from "react";

type CaptureConfiguration = {
  transcriptionProvider: "OpenAI" | "Deepgram" | null;
  guidanceProvider: "OpenAI" | null;
  syntheticFixture: boolean;
};

export function CaptureDisclosure({ appearance = "light", sharedSession = false }: { appearance?: "light" | "dark"; sharedSession?: boolean }) {
  const [configuration, setConfiguration] = useState<CaptureConfiguration | null>(null);
  const [state, setState] = useState<"checking" | "verified" | "unverified">("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    setState("checking");
    setConfiguration(null);
    void (async () => {
      try {
        const response = await fetch("/api/processing-capabilities", { cache: "no-store", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("Configuration unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "", bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 8192) throw new Error("Configuration response exceeded its limit");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const value = JSON.parse(text) as Record<string, unknown>;
        if (!value || !["OpenAI", "Deepgram", null].includes(value.transcriptionProvider as string | null) ||
            !["OpenAI", null].includes(value.guidanceProvider as string | null) || typeof value.syntheticFixture !== "boolean" ||
            value.rawAudioRetained !== false || value.acceptedAudio !== "Complete PCM16 WAV" || value.sessionLimitMinutes !== 30) {
          throw new Error("Configuration response could not be verified");
        }
        if (controller.signal.aborted) throw new Error("Configuration check timed out");
        if (active) {
          setConfiguration(value as unknown as CaptureConfiguration);
          setState("verified");
        }
      } catch {
        if (active) setState("unverified");
      } finally { window.clearTimeout(timeout); }
    })();
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [attempt]);

  const dark = appearance === "dark";
  return (
    <section aria-label="Before starting audio capture" style={{ margin: "16px 0", padding: 16, borderRadius: 10, border: `1px solid ${dark ? "#636386" : "#CBD5E1"}`, background: dark ? "#171728" : "#F8FAFC", color: dark ? "#D8D8F0" : "#334155", fontSize: 13, lineHeight: 1.65 }}>
      <h3 style={{ fontWeight: 600, marginBottom: 6 }}>Before starting audio capture</h3>
      <p>Capture starts from your visible action. Confirm participant permission and the rules of your organization or assessment before starting. Pause stops new audio processing. {sharedSession ? "Stop ends this transcription lane; end the shared session to release its capture source." : "Stop releases the capture source."}</p>
      <p role="status" aria-live="polite" style={{ marginTop: 8 }}>
        {state === "checking" ? "Checking processor configuration…" : configuration ? <>
          Configured transcription: {configuration.transcriptionProvider ?? "not configured"}. Guidance: {configuration.guidanceProvider ?? "not configured"}.
          {configuration.syntheticFixture ? " A synthetic test fixture is selected for this local test." : ""}
          {" "}This is configuration information; live provider availability and account allowance are checked separately. The configured processor receives the audio or text needed for the requested operation.
        </> : "Processor configuration could not be verified. Sign in and retry; this display does not confirm provider availability."}
      </p>
      {state === "unverified" ? <button type="button" onClick={() => setAttempt(value => value + 1)} style={{ marginTop: 6, border: "1px solid currentColor", borderRadius: 6, padding: "4px 10px", fontWeight: 600 }}>Retry configuration check</button> : null}
      <p style={{ marginTop: 8 }}>Microphone and shared-tab audio are separate choices. For shared audio, select a supported browser tab and enable Share audio. A video-only share cannot be transcribed. If shared audio is unavailable, explicitly select Microphone or upload a completed PCM16 WAV file.</p>
      <p style={{ marginTop: 8 }}>{configuration ? "Pilot processes raw audio transiently and does not retain it as a recording. " : "The intended capture path processes audio transiently; its configuration is not verified here. "}Saved transcript and guidance text is separate. Delete the server session and browser-local history separately. Provider retention follows the approved service configuration. Sessions are bounded to 30 minutes.</p>
    </section>
  );
}
