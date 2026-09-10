"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranscriptionWorkflow } from "@/features/transcription/use-transcription-workflow";
import type { InterviewIntent } from "@/lib/contracts/interview";
import {
  createCreateOrResumeSessionRequestInit,
  getCreateOrResumeSessionEndpointUrl,
} from "@/lib/contracts/session-execution-client";
import type { SessionExecutionId } from "@/lib/contracts/session-execution";
import { usePilotRealtimeConnection } from "@/lib/realtime/use-pilot-realtime";

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
  headline?: string;
  speakNow?: string;
  keyPoints?: string[];
  caution?: string | null;
  followUp?: string | null;
  gist: string;
  key_points: string[];
  full_answer: string;
};

const GUIDANCE_CONTEXT_CHAR_LIMIT = 1_200;
const FREE_SESSION_LIMIT = 10;
const SESSION_COUNT_STORAGE_KEY = "cnp_session_count";
const ONBOARDING_STORAGE_KEY = "cnp_onboarding_done";
const INTERVIEW_CONTEXT_STORAGE_KEY = "cnp_interview_context_v1";
const FALLBACK_GIST = "That's a great question. Let me take a moment to walk you through my thinking on that.";
const FALLBACK_GUIDANCE: GuidanceData = {
  headline: "Answer with structure",
  speakNow: "Let me frame this around the problem, tradeoffs, and practical next step.",
  keyPoints: ["Clarify scope", "Explain tradeoffs", "Close with impact"],
  caution: null,
  followUp: null,
  gist: FALLBACK_GIST,
  key_points: [],
  full_answer: "",
};

type InterviewContextDraft = {
  resumeText: string;
  jobDescriptionText: string;
  companyContext: string;
  interviewNotes: string;
};

const EMPTY_INTERVIEW_CONTEXT_DRAFT: InterviewContextDraft = {
  resumeText: "",
  jobDescriptionText: "",
  companyContext: "",
  interviewNotes: "",
};

const INITIAL_CAPTURE_STATE: LaunchCaptureState = {
  status: "idle",
  detail: "Share a tab with audio to start live transcription.",
  streamId: null,
};

function createStableId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readStoredNumber(key: string): number {
  if (typeof window === "undefined") return 0;
  const value = Number.parseInt(window.localStorage.getItem(key) || "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
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
  const context = segments
    .slice(-limit)
    .map((segment, index) => {
      const speaker = segment.speakerId === 0 ? "Them" : segment.speakerId === 1 ? "You" : "Unknown";
      return `Segment ${index + 1} (${speaker}): ${segment.text.trim()}`;
    })
    .join("\n");
  return context.slice(-GUIDANCE_CONTEXT_CHAR_LIMIT);
}

function getParsedResumeBackground(): string {
  if (typeof window === "undefined") return "";
  const raw = window.localStorage.getItem("cnp_parsed_resume");
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contact = typeof parsed.contact === "object" && parsed.contact !== null
      ? (parsed.contact as Record<string, unknown>)
      : {};
    const name =
      typeof parsed.name === "string"
        ? parsed.name
        : typeof parsed.fullName === "string"
          ? parsed.fullName
          : typeof contact.name === "string"
            ? contact.name
            : "";
    const title =
      typeof parsed.title === "string"
        ? parsed.title
        : typeof parsed.headline === "string"
          ? parsed.headline
          : typeof parsed.currentTitle === "string"
            ? parsed.currentTitle
            : "";
    const skillSource =
      Array.isArray(parsed.skills)
        ? parsed.skills
        : Array.isArray(parsed.topSkills)
          ? parsed.topSkills
          : [];
    const skills = skillSource
      .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
      .slice(0, 3)
      .map((skill) => skill.trim());

    const identity = [name, title].filter(Boolean).join(", ");
    if (!identity && skills.length === 0) return "";
    return `User background: ${identity || "Candidate"}. Skills: ${skills.join(", ") || "not provided"}.`;
  } catch {
    return "";
  }
}

