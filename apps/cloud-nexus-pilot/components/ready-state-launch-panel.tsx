"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useTranscriptionWorkflow } from "@/features/transcription/use-transcription-workflow";
import type { InterviewIntent } from "@/lib/contracts/interview";
import {
  createCreateOrResumeSessionRequestInit,
  getCreateOrResumeSessionEndpointUrl,
} from "@/lib/contracts/session-execution-client";
import type { SessionExecutionId } from "@/lib/contracts/session-execution";

type LaunchFlowStep = "ready" | "requesting" | "live";

type LaunchCaptureState = {
  status: "idle" | "requesting" | "live-stream-confirmed" | "failed";
  detail: string;
  streamId: string | null;
};

const INITIAL_CAPTURE_STATE: LaunchCaptureState = {
  status: "idle",
  detail: "Share a tab with audio to start live transcription.",
  streamId: null,
};

const LOCKED_SURFACE =
  "rounded-3xl border border-slate-700 bg-slate-900/80 shadow-[0_16px_40px_rgba(2,6,23,0.35)]";
const LOCKED_SUBSURFACE = "rounded-2xl border border-slate-700 bg-slate-900/70";

function createStableId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function inferInterviewIntent(question: string): InterviewIntent {
  const normalized = question.toLowerCase();
  if (/system design|architecture|scalability|distributed/i.test(normalized)) {
    return "system_design";
  }
  if (/compare|difference|versus|vs\b/i.test(normalized)) {
    return "comparison";
  }
  if (/follow up|why did you|what happened next/i.test(normalized)) {
    return "follow_up";
  }
  if (/code|algorithm|api|database|debug|deploy|kubernetes|terraform|aws|react|typescript/i.test(normalized)) {
    return "technical";
  }
  if (/tell me about|describe a time|how did you handle/i.test(normalized)) {
    return "behavioral";
  }
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
  ) {
    return "Transcription unavailable. Retrying...";
  }

  if (params.status === "receiving-transcript") {
    return "Receiving transcript...";
  }

  if (
    params.status === "connecting" ||
    params.status === "listening" ||
    params.status === "no-speech-yet"
  ) {
    return "Listening...";
  }

  return "Listening...";
}

function normalizeQuestionMatchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isQuestionLikeSegment(segmentText: string, detectedQuestion: string) {
  const normalizedSegment = normalizeQuestionMatchText(segmentText);
  const normalizedQuestion = normalizeQuestionMatchText(detectedQuestion);

  if (!normalizedSegment || !normalizedQuestion) {
    return false;
  }

  if (
    normalizedSegment.includes(normalizedQuestion) ||
    normalizedQuestion.includes(normalizedSegment)
  ) {
    return true;
  }

  const questionTokens = normalizedQuestion.split(" ").filter(Boolean);
  if (questionTokens.length === 0) {
    return false;
  }

  const segmentTokenSet = new Set(normalizedSegment.split(" ").filter(Boolean));
  const overlapCount = questionTokens.filter((token) => segmentTokenSet.has(token)).length;
  return overlapCount / questionTokens.length >= 0.6;
}

function getSpeakerDisplay(speakerId: number | null | undefined) {
  if (typeof speakerId !== "number") {
    return null;
  }

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
      try {
        payloads.push(JSON.parse(dataText) as Record<string, unknown>);
      } catch {
        // Ignore malformed SSE payloads and keep parsing the stream.
      }
    }

    boundaryIndex = nextBuffer.indexOf("\n\n");
  }

  return { payloads, buffer: nextBuffer };
}

