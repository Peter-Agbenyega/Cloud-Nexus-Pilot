"use client";

import { recordGuidanceTiming, formatGuidanceTiming, describeSaveAcknowledgement, type GuidanceTiming } from "@/lib/guidance-latency";

import { capturePresentation } from "@/features/transcription/capture-recovery";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureDisclosure } from "./capture-disclosure";
import { CopilotReadingPanels } from "./copilot-reading-panels";
import workspaceStyles from "./copilot-workspace.module.css";
import { SavedSessionPicker } from "./saved-session-picker";
import { captureFailureMessage } from "@/features/transcription/audio-capture";

import { requestOwnedGuidance, readFinalGuidance } from "@/features/transcription/guidance-session-client";
import { useTranscriptionWorkflow } from "@/features/transcription/use-transcription-workflow";
import { detectedQuestionKey, shouldReplaceDetectedQuestion } from "@/features/transcription/question-selection";
import type { InterviewIntent } from "@/lib/contracts/interview";
import {
  createCreateOrResumeSessionRequestInit,
  getCreateOrResumeSessionEndpointUrl,
} from "@/lib/contracts/session-execution-client";
import type { SessionExecutionId } from "@/lib/contracts/session-execution";
import {
  createInterviewPersistenceRepository,
  type InterviewPersistenceInfo,
  type PersistedInterviewSession,
} from "@/lib/interview-persistence";
import { createScreenContextFromText } from "@/lib/interview-intelligence/screen-context";
import { CaptureOwnership } from "@/lib/realtime/capture-ownership";
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


type InterviewContextDraft = {
  resumeText: string;
  jobDescriptionText: string;
  companyContext: string;
  interviewNotes: string;
  screenContextText: string;
};

const EMPTY_INTERVIEW_CONTEXT_DRAFT: InterviewContextDraft = {
  resumeText: "",
  jobDescriptionText: "",
  companyContext: "",
  interviewNotes: "",
  screenContextText: "",
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
      screenContextText:
        typeof parsed.screenContextText === "string" ? parsed.screenContextText : "",
    };
  } catch {
    return EMPTY_INTERVIEW_CONTEXT_DRAFT;
  }
}