function readStoredInterviewContextDraft(): InterviewContextDraft {
  if (typeof window === "undefined") return EMPTY_INTERVIEW_CONTEXT_DRAFT;
  const raw = window.localStorage.getItem(INTERVIEW_CONTEXT_STORAGE_KEY);
  if (!raw) return EMPTY_INTERVIEW_CONTEXT_DRAFT;
  try {
    const parsed = JSON.parse(raw) as Partial<InterviewContextDraft>;
    return {
      resumeText: typeof parsed.resumeText === "string" ? parsed.resumeText : "",
      jobDescriptionText:
        typeof parsed.jobDescriptionText === "string" ? parsed.jobDescriptionText : "",
      companyContext: typeof parsed.companyContext === "string" ? parsed.companyContext : "",
      interviewNotes: typeof parsed.interviewNotes === "string" ? parsed.interviewNotes : "",
    };
  } catch {
    return EMPTY_INTERVIEW_CONTEXT_DRAFT;
  }
}

function writeStoredInterviewContextDraft(draft: InterviewContextDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(INTERVIEW_CONTEXT_STORAGE_KEY, JSON.stringify(draft));
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
    const rawKeyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints : parsed.key_points;
    if (typeof parsed.gist === "string" && Array.isArray(rawKeyPoints) && typeof parsed.full_answer === "string") {
      return {
        headline: typeof parsed.headline === "string" ? parsed.headline : undefined,
        speakNow: typeof parsed.speakNow === "string" ? parsed.speakNow : undefined,
        keyPoints: rawKeyPoints.filter((p): p is string => typeof p === "string"),
        caution: typeof parsed.caution === "string" ? parsed.caution : null,
        followUp: typeof parsed.followUp === "string" ? parsed.followUp : null,
        gist: parsed.gist,
        key_points: rawKeyPoints.filter((p): p is string => typeof p === "string"),
        full_answer: parsed.full_answer,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function getLiveIndicatorState(params: {
  guidanceStatus: "idle" | "loading" | "ready" | "failed";
  preferredDetectedQuestion: string;
  answerReadyVisible: boolean;
}) {
  if (params.guidanceStatus === "loading") {
    return {
      color: "#FBBF24",
      shadow: "rgba(251,191,36,0.5)",
      label: "Question detected — generating answer...",
    };
  }
  if (params.answerReadyVisible && (params.guidanceStatus === "ready" || params.guidanceStatus === "failed")) {
    return {
      color: "#7C6CFF",
      shadow: "rgba(124,108,255,0.5)",
      label: "Answer ready",
    };
  }
  if (params.guidanceStatus === "ready" || params.guidanceStatus === "failed") {
    return {
      color: "#10B981",
      shadow: "rgba(16,185,129,0.5)",
      label: "Listening...",
    };
  }
  if (params.preferredDetectedQuestion) {
    return {
      color: "#FBBF24",
      shadow: "rgba(251,191,36,0.5)",
      label: "Question detected — generating answer...",
    };
  }
  return {
    color: "#10B981",
    shadow: "rgba(16,185,129,0.5)",
    label: "Listening...",
  };
}

function getRealtimeStatusLabel(state: ReturnType<typeof usePilotRealtimeConnection>["state"]) {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "authenticating":
      return "Authenticating";
    case "reconnecting":
      return "Reconnecting";
    case "ready":
      return "Realtime connected";
    case "closed":
      return "Disconnected";
    case "error":
      return "Connection error";
    case "idle":
    default:
      return "Disconnected";
  }
}

function getRealtimeStatusColor(state: ReturnType<typeof usePilotRealtimeConnection>["state"]) {
  switch (state) {
    case "ready":
      return "#2DD4BF";
    case "connecting":
    case "authenticating":
    case "reconnecting":
      return "#FBBF24";
    case "error":
      return "#EF4444";
    case "closed":
    case "idle":
    default:
      return "#7070A0";
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
  const lastRealtimeTranscriptSegmentIdRef = useRef<string>("");
  const captureStartedAtRef = useRef<number | null>(null);
  const firstTranscriptAtRef = useRef<number | null>(null);
  const lastGuidanceStartedAtRef = useRef<number | null>(null);
  const sessionExecutionIdRef = useRef<SessionExecutionId | null>(null);
  const transcriptionWorkflow = useTranscriptionWorkflow({ repositoryMode: "local-only" });
  const realtimeConnection = usePilotRealtimeConnection();

  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceData, setGuidanceData] = useState<GuidanceData | null>(null);
  const [guidanceStatus, setGuidanceStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [questionsCoached, setQuestionsCoached] = useState(0);
  const [sessionStartTime] = useState<number>(Date.now());
  const [streamedFullAnswer, setStreamedFullAnswer] = useState("");
  const [latencySnapshot, setLatencySnapshot] = useState<{
    sttFirstPartialMs: number | null;
    totalFirstGuidanceMs: number | null;
  }>({
    sttFirstPartialMs: null,
    totalFirstGuidanceMs: null,
  });
  const [showCard1, setShowCard1] = useState(false);
  const [showCard2, setShowCard2] = useState(false);
  const [showCard3, setShowCard3] = useState(false);
  const [answerReadyVisible, setAnswerReadyVisible] = useState(false);
  const [freeSessionCount, setFreeSessionCount] = useState(0);
  const [onboardingDone, setOnboardingDone] = useState(true);
  const [interviewContextDraft, setInterviewContextDraft] =
    useState<InterviewContextDraft>(EMPTY_INTERVIEW_CONTEXT_DRAFT);

  const stopTranscriptionCapture = transcriptionWorkflow.stopCapture;
  const startTranscriptionCapture = transcriptionWorkflow.startCapture;
  const isFreeLimitReached = freeSessionCount >= FREE_SESSION_LIMIT;

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

  const showFallbackGuidance = useCallback(() => {
    setGuidanceData(FALLBACK_GUIDANCE);
    setGuidanceText(JSON.stringify(FALLBACK_GUIDANCE));
    setStreamedFullAnswer("");
    setShowCard1(true);
    setShowCard2(false);
    setShowCard3(false);
    setGuidanceStatus("failed");
    setAnswerReadyVisible(true);
    window.setTimeout(() => setAnswerReadyVisible(false), 2_000);
  }, []);

  useEffect(() => {
    setFreeSessionCount(readStoredNumber(SESSION_COUNT_STORAGE_KEY));
    setOnboardingDone(window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true");
    setInterviewContextDraft(readStoredInterviewContextDraft());

    return () => {
      cancelActiveGuidanceRequest();
      stopActiveStream();
      stopTranscriptionCapture();
    };
  }, [stopTranscriptionCapture]);

  async function handleStartLiveCopilot() {
    if (typeof window === "undefined") return;
    const currentSessionCount = readStoredNumber(SESSION_COUNT_STORAGE_KEY);
    if (currentSessionCount >= FREE_SESSION_LIMIT) {
      setFreeSessionCount(currentSessionCount);
      return;
    }

    setLaunchFlowStep("requesting");
    setCaptureState({ status: "requesting", detail: "Choose a browser tab and enable tab audio to continue.", streamId: null });
    realtimeConnection.connect();

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

      const nextSessionCount = Math.min(FREE_SESSION_LIMIT, currentSessionCount + 1);
      window.localStorage.setItem(SESSION_COUNT_STORAGE_KEY, String(nextSessionCount));
      setFreeSessionCount(nextSessionCount);

      activeStreamRef.current = stream;
      captureStartedAtRef.current = performance.now();
      firstTranscriptAtRef.current = null;
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
    realtimeConnection.endSession();
    stopTranscriptionCapture();
    stopActiveStream();
    lastAutoGuidanceQuestionRef.current = "";
    lastRealtimeTranscriptSegmentIdRef.current = "";
    captureStartedAtRef.current = null;
    firstTranscriptAtRef.current = null;
    lastGuidanceStartedAtRef.current = null;
    sessionExecutionIdRef.current = null;
    setGuidanceText("");
    setGuidanceData(null);
    setGuidanceStatus("idle");
    setShowCard1(false);
    setShowCard2(false);
    setShowCard3(false);
    setAnswerReadyVisible(false);
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
    setStreamedFullAnswer("");
    setShowCard1(false);
    setShowCard2(false);
    setShowCard3(false);
    setAnswerReadyVisible(false);

    try {
      const guidanceStartedAt = performance.now();
      lastGuidanceStartedAtRef.current = guidanceStartedAt;
      void ensureSessionExecution();
      const userBackground = getParsedResumeBackground();
      const response = await fetch("/api/generate-guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          question: detectedQuestion,
          transcriptContext: buildTranscriptContext(transcriptionWorkflow.segments),
          interviewMode: inferInterviewIntent(detectedQuestion),
          userBackground,
          resumeText: interviewContextDraft.resumeText || userBackground,
          jobDescriptionText: interviewContextDraft.jobDescriptionText,
          companyContext: [interviewContextDraft.companyContext, interviewContextDraft.interviewNotes]
            .filter(Boolean)
            .join("\n\n"),
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
      if (structured?.gist.trim() === FALLBACK_GIST) {
        showFallbackGuidance();
        return;
      }
      if (structured) {
        setGuidanceData(structured);
        // Staggered card reveal
        setShowCard1(true);
        setTimeout(() => setShowCard2(true), 400);
        setTimeout(() => {
          setShowCard3(true);
          // Simulate streaming the full answer character by character
          let i = 0;
          const fullAnswer = structured.full_answer;
          const streamInterval = setInterval(() => {
            i += 6;
            if (i >= fullAnswer.length) {
              setStreamedFullAnswer(fullAnswer);
              clearInterval(streamInterval);
            } else {
              setStreamedFullAnswer(fullAnswer.slice(0, i));
            }
          }, 8);
        }, 800);
      } else {
        // Fallback: show raw text as full_answer
        setGuidanceData({
          gist: streamedText.split(/[.!?]/)[0]?.trim() || streamedText.slice(0, 80),
          key_points: [],
          full_answer: streamedText,
        });
        setShowCard1(true);
        setTimeout(() => setShowCard3(true), 800);
        setStreamedFullAnswer(streamedText);
      }

      setQuestionsCoached((prev) => prev + 1);
      setGuidanceStatus("ready");
      const totalFirstGuidanceMs =
        captureStartedAtRef.current === null
          ? null
          : Math.round(performance.now() - captureStartedAtRef.current);
      setLatencySnapshot((current) => ({
        ...current,
        totalFirstGuidanceMs,
      }));
      if (totalFirstGuidanceMs !== null) {
        realtimeConnection.sendRuntimeEvent({
          type: "session.metrics",
          clientEventId: createStableId("metrics"),
          metrics: {
            total_first_guidance_ms: totalFirstGuidanceMs,
          },
          timestamp: new Date().toISOString(),
        });
      }
      setAnswerReadyVisible(true);
      window.setTimeout(() => {
        setAnswerReadyVisible(false);
        setGuidanceStatus((current) => current === "ready" ? "idle" : current);
      }, 2_000);
    } catch (error) {
      if (abortController.signal.aborted) return;
      showFallbackGuidance();
    } finally {
      if (guidanceAbortControllerRef.current === abortController) guidanceAbortControllerRef.current = null;
    }
  }, [
    showFallbackGuidance,
    transcriptionWorkflow.aiDetectedQuestion,
    transcriptionWorkflow.latestDetectedQuestion,
    transcriptionWorkflow.segments,
    interviewContextDraft,
    realtimeConnection,
  ]);

  const preferredDetectedQuestion =
    transcriptionWorkflow.aiDetectedQuestion || transcriptionWorkflow.latestDetectedQuestion;
  const liveIndicator = getLiveIndicatorState({
    guidanceStatus,
    preferredDetectedQuestion,
    answerReadyVisible,
  });
  const transcriptSegments = transcriptionWorkflow.segments;
  const draftSegment = transcriptionWorkflow.draftSegment;
  const latestSegmentId = transcriptSegments.at(-1)?.id ?? null;

  useEffect(() => {
    if (launchFlowStep !== "live") return;
    const latestSegment = transcriptSegments.at(-1);
    if (!latestSegment || latestSegment.id === lastRealtimeTranscriptSegmentIdRef.current) return;
    lastRealtimeTranscriptSegmentIdRef.current = latestSegment.id;

    if (firstTranscriptAtRef.current === null && captureStartedAtRef.current !== null) {
      const sttFirstPartialMs = Math.round(performance.now() - captureStartedAtRef.current);
      firstTranscriptAtRef.current = performance.now();
      setLatencySnapshot((current) => ({
        ...current,
        sttFirstPartialMs,
      }));
      realtimeConnection.sendRuntimeEvent({
        type: "session.metrics",
        clientEventId: createStableId("metrics"),
        metrics: {
          stt_first_partial_ms: sttFirstPartialMs,
        },
        timestamp: new Date().toISOString(),
      });
    }

    realtimeConnection.sendRuntimeEvent({
      type: "transcript.final",
      clientEventId: latestSegment.id,
      text: latestSegment.text,
      source: latestSegment.source,
      timestamp: new Date(latestSegment.createdAt).toISOString(),
    });
  }, [launchFlowStep, realtimeConnection, transcriptSegments]);

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
    realtimeConnection.sendRuntimeEvent({
      type: "question.detected",
      clientEventId: createStableId("question-event"),
      questionId: createStableId("question"),
      normalizedQuestion: detectedQuestion,
      category: inferInterviewIntent(detectedQuestion),
      confidence: 0.72,
      timestamp: new Date().toISOString(),
    });
    void handleGetGuidance();
  }, [guidanceStatus, handleGetGuidance, launchFlowStep, preferredDetectedQuestion, realtimeConnection]);

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
  const realtimeStatusLabel = getRealtimeStatusLabel(realtimeConnection.state);
  const realtimeStatusColor = getRealtimeStatusColor(realtimeConnection.state);

  /* ================================================================
     RENDER — IDLE STATE (two mode cards)
     ================================================================ */
  if (launchFlowStep !== "live") {
    return (
      <div>
        <div style={{
          alignItems: "center",
          color: realtimeStatusColor,
          display: "inline-flex",
          fontSize: 12,
          gap: 7,
          marginBottom: 12,
        }}>
          <span style={{
            background: realtimeStatusColor,
            borderRadius: "50%",
            display: "inline-block",
            height: 7,
            width: 7,
          }} />
          {realtimeStatusLabel}
        </div>

        {!onboardingDone && freeSessionCount === 0 && (
          <div style={{
            background: "#13131F",
            border: "0.5px solid rgba(124,108,255,0.22)",
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 14,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
          }}>
            <p style={{ fontSize: 12, lineHeight: 1.6, color: "#A0A0C0" }}>
              1. Pick your audio source · 2. Join your interview call · 3. Answers appear here automatically
            </p>
            <button
              type="button"
              onClick={() => {
                window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
                setOnboardingDone(true);
              }}
              style={{
                background: "transparent",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 6,
                color: "#7C6CFF",
                cursor: "pointer",
                fontSize: 11,
                padding: "5px 9px",
                whiteSpace: "nowrap",
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {isFreeLimitReached ? (
          <div style={{
            background: "#13131F",
            border: "0.5px solid rgba(251,191,36,0.28)",
            borderRadius: 10,
            padding: 18,
          }}>
            <p style={{ fontSize: 16, fontWeight: 500, color: "#F0F0FF", marginBottom: 6 }}>
              You've used all 10 free sessions
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: "#A0A0C0", marginBottom: 14 }}>
              Upgrade to keep using live interview guidance. Your past transcripts stay available.
            </p>
            <a
              href="/pricing"
              style={{
                background: "#4F46E5",
                borderRadius: 8,
                color: "white",
                display: "inline-flex",
                fontSize: 13,
                fontWeight: 500,
                padding: "9px 14px",
                textDecoration: "none",
              }}
            >
              View pricing
            </a>
          </div>
        ) : (
          <>
        <div style={{
          background: "#13131F",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          marginBottom: 14,
          padding: 14,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: "#E0E0FF" }}>Session Context</p>
              <p style={{ fontSize: 11, color: "#7070A0", lineHeight: 1.5 }}>
                Paste resume, role, and notes before capture. Stored locally in this browser.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setInterviewContextDraft(EMPTY_INTERVIEW_CONTEXT_DRAFT);
                writeStoredInterviewContextDraft(EMPTY_INTERVIEW_CONTEXT_DRAFT);
              }}
              style={{
                background: "transparent",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 6,
                color: "#7070A0",
                cursor: "pointer",
                fontSize: 11,
                padding: "5px 9px",
                whiteSpace: "nowrap",
              }}
            >
              Clear
            </button>
          </div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
            <textarea
              aria-label="Resume text"
              placeholder="Resume highlights, achievements, certifications..."
              value={interviewContextDraft.resumeText}
              onChange={(event) => {
                const next = { ...interviewContextDraft, resumeText: event.target.value };
                setInterviewContextDraft(next);
                writeStoredInterviewContextDraft(next);
              }}
              style={{
                background: "#0D0D1A",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                color: "#DCDCFF",
                fontSize: 12,
                minHeight: 86,
                padding: 10,
                resize: "vertical",
              }}
            />
            <textarea
              aria-label="Job description"
              placeholder="Job description, required skills, interview focus..."
              value={interviewContextDraft.jobDescriptionText}
              onChange={(event) => {
                const next = { ...interviewContextDraft, jobDescriptionText: event.target.value };
                setInterviewContextDraft(next);
                writeStoredInterviewContextDraft(next);
              }}
              style={{
                background: "#0D0D1A",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                color: "#DCDCFF",
                fontSize: 12,
                minHeight: 86,
                padding: 10,
                resize: "vertical",
              }}
            />
            <input
              aria-label="Company context"
              placeholder="Company, team, cloud stack"
              value={interviewContextDraft.companyContext}
              onChange={(event) => {
                const next = { ...interviewContextDraft, companyContext: event.target.value };
                setInterviewContextDraft(next);
                writeStoredInterviewContextDraft(next);
              }}
              style={{
                background: "#0D0D1A",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                color: "#DCDCFF",
                fontSize: 12,
                padding: "9px 10px",
              }}
            />
            <input
              aria-label="Interview notes"
              placeholder="Interviewer notes, constraints, topics"
              value={interviewContextDraft.interviewNotes}
              onChange={(event) => {
                const next = { ...interviewContextDraft, interviewNotes: event.target.value };
                setInterviewContextDraft(next);
                writeStoredInterviewContextDraft(next);
              }}
              style={{
                background: "#0D0D1A",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                color: "#DCDCFF",
                fontSize: 12,
                padding: "9px 10px",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {interviewContextDraft.resumeText.trim() && (
              <span style={{ border: "0.5px solid rgba(45,212,191,0.3)", borderRadius: 999, color: "#2DD4BF", fontSize: 10, padding: "4px 8px" }}>
                Resume loaded
              </span>
            )}
            {interviewContextDraft.jobDescriptionText.trim() && (
              <span style={{ border: "0.5px solid rgba(251,191,36,0.3)", borderRadius: 999, color: "#FBBF24", fontSize: 10, padding: "4px 8px" }}>
                Job loaded
              </span>
            )}
            {interviewContextDraft.companyContext.trim() && (
              <span style={{ border: "0.5px solid rgba(124,108,255,0.3)", borderRadius: 999, color: "#7C6CFF", fontSize: 10, padding: "4px 8px" }}>
                Company loaded
              </span>
            )}
          </div>
        </div>
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
          </>
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
              width: 8, height: 8, borderRadius: "50%", background: liveIndicator.color,
              boxShadow: `0 0 8px ${liveIndicator.shadow}`,
              display: "inline-block",
              animation: "blink 2s ease-in-out infinite",
            }} />
            <span style={{ fontSize: 13, color: "#A0A0C0" }}>{liveIndicator.label}</span>
          </div>
          <div style={{
            alignItems: "center",
            color: realtimeStatusColor,
            display: "inline-flex",
            fontSize: 11,
            gap: 6,
            marginTop: 6,
          }}>
            <span style={{
              background: realtimeStatusColor,
              borderRadius: "50%",
              display: "inline-block",
              height: 6,
              width: 6,
            }} />
            {realtimeStatusLabel}
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

      {transcriptionWorkflow.feedback === "Connection unstable — retrying..." && (
        <div style={{
          background: "rgba(251,191,36,0.08)",
          border: "0.5px solid rgba(251,191,36,0.35)",
          borderRadius: 8,
          color: "#FBBF24",
          fontSize: 12,
          marginBottom: 12,
          padding: "8px 10px",
        }}>
          Connection unstable — retrying...
        </div>
      )}

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
                {guidanceData.speakNow || guidanceData.gist}
              </p>
            </div>
          )}

          {/* Card 2 — HIT THESE POINTS (teal) */}
          {showCard2 && (guidanceData.keyPoints ?? guidanceData.key_points).length > 0 && (
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
                {(guidanceData.keyPoints ?? guidanceData.key_points).map((point, i) => (
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
              {(guidanceData.caution || guidanceData.followUp) && (
                <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                  {guidanceData.caution && (
                    <p style={{ color: "#FBBF24", fontSize: 11, lineHeight: 1.5 }}>
                      Caution: {guidanceData.caution}
                    </p>
                  )}
                  {guidanceData.followUp && (
                    <p style={{ color: "#2DD4BF", fontSize: 11, lineHeight: 1.5 }}>
                      Follow-up: {guidanceData.followUp}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {guidanceStatus === "failed" && guidanceData && (
        <button
          type="button"
          onClick={() => void handleGetGuidance()}
          style={{
            marginTop: 10,
            background: "rgba(251,191,36,0.08)",
            border: "0.5px solid rgba(251,191,36,0.35)",
            borderRadius: 6,
            color: "#FBBF24",
            cursor: "pointer",
            fontSize: 11,
            padding: "5px 10px",
          }}
        >
          Try again
        </button>
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
            <p style={{ fontSize: 22, fontWeight: 500, color: "#FBBF24" }}>{Math.max(0, FREE_SESSION_LIMIT - freeSessionCount)}</p>
            <p style={{ fontSize: 10, color: "#4A4A6A", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
              Remaining
            </p>
          </div>
        </div>
      )}

      {launchFlowStep === "live" && (
        <div style={{
          background: "#13131F",
          border: "0.5px solid rgba(255,255,255,0.06)",
          borderRadius: 8,
          color: "#7070A0",
          display: "flex",
          flexWrap: "wrap",
          fontSize: 11,
          gap: 10,
          marginTop: 8,
          padding: "8px 10px",
        }}>
          <span>STT first partial: {latencySnapshot.sttFirstPartialMs === null ? "--" : `${latencySnapshot.sttFirstPartialMs}ms`}</span>
          <span>First guidance: {latencySnapshot.totalFirstGuidanceMs === null ? "--" : `${latencySnapshot.totalFirstGuidanceMs}ms`}</span>
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