export function ReadyStateLaunchPanel({
  primaryActionLabel = "Start Live Copilot",
}: {
  primaryActionLabel?: string;
}) {
  const [launchFlowStep, setLaunchFlowStep] = useState<LaunchFlowStep>("ready");
  const [captureState, setCaptureState] = useState<LaunchCaptureState>(INITIAL_CAPTURE_STATE);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const guidanceAbortControllerRef = useRef<AbortController | null>(null);
  const sessionExecutionIdRef = useRef<SessionExecutionId | null>(null);
  const transcriptionWorkflow = useTranscriptionWorkflow({
    repositoryMode: "local-only",
  });
  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceStatus, setGuidanceStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle"
  );
  const [guidanceError, setGuidanceError] = useState("");

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
    setCaptureState({
      status: "requesting",
      detail: "Choose a browser tab and enable tab audio to continue.",
      streamId: null,
    });

    try {
      stopTranscriptionCapture();
      stopActiveStream();

      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = stream.getAudioTracks();

      if (audioTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        setCaptureState({
          status: "failed",
          detail: "Please select a tab and enable audio to start.",
          streamId: null,
        });
        setLaunchFlowStep("ready");
        return;
      }

      activeStreamRef.current = stream;
      setCaptureState({
        status: "live-stream-confirmed",
        detail: "Live tab audio connected. Starting transcription...",
        streamId: stream.id,
      });
      setLaunchFlowStep("live");

      stream.getTracks().forEach((track) => {
        track.addEventListener(
          "ended",
          () => {
            void handleEndSession();
          },
          { once: true }
        );
      });

      await startTranscriptionCapture({
        existingStream: stream,
        source: "system-audio",
      });
      void ensureSessionExecution();
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
      setCaptureState({
        status: "failed",
        detail: denied
          ? "Please select a tab and enable audio to start."
          : "Unable to start tab sharing right now. Please try again.",
        streamId: null,
      });
      setLaunchFlowStep("ready");
    }
  }

  async function handleEndSession() {
    cancelActiveGuidanceRequest();
    stopTranscriptionCapture();
    stopActiveStream();
    sessionExecutionIdRef.current = null;
    setGuidanceText("");
    setGuidanceStatus("idle");
    setGuidanceError("");
    setCaptureState({
      status: "idle",
      detail: "Session ended.",
      streamId: null,
    });
    setLaunchFlowStep("ready");
  }

  async function handleGetGuidance() {
    const detectedQuestion =
      transcriptionWorkflow.aiDetectedQuestion.trim() ||
      transcriptionWorkflow.latestDetectedQuestion.trim();
    if (!detectedQuestion) return;

    cancelActiveGuidanceRequest();
    const abortController = new AbortController();
    guidanceAbortControllerRef.current = abortController;

    setGuidanceStatus("loading");
    setGuidanceText("");
    setGuidanceError("");

    try {
      void ensureSessionExecution();
      const response = await fetch("/api/generate-guidance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          question: detectedQuestion,
          transcriptContext: buildTranscriptContext(transcriptionWorkflow.segments),
          interviewMode: inferInterviewIntent(detectedQuestion),
        }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("Live guidance is unavailable right now.");
      }

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

          if (payload.type === "error" && typeof payload.message === "string") {
            throw new Error(payload.message);
          }

          if (payload.type === "done") {
            receivedDone = true;
          }
        }

        if (done) {
          receivedDone = true;
        }
      }

      if (!streamedText.trim()) {
        throw new Error("Live guidance returned an empty response.");
      }

      setGuidanceStatus("ready");
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      setGuidanceStatus("failed");
      setGuidanceError(
        error instanceof Error ? error.message : "Unable to generate guidance right now."
      );
    } finally {
      if (guidanceAbortControllerRef.current === abortController) {
        guidanceAbortControllerRef.current = null;
      }
    }
  }

  const liveStatus = getLiveStatusLabel({
    status: transcriptionWorkflow.status,
    transportStatus: transcriptionWorkflow.transportStatus,
  });
  const preferredDetectedQuestion =
    transcriptionWorkflow.aiDetectedQuestion || transcriptionWorkflow.latestDetectedQuestion;
  const transcriptSegments = transcriptionWorkflow.segments;
  const latestSegmentId = transcriptSegments.at(-1)?.id ?? null;
  const questionSegmentIds = useMemo(() => {
    const detectedQuestion = preferredDetectedQuestion.trim();
    if (!detectedQuestion) {
      return new Set<string>();
    }

    return new Set(
      transcriptSegments
        .filter((segment) => isQuestionLikeSegment(segment.text, detectedQuestion))
        .map((segment) => segment.id)
    );
  }, [preferredDetectedQuestion, transcriptSegments]);

  return (
    <div className={`${LOCKED_SURFACE} p-6 text-slate-100 md:p-8`}>
      {launchFlowStep !== "live" ? (
        <div className="mx-auto max-w-4xl py-6">
          <h2 className="text-4xl font-semibold leading-tight tracking-[-0.02em] text-slate-50 md:text-5xl">
            Live Call Copilot
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-8 text-slate-300">
            Real-time transcription and response guidance for your conversations.
          </p>

          <div className={`mt-8 ${LOCKED_SUBSURFACE} p-6`}>
            <button
              type="button"
              onClick={() => void handleStartLiveCopilot()}
              disabled={launchFlowStep === "requesting"}
              className="w-full rounded-full bg-cyan-400 px-8 py-4 text-base font-semibold tracking-[-0.01em] text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {launchFlowStep === "requesting" ? "Requesting Browser Permission..." : primaryActionLabel}
            </button>
            <p className="mt-4 text-sm leading-7 text-slate-300">{captureState.detail}</p>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-5xl py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-3xl font-semibold tracking-[-0.02em] text-slate-50">Live Transcript</h3>
              <p className="mt-3 text-sm text-slate-300">{liveStatus}</p>
            </div>
            <button
              type="button"
              onClick={() => void handleEndSession()}
              className="rounded-full border border-slate-500 bg-slate-900 px-5 py-2 text-sm font-semibold text-slate-100 transition hover:border-slate-300"
            >
              End Session
            </button>
          </div>

          <div className={`mt-6 ${LOCKED_SUBSURFACE} min-h-[360px] p-6`}>
            {transcriptSegments.length > 0 ? (
              <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
                {transcriptSegments.map((segment) => {
                  const speaker = getSpeakerDisplay(segment.speakerId);
                  const isLatest = segment.id === latestSegmentId;
                  const isQuestionSegment = questionSegmentIds.has(segment.id);

                  return (
                    <article
                      key={segment.id}
                      className={`rounded-2xl border px-4 py-4 transition ${
                        isQuestionSegment
                          ? "border-amber-300/40 bg-amber-400/10"
                          : speaker?.className ?? "border-slate-700 bg-slate-900/70 text-slate-100"
                      } ${isLatest ? "ring-2 ring-cyan-300/50 ring-offset-2 ring-offset-slate-900" : ""}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {speaker ? (
                            <span
                              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${speaker.badgeClassName}`}
                            >
                              {speaker.label}
                            </span>
                          ) : null}
                          {isQuestionSegment ? (
                            <span className="rounded-full bg-amber-300/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100 ring-1 ring-inset ring-amber-300/25">
                              Question
                            </span>
                          ) : null}
                          {isLatest ? (
                            <span className="rounded-full bg-cyan-300/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-100 ring-1 ring-inset ring-cyan-300/25">
                              Latest
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-400">Segment {segment.chunkIndex + 1}</p>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-base leading-8 text-inherit">
                        {segment.text}
                      </p>
                    </article>
                  );
                })}
              </div>
            ) : transcriptionWorkflow.status === "failed" ? (
              <p className="text-base text-rose-200">Transcription unavailable. Retrying...</p>
            ) : (
              <p className="text-base text-slate-300">No speech detected yet.</p>
            )}
          </div>

          <div className="mt-10 border-t border-slate-700/80 pt-6">
            <div className={`${LOCKED_SUBSURFACE} p-6`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
                  Detected Question
                </p>
                <p className="mt-3 text-base leading-8 text-slate-100">
                  {preferredDetectedQuestion || "No likely question detected in the latest live segment yet."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleGetGuidance()}
                disabled={!preferredDetectedQuestion || guidanceStatus === "loading"}
                className="rounded-full bg-cyan-400 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {guidanceStatus === "loading" ? "Getting Guidance..." : "Get Guidance"}
              </button>
            </div>

            {guidanceError ? (
              <p className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {guidanceError}
              </p>
            ) : null}

            {guidanceText ? (
              <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-slate-950/60 px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
                  Live Answer Guidance
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-100">
                  {guidanceText}
                </p>
              </div>
            ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