function writeStoredInterviewContextDraft(draft: InterviewContextDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(INTERVIEW_CONTEXT_STORAGE_KEY, JSON.stringify(draft));
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
  if (params.guidanceStatus === "failed") {
    return {
      color: "#FBBF24",
      shadow: "rgba(251,191,36,0.5)",
      label: "Guidance unavailable — local fallback tip",
    };
  }
  if (params.answerReadyVisible && params.guidanceStatus === "ready") {
    return {
      color: "#7C6CFF",
      shadow: "rgba(124,108,255,0.5)",
      label: "Answer ready",
    };
  }
  if (params.guidanceStatus === "ready") {
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
  const captureOwnershipRef = useRef(new CaptureOwnership());
  const mountedRef = useRef(false);
  const guidanceAbortControllerRef = useRef<AbortController | null>(null);
  const activeGuidanceQuestionRef = useRef<{ question: string; source: "typed" | "detected" } | null>(null);
  const previousCaptureStateRef = useRef({ recording: false, paused: false });
  const lastAutoGuidanceQuestionRef = useRef<string>("");
  const lastRealtimeTranscriptSegmentIdRef = useRef<string>("");
  const activeInterviewSessionRef = useRef<PersistedInterviewSession | null>(null);
  const interviewSessionGenerationRef = useRef(0);
  const interviewSessionPromiseRef = useRef<Promise<PersistedInterviewSession | null> | null>(null);
  const lastPersistedDetectedQuestionIdRef = useRef<string | null>(null);
  const captureStartedAtRef = useRef<number | null>(null);
  const firstTranscriptAtRef = useRef<number | null>(null);
  const firstCaptureGuidanceAtRef = useRef<number | null>(null);
  const sessionExecutionIdRef = useRef<SessionExecutionId | null>(null);
  const transcriptionWorkflow = useTranscriptionWorkflow({ repositoryMode: "local-only" });
  const realtimeConnection = usePilotRealtimeConnection();
  const interviewPersistenceRepository = useMemo(() => createInterviewPersistenceRepository(), []);

  const [typedQuestion, setTypedQuestion] = useState("");
  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceQuestion, setGuidanceQuestion] = useState("");
  const [guidancePreview, setGuidancePreview] = useState("");
  const [firstAnswerMs, setFirstAnswerMs] = useState<number | null>(null);
  const [guidanceError, setGuidanceError] = useState("");
  const [guidanceData, setGuidanceData] = useState<GuidanceData | null>(null);
  const [guidanceStatus, setGuidanceStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [questionsCoached, setQuestionsCoached] = useState(0);
  const [guidanceTiming, setGuidanceTiming] = useState<GuidanceTiming>({ completed: 0, totalMs: 0 });
  const syntheticMode = process.env.NEXT_PUBLIC_PILOT_TEST_FIXTURE === "1";

  const [latencySnapshot, setLatencySnapshot] = useState<{
    sttFirstPartialMs: number | null;
    totalFirstGuidanceMs: number | null;
  }>({
    sttFirstPartialMs: null,
    totalFirstGuidanceMs: null,
  });



  const [answerReadyVisible, setAnswerReadyVisible] = useState(false);
  const [freeSessionCount, setFreeSessionCount] = useState(0);
  const [onboardingDone, setOnboardingDone] = useState(true);
  const [interviewContextDraft, setInterviewContextDraft] =
    useState<InterviewContextDraft>(EMPTY_INTERVIEW_CONTEXT_DRAFT);
  const [interviewPersistenceInfo, setInterviewPersistenceInfo] =
    useState<InterviewPersistenceInfo | null>(null);
  const [contextUploadStatus, setContextUploadStatus] = useState("");

  const stopTranscriptionCapture = transcriptionWorkflow.stopCapture;
  const startTranscriptionCapture = transcriptionWorkflow.startCapture;
  const isFreeLimitReached = freeSessionCount >= FREE_SESSION_LIMIT;

  async function handleContextFileUpload(file: File | null, kind: "resume" | "job-description") {
    if (!file) return;
    setContextUploadStatus(`Extracting ${file.name}...`);
    const formData = new FormData();
    formData.set("file", file);
    formData.set("kind", kind);

    try {
      const response = await fetch("/api/ingest-profile", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        extractedText?: unknown;
        message?: unknown;
      };
      if (!response.ok || typeof payload.extractedText !== "string") {
        throw new Error(
          typeof payload.message === "string"
            ? payload.message
            : "Could not extract readable text from that file."
        );
      }
      const next =
        kind === "resume"
          ? { ...interviewContextDraft, resumeText: payload.extractedText }
          : { ...interviewContextDraft, jobDescriptionText: payload.extractedText };
      setInterviewContextDraft(next);
      writeStoredInterviewContextDraft(next);
      setContextUploadStatus(`${kind === "resume" ? "Resume" : "Job description"} extracted from ${file.name}.`);
    } catch (error) {
      setContextUploadStatus(
        error instanceof Error ? error.message : "File ingestion failed."
      );
    }
  }

  const ensureSessionExecution = useCallback(async function ensureSessionExecution(): Promise<SessionExecutionId | null> {
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
  }, []);

  const ensureInterviewSession = useCallback(async function ensureInterviewSession(): Promise<PersistedInterviewSession | null> {
    if (activeInterviewSessionRef.current) return activeInterviewSessionRef.current;

    if (interviewSessionPromiseRef.current) return interviewSessionPromiseRef.current;
    const generation = interviewSessionGenerationRef.current;
    const pending = interviewPersistenceRepository.createSession({
      title: "Live interview session",
      mode: "general",
      resumeText: interviewContextDraft.resumeText,
      jobDescriptionText: interviewContextDraft.jobDescriptionText,
      companyContext: interviewContextDraft.companyContext,
      notes: interviewContextDraft.interviewNotes,
    }).then(async ({ data: session, persistence }) => {
      if (generation !== interviewSessionGenerationRef.current || !mountedRef.current) {
        await interviewPersistenceRepository.endSession(session.id);
        return null;
      }
      activeInterviewSessionRef.current = session;
      setInterviewPersistenceInfo(persistence);
      return session;
    }).finally(() => {
      if (interviewSessionPromiseRef.current === pending) interviewSessionPromiseRef.current = null;
    });
    interviewSessionPromiseRef.current = pending;
    return pending;
  }, [interviewContextDraft, interviewPersistenceRepository]);

  function stopActiveStream() {
    activeStreamRef.current?.getTracks().forEach((track) => track.stop());
    activeStreamRef.current = null;
  }

  function cancelActiveGuidanceRequest() {
    guidanceAbortControllerRef.current?.abort();
    guidanceAbortControllerRef.current = null;
  }

  const showFallbackGuidance = useCallback(() => {
    setGuidanceData(null);
    setGuidancePreview("");
    setGuidanceText("");
    setGuidanceStatus("failed");
    setAnswerReadyVisible(true);
    window.setTimeout(() => setAnswerReadyVisible(false), 2_000);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setFreeSessionCount(readStoredNumber(SESSION_COUNT_STORAGE_KEY));
    setOnboardingDone(window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true");
    setInterviewContextDraft(readStoredInterviewContextDraft());

    return () => {
      mountedRef.current = false;
      interviewSessionGenerationRef.current += 1;
      interviewSessionPromiseRef.current = null;
      captureOwnershipRef.current.cancel();
      cancelActiveGuidanceRequest();
      stopActiveStream();
      stopTranscriptionCapture();
    };
  }, [stopTranscriptionCapture]);

  async function handleStartLiveCopilot() {
    if (typeof window === "undefined" || !mountedRef.current) return;
    const currentSessionCount = readStoredNumber(SESSION_COUNT_STORAGE_KEY);
    if (currentSessionCount >= FREE_SESSION_LIMIT) {
      setFreeSessionCount(currentSessionCount);
      return;
    }

    const ownership = captureOwnershipRef.current;
    const token = ownership.begin();
    if (token === null) return;

    setLaunchFlowStep("requesting");
    setCaptureState({ status: "requesting", detail: "Choose a browser tab and enable tab audio to continue.", streamId: null });
    realtimeConnection.connect();

    try {
      stopTranscriptionCapture();
      stopActiveStream();

      let stream: MediaStream;

      if (audioMode === "tab-audio") {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        if (!ownership.adopt(token, stream)) return;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          await handleEndSession();
          setCaptureState({ status: "failed", detail: "Please select a tab and enable audio to start.", streamId: null });
          setLaunchFlowStep("ready");
          return;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!ownership.adopt(token, stream)) return;
      }

      setGuidanceQuestion(""); setGuidanceData(null); setGuidancePreview(""); setFirstAnswerMs(null);
      activeStreamRef.current = stream;
      captureStartedAtRef.current = performance.now();
      firstCaptureGuidanceAtRef.current = null;
      setLatencySnapshot({ sttFirstPartialMs: null, totalFirstGuidanceMs: null });
      firstTranscriptAtRef.current = null;
      setCaptureState({ status: "live-stream-confirmed", detail: "Live audio connected. Starting transcription...", streamId: stream.id });
      setLaunchFlowStep("live");
      void ensureInterviewSession().catch(() => {
        if (!mountedRef.current || !ownership.isCurrent(token)) return;
        setInterviewPersistenceInfo({
          mode: "local",
          note: "Interview session could not be saved. Live capture remains available.",
          cloudSyncReady: false,
          authState: "signed-out-local",
          userEmail: null,
        });
      });

      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => { void handleEndSession(); }, { once: true });
      });

      const started = await startTranscriptionCapture({
        existingStream: stream,
        source: audioMode === "tab-audio" ? "system-audio" : "microphone",
      });
      if (!ownership.isCurrent(token)) {
        stopTranscriptionCapture();
        return;
      }
      if (!started) {
        throw new Error("Transcription could not start.");
      }
      const nextSessionCount = Math.min(FREE_SESSION_LIMIT, currentSessionCount + 1);
      window.localStorage.setItem(SESSION_COUNT_STORAGE_KEY, String(nextSessionCount));
      setFreeSessionCount(nextSessionCount);

      void ensureSessionExecution();
    } catch (error) {
      if (!ownership.isCurrent(token)) return;
      await handleEndSession();
      setCaptureState({
        status: "failed",
        detail: captureFailureMessage(error),
        streamId: null,
      });
      setLaunchFlowStep("ready");
    } finally {
      ownership.finish(token);
    }
  }

  async function handleEndSession() {
    interviewSessionGenerationRef.current += 1;
    interviewSessionPromiseRef.current = null;
    captureOwnershipRef.current.cancel();
    cancelActiveGuidanceRequest();
    realtimeConnection.endSession();
    const activeInterviewSession = activeInterviewSessionRef.current;
    if (activeInterviewSession) {
      interviewPersistenceRepository
        .endSession(activeInterviewSession.id)
        .then(({ persistence }) => setInterviewPersistenceInfo(persistence))
        .catch(() => {
          setInterviewPersistenceInfo({
            mode: "local",
            note: "Interview session end could not be synced. The live workspace has stopped safely.",
            cloudSyncReady: false,
            authState: "signed-out-local",
            userEmail: null,
          });
        });
    }
    stopTranscriptionCapture();
    stopActiveStream();
    lastAutoGuidanceQuestionRef.current = "";
    lastRealtimeTranscriptSegmentIdRef.current = "";
    activeInterviewSessionRef.current = null;
    lastPersistedDetectedQuestionIdRef.current = null;
    captureStartedAtRef.current = null;
    firstTranscriptAtRef.current = null;
    firstCaptureGuidanceAtRef.current = null;
    sessionExecutionIdRef.current = null;
    setGuidanceText("");
    setGuidanceData(null);
    setGuidanceStatus("idle");
    setAnswerReadyVisible(false);
    activeGuidanceQuestionRef.current = null;
    setGuidanceQuestion("");
    setGuidancePreview("");
    setFirstAnswerMs(null);
    setCaptureState({ status: "idle", detail: "Session ended.", streamId: null });
    setLaunchFlowStep("ready");
  }

  const preferredDetectedQuestion = transcriptionWorkflow.preferredDetectedQuestion;

  const handleGetGuidance = useCallback(async function handleGetGuidance(typedOverride?: string) {
    const detectedQuestion = (typedOverride?.trim() ||
      preferredDetectedQuestion.trim()).slice(0, 500);
    if (!detectedQuestion || (!typedOverride && detectedQuestion.length < 10)) return;

    cancelActiveGuidanceRequest();
    const abortController = new AbortController();
    guidanceAbortControllerRef.current = abortController;
    const guidanceIdentity = { question: detectedQuestion, source: typedOverride ? "typed" as const : "detected" as const };
    activeGuidanceQuestionRef.current = guidanceIdentity;

    setGuidanceQuestion(detectedQuestion);
    setGuidancePreview("");
    setFirstAnswerMs(null);
    setGuidanceStatus("loading");
    setGuidanceError("");
    setGuidanceText("");
    setGuidanceData(null);
    setAnswerReadyVisible(false);

    try {
      const guidanceStartedAt = performance.now();
      void ensureSessionExecution();
      const userBackground = getParsedResumeBackground();
      const { sessionId: ownedSessionId, response, signal: guidanceSignal } = await requestOwnedGuidance({
        question: detectedQuestion,
        segments: transcriptionWorkflow.segments,
        ensureSession: transcriptionWorkflow.ensureServerSession,
        signal: abortController.signal,
        body: {
          transcriptContext: buildTranscriptContext(transcriptionWorkflow.segments),
          interviewMode: inferInterviewIntent(detectedQuestion),
          userBackground,
          resumeText: interviewContextDraft.resumeText || userBackground,
          jobDescriptionText: interviewContextDraft.jobDescriptionText,
          companyContext: [interviewContextDraft.companyContext, interviewContextDraft.interviewNotes].filter(Boolean).join("\n\n"),
          screenText: interviewContextDraft.screenContextText,
        },
      });

      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(failure?.error?.message || "Live guidance is unavailable right now.");
      }
      if (!response.body) throw new Error("Live guidance is unavailable right now.");

      let firstVisibleAt: number | null = null;
      const finalGuidanceText = await readFinalGuidance(response, guidanceSignal, {
        onPreview: (text) => {
          if (abortController.signal.aborted || guidanceAbortControllerRef.current !== abortController) return;
          setGuidancePreview(text);
          if (text.trim().length >= 40 && firstVisibleAt === null) {
            firstVisibleAt = performance.now();
            setFirstAnswerMs(Math.round(firstVisibleAt - guidanceStartedAt));
          }
        },
      });
      if (abortController.signal.aborted || guidanceAbortControllerRef.current !== abortController) return;

      // Try to parse structured JSON
      const guidanceParseText = finalGuidanceText;
      const structured = parseGuidanceJson(guidanceParseText);
      let completedGuidance: GuidanceData;
      if (structured?.gist.trim() === FALLBACK_GIST) {
        showFallbackGuidance();
        return;
      }
      if (!structured) throw new Error("The provider did not return a valid completed guidance answer.");
      completedGuidance = structured;
      const guidanceCompletedAt = performance.now();
      const guidanceResponseMs = Math.round(guidanceCompletedAt - guidanceStartedAt);
      setGuidanceTiming(current => recordGuidanceTiming(current, guidanceStartedAt, guidanceCompletedAt));
      setGuidancePreview("");
      if (firstVisibleAt === null) setFirstAnswerMs(guidanceResponseMs);
      setGuidanceData(structured);
      setGuidanceText(finalGuidanceText);
      void transcriptionWorkflow.refreshServerGuidance(ownedSessionId).catch(() => {
        if (!mountedRef.current || abortController.signal.aborted || activeGuidanceQuestionRef.current !== guidanceIdentity) return;
        setGuidanceError("The answer was acknowledged, but saved guidance history could not be refreshed. Try recovery before relying on a reload.");
      });
      if (abortController.signal.aborted || guidanceAbortControllerRef.current !== abortController) return;

      setQuestionsCoached((prev) => prev + 1);
      setGuidanceStatus("ready");
      const totalFirstGuidanceMs =
        captureStartedAtRef.current === null || firstCaptureGuidanceAtRef.current !== null || Boolean(typedOverride)
          ? null
          : Math.round(guidanceCompletedAt - captureStartedAtRef.current);
      if (totalFirstGuidanceMs !== null) firstCaptureGuidanceAtRef.current = guidanceCompletedAt;
      setLatencySnapshot((current) => ({
        ...current,
        totalFirstGuidanceMs: current.totalFirstGuidanceMs ?? totalFirstGuidanceMs,
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
      void ensureInterviewSession()
        .then((session) => {
          if (!session) return null;
          return interviewPersistenceRepository.saveGuidance({
            sessionId: session.id,
            detectedQuestionId: lastPersistedDetectedQuestionIdRef.current,
            guidance: {
              headline: completedGuidance.headline || completedGuidance.gist || "Live guidance",
              speakNow:
                completedGuidance.speakNow ||
                completedGuidance.gist ||
                completedGuidance.full_answer.slice(0, 180),
              keyPoints: completedGuidance.keyPoints ?? completedGuidance.key_points ?? [],
              example: null,
              technicalDetail: completedGuidance.full_answer,
              caution: completedGuidance.caution ?? null,
              followUp: completedGuidance.followUp ?? null,
              provider: "configured-llm",
              model: null,
              latencyMs: guidanceResponseMs,
            },
          });
        })
        .then((result) => {
          if (result?.persistence) setInterviewPersistenceInfo(result.persistence);
        })
        .catch(() => {
          setInterviewPersistenceInfo({
            mode: "local",
            note: "Guidance persistence failed. The answer remained available in the live workspace.",
            cloudSyncReady: false,
            authState: "signed-out-local",
            userEmail: null,
          });
        });
      setAnswerReadyVisible(true);
      window.setTimeout(() => {
        setAnswerReadyVisible(false);
        setGuidanceStatus((current) => current === "ready" ? "idle" : current);
      }, 2_000);
    } catch (error) {
      if (abortController.signal.aborted) return;
      setGuidanceError(error instanceof Error ? error.message : "Live guidance is unavailable right now.");
      showFallbackGuidance();
    } finally {
      if (guidanceAbortControllerRef.current === abortController) guidanceAbortControllerRef.current = null;
    }
  }, [
    showFallbackGuidance,
    preferredDetectedQuestion,
    transcriptionWorkflow.segments,
    transcriptionWorkflow.ensureServerSession,
    transcriptionWorkflow.refreshServerGuidance,
    interviewContextDraft,
    interviewPersistenceRepository,
    ensureInterviewSession,
    ensureSessionExecution,
    realtimeConnection,
  ]);

  useEffect(() => {
    const active = activeGuidanceQuestionRef.current;
    if (guidanceStatus === "loading" && active?.source === "detected" &&
        shouldReplaceDetectedQuestion(active.question, preferredDetectedQuestion)) {
      cancelActiveGuidanceRequest();
      setGuidanceData(null); setGuidanceText(""); setGuidancePreview("");
      setGuidanceStatus("idle");
      setGuidanceError("The question changed; the previous answer was cancelled.");
    }
  }, [preferredDetectedQuestion, guidanceStatus]);
  useEffect(() => {
    const previous = previousCaptureStateRef.current;
    const stopped = previous.recording && !transcriptionWorkflow.isRecording;
    const paused = !previous.paused && transcriptionWorkflow.isPaused;
    previousCaptureStateRef.current = { recording: transcriptionWorkflow.isRecording, paused: transcriptionWorkflow.isPaused };
    if (stopped) {
      stopActiveStream();
      setCaptureState({ status: "idle", detail: "Audio capture stopped. Retained work is still available.", streamId: null });
    }
    if ((stopped || paused) && activeGuidanceQuestionRef.current?.source !== "typed") {
      cancelActiveGuidanceRequest();
      if (guidanceStatus === "loading") {
        setGuidanceData(null); setGuidanceText(""); setGuidancePreview("");
        setGuidanceStatus("idle"); setAnswerReadyVisible(false);
      }
      setGuidanceError(paused ? "Audio processing paused; pending detected-question guidance was cancelled. Saved answers remain recoverable." : "Audio capture stopped; pending detected-question guidance was cancelled. Saved answers remain recoverable.");
    }
  }, [transcriptionWorkflow.isRecording, transcriptionWorkflow.isPaused, guidanceStatus]);
  const captureView = capturePresentation(transcriptionWorkflow.isRecording, transcriptionWorkflow.isPaused, transcriptionWorkflow.status);
  const liveIndicator = captureView.stopped ? { color: "#9090C0", shadow: "none", label: captureView.label } : transcriptionWorkflow.isPaused ? { color: "#FBBF24", shadow: "rgba(251,191,36,0.5)", label: "Audio processing paused" } : getLiveIndicatorState({
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
    void ensureInterviewSession()
      .then((session) => {
        if (!session) return null;
        return interviewPersistenceRepository.saveTranscriptSegment({
          sessionId: session.id,
          clientEventId: latestSegment.id,
          text: latestSegment.text,
          source: latestSegment.source,
          speakerId: latestSegment.speakerId ?? null,
          isPartial: false,
          capturedAt: new Date(latestSegment.createdAt).toISOString(),
        });
      })
      .then((result) => {
        if (result?.persistence) setInterviewPersistenceInfo(result.persistence);
      })
      .catch(() => {
        setInterviewPersistenceInfo({
          mode: "local",
          note: "Transcript segment persistence failed. Capture and local transcript display are continuing.",
          cloudSyncReady: false,
          authState: "signed-out-local",
          userEmail: null,
        });
      });
  }, [
    ensureInterviewSession,
    interviewPersistenceRepository,
    launchFlowStep,
    realtimeConnection,
    transcriptSegments,
  ]);

  useEffect(() => {
    if (launchFlowStep !== "live") lastAutoGuidanceQuestionRef.current = "";
  }, [launchFlowStep]);

  useEffect(() => {
    const detectedQuestion = preferredDetectedQuestion.trim();
    if (
      launchFlowStep !== "live" ||
      transcriptionWorkflow.isPaused ||
      !detectedQuestion ||
      guidanceStatus === "loading" ||
      detectedQuestionKey(detectedQuestion) === lastAutoGuidanceQuestionRef.current
    ) return;
    lastAutoGuidanceQuestionRef.current = detectedQuestionKey(detectedQuestion);
    const questionId = createStableId("question");
    realtimeConnection.sendRuntimeEvent({
      type: "question.detected",
      clientEventId: createStableId("question-event"),
      questionId,
      normalizedQuestion: detectedQuestion,
      category: inferInterviewIntent(detectedQuestion),
      confidence: 0.72,
      timestamp: new Date().toISOString(),
    });
    void ensureInterviewSession()
      .then((session) => {
        if (!session) return null;
        if (interviewContextDraft.screenContextText.trim()) {
          const screenContext = createScreenContextFromText(interviewContextDraft.screenContextText);
          realtimeConnection.sendRuntimeEvent({
            type: "screen.context",
            clientEventId: createStableId("screen-context-event"),
            sourceType: screenContext.sourceType,
            extractedText: screenContext.extractedText,
            timestamp: screenContext.timestamp,
          });
          void interviewPersistenceRepository.saveScreenContext({
            sessionId: session.id,
            context: screenContext,
          })
            .then(({ persistence }) => setInterviewPersistenceInfo(persistence))
            .catch(() => {
              setInterviewPersistenceInfo({
                mode: "local",
                note: "Screen context persistence failed. Live guidance is continuing.",
                cloudSyncReady: false,
                authState: "signed-out-local",
                userEmail: null,
              });
            });
        }
        return interviewPersistenceRepository.saveDetectedQuestion({
          sessionId: session.id,
          questionId,
          rawText: detectedQuestion,
          normalizedQuestion: detectedQuestion,
          category: inferInterviewIntent(detectedQuestion),
          confidence: 0.72,
          urgency: /debug|outage|down|accessdenied|failed|incident/i.test(detectedQuestion)
            ? "high"
            : "normal",
          requiresResumeContext: /tell me about|describe a time|leadership|ksa/i.test(
            detectedQuestion
          ),
          requiresCodeContext: /code|debug|terminal|terraform|kubectl|docker|git/i.test(
            detectedQuestion
          ),
          requiresVisualContext: /screen|shown|diagram|this error|this code/i.test(
            detectedQuestion
          ),
          detectedAt: new Date().toISOString(),
        });
      })
      .then((result) => {
        if (!result) return;
        lastPersistedDetectedQuestionIdRef.current = result.data;
        setInterviewPersistenceInfo(result.persistence);
      })
      .catch(() => {
        setInterviewPersistenceInfo({
          mode: "local",
          note: "Detected question persistence failed. Live guidance is continuing.",
          cloudSyncReady: false,
          authState: "signed-out-local",
          userEmail: null,
        });
      });
    void handleGetGuidance();
  }, [
    guidanceStatus,
    handleGetGuidance,
    ensureInterviewSession,
    interviewPersistenceRepository,
    launchFlowStep,
    transcriptionWorkflow.isPaused,
    preferredDetectedQuestion,
    realtimeConnection,
  ]);

  const questionSegmentIds = useMemo(() => {
    const detectedQuestion = preferredDetectedQuestion.trim();
    if (!detectedQuestion) return new Set<string>();
    return new Set(
      transcriptSegments
        .filter((segment) => isQuestionLikeSegment(segment.text, detectedQuestion))
        .map((segment) => segment.id)
    );
  }, [preferredDetectedQuestion, transcriptSegments]);

  const avgResponseTime = formatGuidanceTiming(guidanceTiming);
  const realtimeStatusLabel = getRealtimeStatusLabel(realtimeConnection.state);
  const realtimeStatusColor = getRealtimeStatusColor(realtimeConnection.state);

  const recoveredAnswer = transcriptionWorkflow.savedGuidance.reduce<typeof transcriptionWorkflow.savedGuidance[number] | null>((latest, item) => !latest || item.createdAt >= latest.createdAt ? item : latest, null);
  const showRecoveredAnswer = !guidanceQuestion && !transcriptionWorkflow.isRecording && guidanceStatus !== "loading" && recoveredAnswer;
  const readerQuestion = guidanceQuestion || (showRecoveredAnswer ? recoveredAnswer.question : preferredDetectedQuestion);
  const readerAnswer = guidanceStatus === "failed" ? null : guidanceData ? {
    ...guidanceData, speakNow: guidanceData.speakNow || guidanceData.gist,
    keyPoints: guidanceData.keyPoints ?? guidanceData.key_points, fullAnswer: guidanceData.full_answer,
  } : showRecoveredAnswer ? recoveredAnswer : null;
  const readingPanels = <CopilotReadingPanels question={readerQuestion}
    hearingText={!readerQuestion ? (draftSegment || transcriptionWorkflow.latestSegment) : undefined}
    answer={readerAnswer} preview={guidancePreview} status={guidanceStatus} error={guidanceError}
    firstTextMs={firstAnswerMs} canRetry={Boolean(readerQuestion) && !transcriptionWorkflow.isPaused}
    onRetry={() => void handleGetGuidance(guidanceQuestion || undefined)} />;
  const sessionContext = (<div style={{
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
                Paste resume, role, and notes before capture. Local-first, with cloud persistence when signed in.
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
            <label style={{
              alignItems: "center",
              background: "#0D0D1A",
              border: "0.5px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              color: "#A0A0C0",
              cursor: "pointer",
              display: "flex",
              fontSize: 11,
              justifyContent: "space-between",
              padding: "8px 10px",
            }}>
              Upload resume PDF/DOCX/TXT
              <input
                aria-label="Upload resume file"
                type="file"
                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                onChange={(event) => {
                  void handleContextFileUpload(event.target.files?.[0] ?? null, "resume");
                  event.currentTarget.value = "";
                }}
                style={{ display: "none" }}
              />
            </label>
            <label style={{
              alignItems: "center",
              background: "#0D0D1A",
              border: "0.5px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              color: "#A0A0C0",
              cursor: "pointer",
              display: "flex",
              fontSize: 11,
              justifyContent: "space-between",
              padding: "8px 10px",
            }}>
              Upload job PDF/DOCX/TXT
              <input
                aria-label="Upload job description file"
                type="file"
                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                onChange={(event) => {
                  void handleContextFileUpload(event.target.files?.[0] ?? null, "job-description");
                  event.currentTarget.value = "";
                }}
                style={{ display: "none" }}
              />
            </label>
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
            <textarea
              aria-label="Screen or terminal context"
              placeholder="Optional visible terminal output, code, error, diagram notes..."
              value={interviewContextDraft.screenContextText}
              onChange={(event) => {
                const next = { ...interviewContextDraft, screenContextText: event.target.value };
                setInterviewContextDraft(next);
                writeStoredInterviewContextDraft(next);
              }}
              style={{
                background: "#0D0D1A",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                color: "#DCDCFF",
                fontSize: 12,
                gridColumn: "1 / -1",
                minHeight: 74,
                padding: 10,
                resize: "vertical",
              }}
            />
          </div>
          {contextUploadStatus && (
            <p style={{ color: "#7070A0", fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
              {contextUploadStatus}
            </p>
          )}
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
            {interviewContextDraft.screenContextText.trim() && (
              <span style={{ border: "0.5px solid rgba(248,113,113,0.3)", borderRadius: 999, color: "#F87171", fontSize: 10, padding: "4px 8px" }}>
                Screen context loaded
              </span>
            )}
          </div>
        </div>);

  const recoverForReader = async (sessionId?: string) => {
    cancelActiveGuidanceRequest();
    activeGuidanceQuestionRef.current = null;
    setGuidanceQuestion(""); setGuidancePreview(""); setGuidanceData(null); setGuidanceStatus("idle"); setFirstAnswerMs(null); setGuidanceError("");
    await transcriptionWorkflow.recoverServerSession(sessionId);
  };
  const ownedSessionTools = (
    <section aria-label="Typed coaching and saved session" style={{ marginBottom: 18, padding: 16, border: "1px solid #49496A", borderRadius: 10, color: "#D8D8F0" }}>
      <label style={{ display: "block", fontSize: 13 }}>
        Type a question without recording
        <textarea aria-label="Typed coaching question" maxLength={500} value={typedQuestion} onChange={event => setTypedQuestion(event.target.value)} style={{ display: "block", width: "100%", marginTop: 8, padding: 10, background: "#16162A", color: "#F0F0FF", border: "1px solid #636386", borderRadius: 8 }} />
      </label>
      <p style={{ fontSize: 12, margin: "8px 0" }}>Generating requires a signed-in account, an owned saved session and available server allowance. Typed coaching does not acquire audio.</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" disabled={!typedQuestion.trim() || guidanceStatus === "loading" || launchFlowStep === "requesting" || transcriptionWorkflow.isPaused} onClick={() => void handleGetGuidance(typedQuestion)} style={{ padding: "8px 12px", borderRadius: 6, background: "#4F46E5", color: "white" }}>{guidanceStatus === "loading" ? "Generating..." : syntheticMode ? "Generate sample guidance (synthetic)" : "Generate typed guidance"}</button>
        <button type="button" disabled={!transcriptionWorkflow.serverSessionId || transcriptionWorkflow.isRecording || transcriptionWorkflow.status === "stopping" || guidanceStatus === "loading"} onClick={() => void recoverForReader()} style={{ padding: "8px 12px", borderRadius: 6, background: "#34344F", color: "white" }}>Recover saved session</button>
        <button type="button" disabled={!transcriptionWorkflow.serverSessionId} onClick={() => void transcriptionWorkflow.exportServerSession()} style={{ padding: "8px 12px", borderRadius: 6, background: "#34344F", color: "white" }}>Export saved session</button>
        <button type="button" disabled={!transcriptionWorkflow.serverSessionId || transcriptionWorkflow.isRecording || transcriptionWorkflow.status === "stopping" || guidanceStatus === "loading"} onClick={() => void transcriptionWorkflow.deleteServerSession()} style={{ padding: "8px 12px", borderRadius: 6, background: "#34344F", color: "white" }}>Delete saved session</button>
      </div>
      <SavedSessionPicker appearance="dark" sessions={transcriptionWorkflow.savedServerSessions} loading={transcriptionWorkflow.isFindingServerSessions}
        disabled={transcriptionWorkflow.isRecording || transcriptionWorkflow.status === "stopping" || guidanceStatus === "loading"}
        find={transcriptionWorkflow.findServerSessions} recover={recoverForReader} />
      <p role="status" style={{ marginTop: 8, fontSize: 12 }}>{describeSaveAcknowledgement(transcriptionWorkflow.serverSaveState, transcriptionWorkflow.error, transcriptionWorkflow.feedback)}</p>
      {guidanceError ? <p role="status" style={{ color: "#FBBF24", fontSize: 12 }}>{guidanceError}</p> : null}
      {transcriptionWorkflow.savedGuidance.length > 0 ? <div style={{ marginTop: 12 }}>
        <h3>Saved guidance in this session</h3>
        <p style={{ fontSize: 12 }}>Review each saved question before reusing its answer.</p>
        {transcriptionWorkflow.savedGuidance.map(item => <article key={item.operationId} style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #49496A" }}>
          <p style={{ fontWeight: 600 }}>{item.question}</p><p>{item.speakNow}</p>
          {item.fullAnswer ? <details><summary>Full saved answer</summary><p>{item.fullAnswer}</p></details> : null}
        </article>)}
      </div> : null}
    </section>
  );

  /* ================================================================
     RENDER — IDLE STATE (two mode cards)
     ================================================================ */
  if (launchFlowStep !== "live") {
    return (
      <div className={workspaceStyles.workspace}>
        <div className={workspaceStyles.toolbar}>
          <div className={workspaceStyles.sourceChoices} aria-label="Audio source">
            <button type="button" aria-pressed={audioMode === "microphone"} onClick={() => setAudioMode("microphone")}>Use Microphone</button>
            <button type="button" aria-pressed={audioMode === "tab-audio"} onClick={() => setAudioMode("tab-audio")}>Share Tab Audio</button>
          </div>
          <span className={workspaceStyles.connection}>{realtimeStatusLabel}</span>
          <button className={workspaceStyles.startButton} type="button" disabled={isFreeLimitReached || launchFlowStep === "requesting" || guidanceStatus === "loading"}
            onClick={() => void handleStartLiveCopilot()}>{launchFlowStep === "requesting" ? "Requesting permission…" : "Start Session"}</button>
        </div>
        <p className={workspaceStyles.setupHint}>Choose your audio source, then start. Your question stays on the left; your answer appears on the right.</p>
        {captureState.status === "failed" && <p role="status" className={workspaceStyles.warning}>{captureState.detail}</p>}
        {isFreeLimitReached && <p role="status" className={workspaceStyles.warning}>This browser has reached its 10-session preview limit. Typed coaching and saved work remain available; this local counter is separate from your account allowance.</p>}
        {readingPanels}
        <details className={workspaceStyles.details}><summary>Type a question · Saved sessions</summary>{ownedSessionTools}</details>
        <details className={workspaceStyles.details}><summary>Personalize with your resume, role, and notes</summary>{sessionContext}</details>
        <details className={workspaceStyles.details}><summary>Audio permissions and privacy</summary><CaptureDisclosure appearance="dark" /></details>
        {!onboardingDone && <p className={workspaceStyles.setupHint}>Use a quiet microphone or share a browser tab with audio enabled. <button type="button" onClick={() => { window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true"); setOnboardingDone(true); }}>Dismiss tip</button></p>}
      </div>
    );
  }

  /* ================================================================
     RENDER — LIVE STATE (aligned question and answer reader)
     ================================================================ */
  return (
    <div className={workspaceStyles.workspace}>
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
          <div style={{
            color: interviewPersistenceInfo?.mode === "supabase-active" ? "#2DD4BF" : "#7070A0",
            fontSize: 11,
            marginTop: 4,
          }}>
            {interviewPersistenceInfo?.mode === "supabase-active"
              ? "Session metadata storage connected — transcript saves acknowledged separately"
              : "Local interview persistence active"}
          </div>
        </div>
        <label style={{ color: "#C8C8E0", fontSize: 12 }}>Input level
          <meter aria-label="Selected-source audio level" min={0} max={1} value={transcriptionWorkflow.audioLevel} style={{ display: "block", width: 100 }} />
        </label>
        <button type="button" disabled={!captureView.canPause}
          onClick={() => { if (transcriptionWorkflow.isPaused) transcriptionWorkflow.resumeCapture(); else { cancelActiveGuidanceRequest(); transcriptionWorkflow.pauseCapture(); } }}
          style={{ background: "#34344F", color: "white", border: "1px solid #636386", borderRadius: 8, padding: "6px 12px" }}>
          {transcriptionWorkflow.isPaused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => void handleEndSession()}
          style={{
            background: "transparent",
            border: "0.5px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 12,
            color: "#EF4444",
            cursor: "pointer",
            transition: "border-color 0.2s, color 0.2s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#EF4444"; }}
        >
          End Session
        </button>
      </div>

      {captureView.canRetry && <button type="button" onClick={() => void handleEndSession()} style={{ color: "white", background: "#34344F", padding: "8px 12px", borderRadius: 8 }}>Review saved work / return to Start</button>}
      {!captureView.stopped && transcriptionWorkflow.feedback === "Connection unstable — retrying..." && (
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

      {readingPanels}

      <div className={workspaceStyles.metrics}>
        <span>{questionsCoached} questions coached</span>
        <span>First transcript: {latencySnapshot.sttFirstPartialMs === null ? "—" : `${(latencySnapshot.sttFirstPartialMs / 1000).toFixed(1)}s`}</span>
        <span>First answer text: {firstAnswerMs === null ? "—" : `${(firstAnswerMs / 1000).toFixed(1)}s`}</span>
        <span>Average complete answer: {avgResponseTime}</span>
        <span>{Math.max(0, FREE_SESSION_LIMIT - freeSessionCount)} preview sessions left</span>
      </div>
      <details className={workspaceStyles.details}><summary>Type a question · Saved sessions</summary>{ownedSessionTools}</details>
      <details className={workspaceStyles.details}><summary>Live transcript · Full conversation</summary>
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
                    color: isQuestionSegment ? "#FDE68A" : "#D6DEEC",
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
                color: "#A8B6CD",
                fontStyle: "italic",
                background: "rgba(255,255,255,0.01)",
              }}>
                {draftSegment}
              </div>
            )}
          </div>
        ) : transcriptionWorkflow.status === "failed" ? (
          <p style={{ fontSize: 12, color: "#EF4444" }}>Transcription stopped. No retries are running. {transcriptionWorkflow.error} Use typed guidance, or resolve the error and return to Start to explicitly capture again.</p>
        ) : (
          <p style={{ fontSize: 12, color: "#A8B6CD" }}>No speech detected yet.</p>
        )}
      </div>
      </details>
    </div>
  );
}
