"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranscriptionWorkflow } from "@/features/transcription/use-transcription-workflow";
import type { InterviewIntent } from "@/lib/contracts/interview";
import {
  createCreateOrResumeSessionRequestInit,
  getCreateOrResumeSessionEndpointUrl,
} from "@/lib/contracts/session-execution-client";
import type { SessionExecutionId } from "@/lib/contracts/session-execution";

/* ================================================================
   TYPES & CONSTANTS — unchanged logic
   ================================================================ */

type LaunchFlowStep = "ready" | "requesting" | "live";
type AudioMode = "microphone" | "tab-audio";

type LaunchCaptureState = {
  status: "idle" | "requesting" | "live-stream-confirmed" | "failed";
  detail: string;
  streamId: string | null;
};

type GuidanceData = {
  gist: string;
  key_points: string[];
  full_answer: string;
};

const INITIAL_CAPTURE_STATE: LaunchCaptureState = {
  status: "idle",
  detail: "Share a tab with audio to start live transcription.",
  streamId: null,
};

function createStableId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function inferInterviewIntent(question: string): InterviewIntent {
  const normalized = question.toLowerCase();
  if (/system design|architecture|scalability|distributed/i.test(normalized)) return "system_design";
  if (/compare|difference|versus|vs\b/i.test(normalized)) return "comparison";
  if (/follow up|why did you|what happened next/i.test(normalized)) return "follow_up";
  if (/code|algorithm|api|database|debug|deploy|kubernetes|terraform|aws|react|typescript/i.test(normalized)) return "technical";
  if (/tell me about|describe a time|how did you handle/i.test(normalized)) return "behavioral";
  return "general";
}

function getLiveStatusLabel(params: {
  status: ReturnType<typeof useTranscriptionWorkflow>["status"];
  transportStatus: ReturnType<typeof useTranscriptionWorkflow>["transportStatus"];
}) {
  if (
    params.transportStatus === "streaming-session-failed" ||
    params.transportStatus === "legacy-fallback-active" ||
    params.status === "failed"
  ) return "Transcription unavailable. Retrying...";
  if (params.status === "receiving-transcript") return "Receiving transcript...";
  return "Listening...";
}

function normalizeQuestionMatchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isQuestionLikeSegment(segmentText: string, detectedQuestion: string) {
  const normalizedSegment = normalizeQuestionMatchText(segmentText);
  const normalizedQuestion = normalizeQuestionMatchText(detectedQuestion);
  if (!normalizedSegment || !normalizedQuestion) return false;
  if (normalizedSegment.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedSegment)) return true;
  const questionTokens = normalizedQuestion.split(" ").filter(Boolean);
  if (questionTokens.length === 0) return false;
  const segmentTokenSet = new Set(normalizedSegment.split(" ").filter(Boolean));
  const overlapCount = questionTokens.filter((token) => segmentTokenSet.has(token)).length;
  return overlapCount / questionTokens.length >= 0.6;
}

function getSpeakerDisplay(speakerId: number | null | undefined) {
  if (typeof speakerId !== "number") return null;
  if (speakerId === 0) {
    return {
      label: "Them",
      className: "border-cyan-400/25 bg-cyan-400/10 text-cyan-100",
      badgeClassName: "bg-cyan-300/15 text-cyan-100 ring-1 ring-inset ring-cyan-300/25",
    };
  }
  return {
    label: "You",
    className: "border-slate-600 bg-slate-800/90 text-slate-100",
    badgeClassName: "bg-slate-700/80 text-slate-200 ring-1 ring-inset ring-slate-500/60",
  };
}

function buildTranscriptContext(
  segments: ReturnType<typeof useTranscriptionWorkflow>["segments"],
  limit = 8
) {
  return segments
    .slice(-limit)
    .map((segment, index) => {
      const speaker = segment.speakerId === 0 ? "Them" : segment.speakerId === 1 ? "You" : "Unknown";
      return `Segment ${index + 1} (${speaker}): ${segment.text.trim()}`;
    })
    .join("\n");
}

function parseSsePayloads(buffer: string) {
  const payloads: Array<Record<string, unknown>> = [];
  let nextBuffer = buffer;
  let boundaryIndex = nextBuffer.indexOf("\n\n");
  while (boundaryIndex >= 0) {
    const rawEvent = nextBuffer.slice(0, boundaryIndex);
    nextBuffer = nextBuffer.slice(boundaryIndex + 2);
    const dataText = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");
    if (dataText) {
      try { payloads.push(JSON.parse(dataText) as Record<string, unknown>); } catch { /* skip */ }
    }
    boundaryIndex = nextBuffer.indexOf("\n\n");
  }
  return { payloads, buffer: nextBuffer };
}

function parseGuidanceJson(rawText: string): GuidanceData | null {
  try {
    const trimmed = rawText.trim();
    // Try to find JSON in the response (may be wrapped in markdown code fence)
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (typeof parsed.gist === "string" && Array.isArray(parsed.key_points) && typeof parsed.full_answer === "string") {
      return {
        gist: parsed.gist,
        key_points: parsed.key_points.filter((p): p is string => typeof p === "string"),
        full_answer: parsed.full_answer,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/* ================================================================
   COMPONENT
   ================================================================ */

export function ReadyStateLaunchPanel() {
  const [launchFlowStep, setLaunchFlowStep] = useState<LaunchFlowStep>("ready");
  const [audioMode, setAudioMode] = useState<AudioMode>("tab-audio");
  const [captureState, setCaptureState] = useState<LaunchCaptureState>(INITIAL_CAPTURE_STATE);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const guidanceAbortControllerRef = useRef<AbortController | null>(null);
  const lastAutoGuidanceQuestionRef = useRef<string>("");
  const sessionExecutionIdRef = useRef<SessionExecutionId | null>(null);
  const transcriptionWorkflow = useTranscriptionWorkflow({ repositoryMode: "local-only" });

  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceData, setGuidanceData] = useState<GuidanceData | null>(null);
  const [guidanceStatus, setGuidanceStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [guidanceError, setGuidanceError] = useState("");
  const [questionsCoached, setQuestionsCoached] = useState(0);
  const [sessionStartTime] = useState<number>(Date.now());
  const [streamedFullAnswer, setStreamedFullAnswer] = useState("");
  const [showCard1, setShowCard1] = useState(false);
  const [showCard2, setShowCard2] = useState(false);
  const [showCard3, setShowCard3] = useState(false);

  const stopTranscriptionCapture = transcriptionWorkflow.stopCapture;
  const startTranscriptionCapture = transcriptionWorkflow.startCapture;

  async function ensureSessionExecution(): Promise<SessionExecutionId | null> {
    if (sessionExecutionIdRef.current) return sessionExecutionIdRef.current;
    const localSessionExecutionId = createStableId("session-execution");
    sessionExecutionIdRef.current = localSessionExecutionId;
    try {
      const response = await fetch(
        getCreateOrResumeSessionEndpointUrl(),
        createCreateOrResumeSessionRequestInit({
          mode: "interview",
          title: "Live question guidance",
          goal: "Provide lightweight live interview answer guidance from shared-tab transcript questions.",
          currentRoute: "/workspace",
        })
      );
      if (!response.ok) return localSessionExecutionId;
      const payload = (await response.json()) as { sessionExecutionId?: string };
      if (payload.sessionExecutionId?.trim()) {
        sessionExecutionIdRef.current = payload.sessionExecutionId;
      }
    } catch {
      return localSessionExecutionId;
    }
    return sessionExecutionIdRef.current;
  }

  function stopActiveStream() {
    activeStreamRef.current?.getTracks().forEach((track) => track.stop());
    activeStreamRef.current = null;
  }

  function cancelActiveGuidanceRequest() {
    guidanceAbortControllerRef.current?.abort();
    guidanceAbortControllerRef.current = null;
  }

  useEffect(() => {
    return () => {
      cancelActiveGuidanceRequest();
      stopActiveStream();
      stopTranscriptionCapture();
    };
  }, [stopTranscriptionCapture]);

  async function handleStartLiveCopilot() {
    if (typeof window === "undefined") return;
    setLaunchFlowStep("requesting");
    setCaptureState({ status: "requesting", detail: "Choose a browser tab and enable tab audio to continue.", streamId: null });

    try {
      stopTranscriptionCapture();
      stopActiveStream();

      let stream: MediaStream;

      if (audioMode === "tab-audio") {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          stream.getTracks().forEach((track) => track.stop());
          setCaptureState({ status: "failed", detail: "Please select a tab and enable audio to start.", streamId: null });
          setLaunchFlowStep("ready");
          return;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      activeStreamRef.current = stream;
      setCaptureState({ status: "live-stream-confirmed", detail: "Live audio connected. Starting transcription...", streamId: stream.id });
      setLaunchFlowStep("live");

      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => { void handleEndSession(); }, { once: true });
      });

      await startTranscriptionCapture({
        existingStream: stream,
        source: audioMode === "tab-audio" ? "system-audio" : "microphone",
      });
      void ensureSessionExecution();
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
      setCaptureState({
        status: "failed",
        detail: denied ? "Please allow access to start." : "Unable to start right now. Please try again.",
        streamId: null,
      });
      setLaunchFlowStep("ready");
    }
  }

  async function handleEndSession() {
    cancelActiveGuidanceRequest();
    stopTranscriptionCapture();
    stopActiveStream();
    lastAutoGuidanceQuestionRef.current = "";
    sessionExecutionIdRef.current = null;
    setGuidanceText("");
    setGuidanceData(null);
    setGuidanceStatus("idle");
    setGuidanceError("");
    setShowCard1(false);
    setShowCard2(false);
    setShowCard3(false);
    setCaptureState({ status: "idle", detail: "Session ended.", streamId: null });
    setLaunchFlowStep("ready");
  }

  const handleGetGuidance = useCallback(async function handleGetGuidance() {
    const detectedQuestion =
      transcriptionWorkflow.aiDetectedQuestion.trim() ||
      transcriptionWorkflow.latestDetectedQuestion.trim();
    if (detectedQuestion.length < 10) return;

    cancelActiveGuidanceRequest();
    const abortController = new AbortController();
    guidanceAbortControllerRef.current = abortController;

    setGuidanceStatus("loading");
    setGuidanceText("");
    setGuidanceData(null);
    setGuidanceError("");
    setStreamedFullAnswer("");
    setShowCard1(false);
    setShowCard2(false);
    setShowCard3(false);

    try {
      void ensureSessionExecution();
      const response = await fetch("/api/generate-guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          question: detectedQuestion,
          transcriptContext: buildTranscriptContext(transcriptionWorkflow.segments),
          interviewMode: inferInterviewIntent(detectedQuestion),
        }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) throw new Error("Live guidance is unavailable right now.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";
      let receivedDone = false;

      while (!receivedDone) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const parsed = parseSsePayloads(buffer);
        buffer = parsed.buffer;

        for (const payload of parsed.payloads) {
          if (payload.type === "token" && typeof payload.token === "string") {
            streamedText += payload.token;
            setGuidanceText(streamedText);
          }
          if (payload.type === "chunk" && typeof payload.content === "string") {
            streamedText += payload.content;
            setGuidanceText(streamedText);
          }
          if (payload.type === "error" && typeof payload.message === "string") {
            throw new Error(payload.message);
          }
          if (payload.type === "done") receivedDone = true;
        }
        if (done) receivedDone = true;
      }

      if (!streamedText.trim()) throw new Error("Live guidance returned an empty response.");

      // Try to parse structured JSON
      const structured = parseGuidanceJson(streamedText);
      if (structured) {
        setGuidanceData(structured);
        // Staggered card reveal
        setShowCard1(true);
        setTimeout(() => setShowCard2(true), 600);
        setTimeout(() => {
          setShowCard3(true);
          // Simulate streaming the full answer character by character
          let i = 0;
          const fullAnswer = structured.full_answer;
          const streamInterval = setInterval(() => {
            i += 2;
            if (i >= fullAnswer.length) {
              setStreamedFullAnswer(fullAnswer);
              clearInterval(streamInterval);
            } else {
              setStreamedFullAnswer(fullAnswer.slice(0, i));
            }
          }, 15);
        }, 1200);
      } else {
        // Fallback: show raw text as full_answer
        setGuidanceData({
          gist: streamedText.split(/[.!?]/)[0]?.trim() || streamedText.slice(0, 80),
          key_points: [],
          full_answer: streamedText,
        });
        setShowCard1(true);
        setTimeout(() => setShowCard3(true), 300);
        setStreamedFullAnswer(streamedText);
      }

      setQuestionsCoached((prev) => prev + 1);
      setGuidanceStatus("ready");
    } catch (error) {
      if (abortController.signal.aborted) return;
      setGuidanceStatus("failed");
      setGuidanceError(error instanceof Error ? error.message : "Unable to generate guidance right now.");
    } finally {
      if (guidanceAbortControllerRef.current === abortController) guidanceAbortControllerRef.current = null;
    }
  }, [transcriptionWorkflow.aiDetectedQuestion, transcriptionWorkflow.latestDetectedQuestion, transcriptionWorkflow.segments]);

  const liveStatus = getLiveStatusLabel({
    status: transcriptionWorkflow.status,
    transportStatus: transcriptionWorkflow.transportStatus,
  });
  const preferredDetectedQuestion =
    transcriptionWorkflow.aiDetectedQuestion || transcriptionWorkflow.latestDetectedQuestion;
  const transcriptSegments = transcriptionWorkflow.segments;
  const draftSegment = transcriptionWorkflow.draftSegment;
  const latestSegmentId = transcriptSegments.at(-1)?.id ?? null;

  useEffect(() => {
    if (launchFlowStep !== "live") lastAutoGuidanceQuestionRef.current = "";
  }, [launchFlowStep]);

  useEffect(() => {
    const detectedQuestion = preferredDetectedQuestion.trim();
    if (
      launchFlowStep !== "live" ||
      !detectedQuestion ||
      guidanceStatus === "loading" ||
      detectedQuestion === lastAutoGuidanceQuestionRef.current
    ) return;
    lastAutoGuidanceQuestionRef.current = detectedQuestion;
    void handleGetGuidance();
  }, [guidanceStatus, handleGetGuidance, launchFlowStep, preferredDetectedQuestion]);

  const questionSegmentIds = useMemo(() => {
    const detectedQuestion = preferredDetectedQuestion.trim();
    if (!detectedQuestion) return new Set<string>();
    return new Set(
      transcriptSegments
        .filter((segment) => isQuestionLikeSegment(segment.text, detectedQuestion))
        .map((segment) => segment.id)
    );
  }, [preferredDetectedQuestion, transcriptSegments]);

  const avgResponseTime = questionsCoached > 0 ? `${Math.round((Date.now() - sessionStartTime) / 1000 / questionsCoached)}s` : "--";

  /* ================================================================
     RENDER — IDLE STATE (two mode cards)
     ================================================================ */
  if (launchFlowStep !== "live") {
    return (
      <div>
        {/* Mode selection cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Microphone card */}
          <button
            type="button"
            onClick={() => setAudioMode("microphone")}
            style={{
              background: audioMode === "microphone" ? "rgba(79,70,229,0.08)" : "#13131F",
              border: audioMode === "microphone" ? "1px solid #4F46E5" : "0.5px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: 20,
              cursor: "pointer",
              textAlign: "center",
              transition: "border-color 0.2s, background 0.2s",
            }}
            onMouseEnter={(e) => {
              if (audioMode !== "microphone") {
                e.currentTarget.style.borderColor = "rgba(79,70,229,0.4)";
                e.currentTarget.style.background = "#16162A";
              }
            }}
            onMouseLeave={(e) => {
              if (audioMode !== "microphone") {
                e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                e.currentTarget.style.background = "#13131F";
              }
            }}
          >
            <div style={{ fontSize: 28, color: "#7C6CFF", marginBottom: 10 }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 2m0 3a3 3 0 0 1 3 -3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3z" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <path d="M8 21l8 0" />
                <path d="M12 17l0 4" />
              </svg>
            </div>
            <p style={{ fontSize: 14, fontWeight: 500, color: "#E0E0FF", marginBottom: 4 }}>Use Microphone</p>
            <p style={{ fontSize: 12, color: "#5050A0", lineHeight: 1.5 }}>For phone screens and in-person interviews</p>
          </button>

          {/* Tab audio card */}
          <button
            type="button"
            onClick={() => setAudioMode("tab-audio")}
            style={{
              background: audioMode === "tab-audio" ? "rgba(79,70,229,0.08)" : "#13131F",
              border: audioMode === "tab-audio" ? "1px solid #4F46E5" : "0.5px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: 20,
              cursor: "pointer",
              textAlign: "center",
              transition: "border-color 0.2s, background 0.2s",
            }}
            onMouseEnter={(e) => {
              if (audioMode !== "tab-audio") {
                e.currentTarget.style.borderColor = "rgba(79,70,229,0.4)";
                e.currentTarget.style.background = "#16162A";
              }
            }}
            onMouseLeave={(e) => {
              if (audioMode !== "tab-audio") {
                e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                e.currentTarget.style.background = "#13131F";
              }
            }}
          >
            <div style={{ fontSize: 28, color: "#7C6CFF", marginBottom: 10 }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z" />
                <path d="M7 20h10" />
                <path d="M9 16v4" />
                <path d="M15 16v4" />
              </svg>
            </div>
            <p style={{ fontSize: 14, fontWeight: 500, color: "#E0E0FF", marginBottom: 4 }}>Share Tab Audio</p>
            <p style={{ fontSize: 12, color: "#5050A0", lineHeight: 1.5 }}>For Zoom, Teams, and Google Meet calls</p>
          </button>
        </div>

        {/* Start Session button */}
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => void handleStartLiveCopilot()}
            disabled={launchFlowStep === "requesting"}
            style={{
              background: "#4F46E5",
              color: "white",
              borderRadius: 8,
              padding: "10px 20px",
              fontSize: 13,
              fontWeight: 500,
              border: "none",
              cursor: launchFlowStep === "requesting" ? "not-allowed" : "pointer",
              opacity: launchFlowStep === "requesting" ? 0.6 : 1,
              transition: "opacity 0.2s",
            }}
          >
            {launchFlowStep === "requesting" ? "Requesting Permission..." : "Start Session"}
          </button>
        </div>

        {captureState.status === "failed" && (
          <p style={{ fontSize: 12, color: "#EF4444", marginTop: 8 }}>{captureState.detail}</p>
        )}
      </div>
    );
  }

  /* ================================================================
     RENDER — LIVE STATE (transcript + three answer cards + stats)
     ================================================================ */
  return (
    <div>
      {/* Live header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", background: "#10B981",
              boxShadow: "0 0 8px rgba(16,185,129,0.5)",
              display: "inline-block",
            }} />
            <span style={{ fontSize: 13, color: "#A0A0C0" }}>{liveStatus}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleEndSession()}
          style={{
            background: "transparent",
            border: "0.5px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 12,
            color: "#7070A0",
            cursor: "pointer",
            transition: "border-color 0.2s, color 0.2s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#7070A0"; }}
        >
          End Session
        </button>
      </div>

      {/* Detected question */}
      {preferredDetectedQuestion && (
        <div style={{
          background: "#13131F",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 10,
          padding: "10px 14px",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.08em", color: "#4A4A6A", marginBottom: 4 }}>
              Detected Question
            </p>
            <p style={{ fontSize: 13, color: "#E0E0FF" }}>{preferredDetectedQuestion}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleGetGuidance()}
            disabled={guidanceStatus === "loading"}
            style={{
              background: "rgba(79,70,229,0.12)",
              color: "#7C6CFF",
              border: "0.5px solid rgba(124,108,255,0.3)",
              borderRadius: 6,
              padding: "5px 12px",
              fontSize: 11,
              cursor: guidanceStatus === "loading" ? "not-allowed" : "pointer",
              opacity: guidanceStatus === "loading" ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {guidanceStatus === "loading" ? "Generating..." : "Get Guidance"}
          </button>
        </div>
      )}

      {/* Error display */}
      {guidanceError && (
        <div style={{
          background: "rgba(239,68,68,0.08)",
          borderLeft: "3px solid #EF4444",
          borderRadius: "0 10px 10px 0",
          padding: "10px 14px",
          marginBottom: 12,
          fontSize: 12,
          color: "#EF4444",
        }}>
          {guidanceError}
        </div>
      )}

      {/* === THREE LAYERED ANSWER CARDS === */}
      {guidanceData && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Card 1 — SAY THIS NOW (gold) */}
          {showCard1 && (
            <div style={{
              background: "rgba(251,191,36,0.07)",
              borderLeft: "3px solid #FBBF24",
              borderRadius: "0 10px 10px 0",
              padding: "14px 16px",
              animation: "fadeUp 300ms ease-out",
            }}>
              <p style={{
                fontSize: 10, fontWeight: 500, textTransform: "uppercase",
                letterSpacing: "0.08em", color: "#FBBF24", marginBottom: 6,
              }}>
                Say This Now
              </p>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "#D4A820" }}>
                {guidanceData.gist}
              </p>
            </div>
          )}

          {/* Card 2 — HIT THESE POINTS (teal) */}
          {showCard2 && guidanceData.key_points.length > 0 && (
            <div style={{
              background: "rgba(45,212,191,0.07)",
              borderLeft: "3px solid #2DD4BF",
              borderRadius: "0 10px 10px 0",
              padding: "14px 16px",
              animation: "fadeUp 300ms ease-out",
            }}>
              <p style={{
                fontSize: 10, fontWeight: 500, textTransform: "uppercase",
                letterSpacing: "0.08em", color: "#2DD4BF", marginBottom: 6,
              }}>
                Hit These Points
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {guidanceData.key_points.map((point, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{
                      width: 5, height: 5, borderRadius: "50%", background: "#2DD4BF",
                      marginTop: 6, flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 13, color: "#5B9E9A" }}>{point}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card 3 — YOUR FULL ANSWER (violet) */}
          {showCard3 && (
            <div style={{
              background: "rgba(124,108,255,0.07)",
              borderLeft: "3px solid #7C6CFF",
              borderRadius: "0 10px 10px 0",
              padding: "14px 16px",
              animation: "fadeUp 300ms ease-out",
            }}>
              <p style={{
                fontSize: 10, fontWeight: 500, textTransform: "uppercase",
                letterSpacing: "0.08em", color: "#7C6CFF", marginBottom: 6,
              }}>
                Your Full Answer
              </p>
              <p style={{ fontSize: 13, color: "#9090C0", lineHeight: 1.6 }}>
                {streamedFullAnswer}
                {streamedFullAnswer.length < (guidanceData.full_answer?.length ?? 0) && (
                  <span style={{
                    display: "inline-block",
                    width: 2,
                    height: 14,
                    background: "#7C6CFF",
                    marginLeft: 2,
                    verticalAlign: "text-bottom",
                    animation: "blink 1s step-end infinite",
                  }} />
                )}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Loading state */}
      {guidanceStatus === "loading" && !guidanceData && (
        <div style={{
          background: "rgba(79,70,229,0.07)",
          borderLeft: "3px solid #4F46E5",
          borderRadius: "0 10px 10px 0",
          padding: "14px 16px",
          animation: "fadeUp 300ms ease-out",
        }}>
          <p style={{ fontSize: 13, color: "#7C6CFF" }}>Generating guidance...</p>
        </div>
      )}

      {/* Stats row */}
      {launchFlowStep === "live" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 16 }}>
          <div style={{
            background: "#13131F",
            border: "0.5px solid rgba(255,255,255,0.06)",
            borderRadius: 8,
            padding: 12,
            textAlign: "center",
          }}>
            <p style={{ fontSize: 22, fontWeight: 500, color: "#7C6CFF" }}>{questionsCoached}</p>
            <p style={{ fontSize: 10, color: "#4A4A6A", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
              Questions coached
            </p>
          </div>
          <div style={{
            background: "#13131F",
            border: "0.5px solid rgba(255,255,255,0.06)",
            borderRadius: 8,
            padding: 12,
            textAlign: "center",
          }}>
            <p style={{ fontSize: 22, fontWeight: 500, color: "#2DD4BF" }}>{avgResponseTime}</p>
            <p style={{ fontSize: 10, color: "#4A4A6A", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
              Avg response
            </p>
          </div>
          <div style={{
            background: "#13131F",
            border: "0.5px solid rgba(255,255,255,0.06)",
            borderRadius: 8,
            padding: 12,
            textAlign: "center",
          }}>
            <p style={{ fontSize: 22, fontWeight: 500, color: "#FBBF24" }}>{Math.max(0, 10 - questionsCoached)}</p>
            <p style={{ fontSize: 10, color: "#4A4A6A", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
              Remaining
            </p>
          </div>
        </div>
      )}

      {/* Transcript panel */}
      <div style={{
        marginTop: 16,
        background: "#13131F",
        border: "0.5px solid rgba(255,255,255,0.06)",
        borderRadius: 10,
        padding: 14,
      }}>
        <p style={{
          fontSize: 10, fontWeight: 500, textTransform: "uppercase",
          letterSpacing: "0.08em", color: "#4A4A6A", marginBottom: 10,
        }}>
          Live Transcript
        </p>
        {transcriptSegments.length > 0 || draftSegment ? (
          <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {transcriptSegments.map((segment) => {
              const speaker = getSpeakerDisplay(segment.speakerId);
              const isLatest = segment.id === latestSegmentId;
              const isQuestionSegment = questionSegmentIds.has(segment.id);
              return (
                <div
                  key={segment.id}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: isQuestionSegment ? "#FBBF24" : "#9090C0",
                    background: isQuestionSegment ? "rgba(251,191,36,0.06)" : "rgba(255,255,255,0.02)",
                    borderLeft: isLatest ? "2px solid #4F46E5" : "2px solid transparent",
                  }}
                >
                  {speaker && (
                    <span style={{
                      fontSize: 10, fontWeight: 500, textTransform: "uppercase",
                      letterSpacing: "0.06em", color: speaker.label === "Them" ? "#2DD4BF" : "#7070A0",
                      marginRight: 6,
                    }}>
                      {speaker.label}
                    </span>
                  )}
                  {segment.text}
                </div>
              );
            })}
            {draftSegment && (
              <div style={{
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                color: "#5050A0",
                fontStyle: "italic",
                background: "rgba(255,255,255,0.01)",
              }}>
                {draftSegment}
              </div>
            )}
          </div>
        ) : transcriptionWorkflow.status === "failed" ? (
          <p style={{ fontSize: 12, color: "#EF4444" }}>Transcription unavailable. Retrying...</p>
        ) : (
          <p style={{ fontSize: 12, color: "#5050A0" }}>No speech detected yet.</p>
        )}
      </div>
    </div>
  );
}
