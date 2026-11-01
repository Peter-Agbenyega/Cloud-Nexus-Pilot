"use client";

import { ensureOwnedGuidanceSession, savedGuidanceAssociations, type SavedGuidanceAssociation } from "./guidance-session-client";
import { loadSavedTranscriptSession, deleteSavedTranscriptSession, listOwnedTranscriptSessions, type OwnedTranscriptSessionSummary } from "./saved-session-service";
import { CaptureRetryQueue, shouldRetryChunk, stoppedCaptureFeedback } from "./capture-recovery";
import { CaptureOwnership } from "@/lib/realtime/capture-ownership";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  canCaptureSystemAudio,
  createCaptureStream,
  getPreferredMimeType,
  isAudioCaptureSupported,
  requireActiveAudioTracks,
  type LiveTranscriptionSource,
} from "@/features/transcription/audio-capture";
import {
  cleanTranscriptText,
  getDetectedQuestion,
  summarizeTranscriptState,
} from "@/features/transcription/transcript-bridge";
import { transcribeUploadedAsset } from "@/features/transcription/transcript-service";
import {
  createStreamingTranscriptClient,
  type StreamingTranscriptClient,
} from "@/features/transcription/streaming-transcript-service";
import type {
  TranscriptCaptureMode,
  TranscriptId,
  TranscriptRecord,
  TranscriptSource,
} from "@/lib/contracts/transcription";
import {
  createLocalTranscriptionRepository,
  createTranscriptionRepository,
  type TranscriptImportStatus,
  type TranscriptionPersistenceInfo,
} from "@/lib/transcription-persistence";
import { writeTranscriptWorkspaceRecoveryIntent } from "@/lib/transcript-workspace-recovery";
import { supabase } from "@/lib/supabase";
import {
  createLiveAudioPipeline,
  isPcmAudioPipelineSupported,
  type LiveAudioPipelineHandle,
} from "@/lib/audio/live-audio-pipeline";

export type TranscriptionStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "receiving-transcript"
  | "no-speech-yet"
  | "paused"
  | "stopping"
  | "stopped"
  | "unsupported"
  | "failed";

export type TranscriptionTransportStatus =
  | "idle"
  | "streaming-session-creating"
  | "streaming-session-connected"
  | "streaming-session-reconnecting"
  | "streaming-session-failed"
  | "legacy-fallback-active";

export type StartCaptureOptions = {
  existingStream?: MediaStream | null;
  source?: LiveTranscriptionSource;
};

export type TranscriptSegment = {
  id: string;
  chunkIndex: number;
  text: string;
  source: LiveTranscriptionSource;
  speakerId?: number | null;
  createdAt: number;
};

export type LocalTranscriptionScenario = {
  transcript: string;
  latestSegment: string;
  segments: TranscriptSegment[];
  selectedFileName: string;
  feedback: string;
};

export type UseTranscriptionWorkflowResult = {
  status: TranscriptionStatus;
  transcript: string;
  latestSegment: string;
  draftSegment: string;
  segments: TranscriptSegment[];
  selectedFileName: string;
  error: string;
  feedback: string;
  transportStatus: TranscriptionTransportStatus;
  transportFallbackReason: string;
  source: LiveTranscriptionSource;
  isSupported: boolean;
  systemAudioSupported: boolean;
  serverSessionId: string | null;
  savedGuidance: SavedGuidanceAssociation[];
  ensureServerSession: (signal?: AbortSignal) => Promise<string>;
  refreshServerGuidance: (sessionId?: string) => Promise<void>;
  serverSaveState: "unavailable" | "unsaved" | "saving" | "saved" | "failed";
  recoverServerSession: (sessionId?: string) => Promise<void>;
  findServerSessions: () => Promise<void>;
  savedServerSessions: OwnedTranscriptSessionSummary[];
  isFindingServerSessions: boolean;
  exportServerSession: () => Promise<void>;
  deleteServerSession: () => Promise<void>;
  isRecording: boolean;
  isPaused: boolean;
  audioLevel: number;
  pauseCapture: () => void;
  resumeCapture: () => void;
  isTranscribing: boolean;
  canUseTranscript: boolean;
  transcriptSummary: string;
  questionBoundaryDetected: boolean;
  latestDetectedQuestion: string;
  aiDetectedQuestion: string;
  transcriptRecords: TranscriptRecord[];
  activeTranscriptId: TranscriptId | null;
  activeTranscriptRecord: TranscriptRecord | null;
  persistenceInfo: TranscriptionPersistenceInfo;
  importStatus: TranscriptImportStatus;
  isImporting: boolean;
  setSource: (source: LiveTranscriptionSource) => void;
  startCapture: (options?: StartCaptureOptions) => Promise<boolean>;
  stopCapture: () => void;
  clearTranscript: () => void;
  uploadFile: (file: File) => Promise<void>;
  loadLocalScenario: (scenario: LocalTranscriptionScenario) => void;
  selectTranscript: (id: TranscriptId) => Promise<void>;
  deleteTranscript: (id: TranscriptId) => Promise<void>;
  importLocalTranscripts: () => Promise<void>;
};

export type UseTranscriptionWorkflowOptions = {
  repositoryMode?: "auto" | "local-only";
};

// 4-second chunks balance live response speed with enough speech context for Whisper quality.
const DEFAULT_CHUNK_INTERVAL_MS = 4_000;
const PCM_CHUNK_FLUSH_INTERVAL_MS = DEFAULT_CHUNK_INTERVAL_MS;
const PCM_MIN_FRAMES_PER_CHUNK = 64_000;
const MIN_LIVE_SEGMENT_WORDS = 5;
const MAX_LIVE_SEGMENT_BUFFER_MS = 4_000;
const MAX_IN_FLIGHT_LIVE_CHUNKS = 6;
const LIVE_SEGMENT_MERGE_WINDOW_MS = 10_000;
const SHORT_LIVE_FRAGMENT_WORDS = 8;
const INCOMPLETE_QUESTION_WAIT_MS = 3_000;
const CHUNK_UPLOAD_RETRY_BACKOFF_MS = 2_000;
const shouldDebugLogs = process.env.NODE_ENV !== "production";

const QUESTION_CUE_PATTERNS = [
  /\b(who|what|when|where|why|how|explain|describe)\b/i,
  /\btell me\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
] as const;

const WEAK_TRAILING_QUESTION_PATTERNS = [
  /\babout the time you\s*$/i,
  /\babout a time you\s*$/i,
  /\btell me about\s*$/i,
  /\bcan you tell me\s*$/i,
  /\bcould you tell me\s*$/i,
  /\bhow would you\s*$/i,
  /\bwhat would you\s*$/i,
] as const;

function normalizeTranscriptForFiltering(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\[\](){}]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countMeaningfulWords(text: string): number {
  return normalizeTranscriptForFiltering(text)
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .length;
}

function containsQuestionCue(text: string): boolean {
  return text.includes("?") || QUESTION_CUE_PATTERNS.some((pattern) => pattern.test(text));
}

function startsLikeContinuation(text: string): boolean {
  return /^(and|or|but|so|because|that|which|for|to|with|in|on|as)\b/i.test(text.trim());
}

function shouldMergeLiveSegment(params: {
  previousSegment: TranscriptSegment | null;
  nextText: string;
  nextSource: LiveTranscriptionSource;
  nextSpeakerId: number | null;
  now: number;
}): boolean {
  const { previousSegment, nextText, nextSource, nextSpeakerId, now } = params;
  if (!previousSegment) return false;
  if (previousSegment.source !== nextSource) return false;
  if ((previousSegment.speakerId ?? null) !== nextSpeakerId) return false;
  if (now - previousSegment.createdAt > LIVE_SEGMENT_MERGE_WINDOW_MS) return false;
  if (getDetectedQuestion(nextText) || containsQuestionCue(nextText)) return false;

  const previousEndsWithQuestion = /\?["']?\s*$/.test(previousSegment.text);
  if (previousEndsWithQuestion) return false;

  const nextWordCount = countMeaningfulWords(nextText);
  const previousContinues = !/[.?!]["']?\s*$/.test(previousSegment.text);

  return (
    nextWordCount <= SHORT_LIVE_FRAGMENT_WORDS ||
    previousContinues ||
    startsLikeContinuation(nextText)
  );
}

function isIncompleteDetectedQuestion(text: string): boolean {
  const cleaned = cleanTranscriptText(text);
  if (!cleaned) return true;
  if (/[?]["']?\s*$/.test(cleaned)) return false;
  if (WEAK_TRAILING_QUESTION_PATTERNS.some((pattern) => pattern.test(cleaned))) return true;

  return countMeaningfulWords(cleaned) < 8;
}

export function useTranscriptionWorkflow(
  options?: UseTranscriptionWorkflowOptions
): UseTranscriptionWorkflowResult {
  const [status, setStatus] = useState<TranscriptionStatus>(
    isAudioCaptureSupported() ? "idle" : "unsupported"
  );
  const [transcript, setTranscript] = useState("");
  const [latestSegment, setLatestSegment] = useState("");
  const [draftSegment, setDraftSegment] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [aiDetectedQuestion, setAiDetectedQuestion] = useState("");
  const [transportStatus, setTransportStatus] =
    useState<TranscriptionTransportStatus>("idle");
  const [transportFallbackReason, setTransportFallbackReason] = useState("");
  const [source, setSource] = useState<LiveTranscriptionSource>("microphone");
  const [activeUploads, setActiveUploads] = useState(0);
  const [serverSessionId, setServerSessionId] = useState<string | null>(null);
  const serverSessionIdRef = useRef<string | null>(null);
  const recoveryEpochRef = useRef(0);
  const guidanceSessionPromiseRef = useRef<Promise<string> | null>(null);
  const [savedGuidance, setSavedGuidance] = useState<SavedGuidanceAssociation[]>([]);
  const [savedServerSessions, setSavedServerSessions] = useState<OwnedTranscriptSessionSummary[]>([]);
  const [isFindingServerSessions, setIsFindingServerSessions] = useState(false);
  const sessionListAbortRef = useRef<AbortController | null>(null);
  const [serverSaveState, setServerSaveState] = useState<"unavailable" | "unsaved" | "saving" | "saved" | "failed">("unavailable");
  useEffect(() => {
    try {
      const id = window.localStorage.getItem("cloud-nexus-pilot:last-owned-stream-session");
      if (id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) { serverSessionIdRef.current = id; setServerSessionId(id); }
    } catch { /* Recovery can still use the active session when storage is unavailable. */ }
  }, []);
  const [captureActive, setCaptureActive] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const stoppingRef = useRef(false);
  const pendingChunkTasksRef = useRef(new Set<Promise<void>>());
  const trackCleanupRef = useRef<(() => void) | null>(null);
  const lastMeterUpdateRef = useRef(0);
  const [transcriptRecords, setTranscriptRecords] = useState<TranscriptRecord[]>([]);
  const [activeTranscriptId, setActiveTranscriptId] = useState<TranscriptId | null>(null);
  const [persistenceInfo, setPersistenceInfo] = useState<TranscriptionPersistenceInfo>({
    mode: "local",
    note:
      "Transcript persistence is local-first. Cloud sync activates only when Supabase env, auth, and transcript_records table access are ready.",
    cloudSyncReady: false,
    authState: "signed-out-local",
    userEmail: null,
  });
  const [importStatus, setImportStatus] = useState<TranscriptImportStatus>({
    available: false,
    localTranscriptCount: 0,
    cloudTranscriptCount: 0,
    importableCount: 0,
    note: "Checking whether a local-to-cloud transcript import is needed.",
    markerApplied: false,
  });
  const [isImporting, setIsImporting] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureOwnershipRef = useRef(new CaptureOwnership());
  const streamingGenerationRef = useRef(0);
  const audioPipelineRef = useRef<LiveAudioPipelineHandle | null>(null);
  const audioStartupAbortRef = useRef<AbortController | null>(null);
  const fileUploadAbortRef = useRef<AbortController | null>(null);
  const streamingClientRef = useRef<StreamingTranscriptClient | null>(null);
  const streamingConnectPromiseRef = useRef<Promise<StreamingTranscriptClient | null> | null>(null);
  const streamingFallbackReasonRef = useRef("");
  const streamRef = useRef<MediaStream | null>(null);
  const ownsStreamRef = useRef(true);
  const chunkIndexRef = useRef(0);
  const sourceRef = useRef(source);
  const transcriptRef = useRef(transcript);
  const segmentsRef = useRef<TranscriptSegment[]>(segments);
  const activeUploadsRef = useRef(activeUploads);
  const activeTranscriptIdRef = useRef<TranscriptId | null>(null);
  const inFlightChunkCountRef = useRef(0);
  const activeByteSizeRef = useRef(0);
  const activeCaptureModeRef = useRef<TranscriptCaptureMode>("live-capture");
  const activeContentTypeRef = useRef("audio/webm");
  const activeFilenameRef = useRef("live-capture.webm");
  const isCreatingTranscriptRef = useRef(false);
  const transcriptCreationPromiseRef = useRef<Promise<TranscriptRecord> | null>(null);
  const aiQuestionInFlightRef = useRef(false);
  const pendingAiQuestionDetectionRef = useRef(false);
  const aiQuestionAbortRef = useRef<AbortController | null>(null);
  const incompleteQuestionTimerRef = useRef<number | null>(null);
  const pendingIncompleteQuestionRef = useRef("");
  const pendingLiveSegmentRef = useRef("");
  const pendingLiveSegmentAgeRef = useRef<number | null>(null);
  const pendingLiveSegmentSpeakerRef = useRef<number | null>(null);
  const consecutiveChunkUploadFailuresRef = useRef(0);
  const seedChunkRef = useRef<Blob | null>(null);
  const pendingChunkPartsRef = useRef<Blob[]>([]);
  const pendingChunkBytesRef = useRef(0);
  const repository = useMemo(
    () =>
      options?.repositoryMode === "local-only"
        ? createLocalTranscriptionRepository()
        : createTranscriptionRepository(),
    [options?.repositoryMode]
  );

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    activeUploadsRef.current = activeUploads;
  }, [activeUploads]);

  useEffect(() => {
    activeTranscriptIdRef.current = activeTranscriptId;
  }, [activeTranscriptId]);

  const clearIncompleteQuestionWait = useCallback(() => {
    pendingIncompleteQuestionRef.current = "";
    if (incompleteQuestionTimerRef.current) {
      window.clearTimeout(incompleteQuestionTimerRef.current);
      incompleteQuestionTimerRef.current = null;
    }
  }, []);

  const hydrateFromTranscriptRecord = useCallback((record: TranscriptRecord | null) => {
    if (!record) return;
    clearIncompleteQuestionWait();

    setTranscript(record.transcriptText);
    setLatestSegment(record.summary.latestSegment);
        setSegments(
          record.segments.map((segment) => ({
            id: segment.id,
            chunkIndex: segment.chunkIndex,
            text: segment.text,
            source: segment.source,
            speakerId: segment.speakerId ?? null,
            createdAt: segment.createdAt,
          }))
        );
    setSelectedFileName(record.filename);
    setActiveTranscriptId(record.id);
    activeByteSizeRef.current = record.byteSize;
    activeCaptureModeRef.current = record.captureMode;
    activeContentTypeRef.current = record.contentType;
    activeFilenameRef.current = record.filename;
  }, [clearIncompleteQuestionWait]);

  const loadTranscriptInventory = useCallback(
    async (options?: { hydrateFirst?: boolean }) => {
      const result = await repository.listTranscripts();
      setTranscriptRecords(result.transcripts);
      setPersistenceInfo(result.persistence);
      setImportStatus(result.importStatus);

      if (options?.hydrateFirst) {
        const firstTranscript = result.transcripts[0] ?? null;
        if (firstTranscript) {
          hydrateFromTranscriptRecord(firstTranscript);
        }
      }

      return result;
    },
    [hydrateFromTranscriptRecord, repository]
  );

  useEffect(() => {
    let isActive = true;

    void loadTranscriptInventory({ hydrateFirst: true }).then((result) => {
      if (!isActive) return;

      if (!result.transcripts[0]) {
        setImportStatus(result.importStatus);
      }
    });

    return () => {
      isActive = false;
    };
  }, [loadTranscriptInventory]);

  useEffect(() => {
    if (options?.repositoryMode === "local-only") return;
    if (!supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void loadTranscriptInventory();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [loadTranscriptInventory, options?.repositoryMode]);

  const persistCurrentTranscript = useCallback(
    async (options: {
      transcriptText: string;
      segments: TranscriptSegment[];
      status: import("@/lib/contracts/transcription").TranscriptStatus;
      source: TranscriptSource | null;
      filename: string;
      contentType: string;
      byteSize: number;
      captureMode: TranscriptCaptureMode;
      errorMessage?: string | null;
    }) => {
      const currentId = activeTranscriptIdRef.current;

      if (!currentId) {
        if (transcriptCreationPromiseRef.current || isCreatingTranscriptRef.current) {
          await transcriptCreationPromiseRef.current;
          const createdTranscriptId = activeTranscriptIdRef.current;
          if (!createdTranscriptId) return null;
          const updateResult = await repository.updateTranscript(createdTranscriptId, {
            filename: options.filename,
            contentType: options.contentType,
            transcriptText: options.transcriptText,
            segments: options.segments.map((segment) => ({
              id: segment.id,
              chunkIndex: segment.chunkIndex,
              text: segment.text,
              source: segment.source,
              speakerId: segment.speakerId ?? null,
              contentType: options.contentType,
              createdAt: segment.createdAt,
              durationMs: null,
            })),
            source: options.source,
            status: options.status,
            byteSize: options.byteSize,
            errorMessage: options.errorMessage ?? null,
          });

          setTranscriptRecords((current) =>
            [updateResult.transcript, ...current.filter((item) => item.id !== createdTranscriptId)].sort(
              (left, right) => right.updatedAt - left.updatedAt
            )
          );
          setPersistenceInfo(updateResult.persistence);
          return updateResult.transcript;
        }

        isCreatingTranscriptRef.current = true;
        const createPromise = repository
          .createTranscript(
            {
              filename: options.filename,
              contentType: options.contentType,
              byteSize: options.byteSize,
              captureMode: options.captureMode,
              source: options.source ?? undefined,
            },
            {
              transcriptText: options.transcriptText,
              segments: options.segments.map((segment) => ({
                id: segment.id,
                chunkIndex: segment.chunkIndex,
                text: segment.text,
                source: segment.source,
                speakerId: segment.speakerId ?? null,
                contentType: options.contentType,
                createdAt: segment.createdAt,
                durationMs: null,
              })),
              status: options.status,
            }
          )
          .then((result) => {
            setActiveTranscriptId(result.transcript.id);
            setTranscriptRecords((current) => [result.transcript, ...current]);
            setPersistenceInfo(result.persistence);
            return result.transcript;
          })
          .finally(() => {
            isCreatingTranscriptRef.current = false;
            transcriptCreationPromiseRef.current = null;
          });

        transcriptCreationPromiseRef.current = createPromise;
        return createPromise;
      }

      const result = await repository.updateTranscript(currentId, {
        filename: options.filename,
        contentType: options.contentType,
        transcriptText: options.transcriptText,
        segments: options.segments.map((segment) => ({
          id: segment.id,
          chunkIndex: segment.chunkIndex,
          text: segment.text,
          source: segment.source,
          speakerId: segment.speakerId ?? null,
          contentType: options.contentType,
          createdAt: segment.createdAt,
          durationMs: null,
        })),
        source: options.source,
        status: options.status,
        byteSize: options.byteSize,
        errorMessage: options.errorMessage ?? null,
      });

      setTranscriptRecords((current) =>
        [result.transcript, ...current.filter((item) => item.id !== currentId)].sort(
          (left, right) => right.updatedAt - left.updatedAt
        )
      );
      setPersistenceInfo(result.persistence);
      void loadTranscriptInventory();
      return result.transcript;
    },
    [loadTranscriptInventory, repository]
  );

  const logStreamingSeam = useCallback(
    (
      event:
        | "create-success"
        | "create-failed"
        | "create-skipped"
        | "fallback-activated"
        | "fallback-cleared"
        | "fallback-in-use",
      detail?: string
    ) => {
      if (shouldDebugLogs) {
        console.log("[transcription][seam]", {
          event,
          detail: detail ?? "",
        });
      }
    },
    []
  );

  const resetStreamingClient = useCallback((reason: string) => {
    const activeClient = streamingClientRef.current;
    streamingClientRef.current = null;
    streamingConnectPromiseRef.current = null;
    streamingFallbackReasonRef.current = reason;
    setTransportStatus("streaming-session-failed");
    setTransportFallbackReason(reason);
    void activeClient?.stop().catch(() => undefined);
  }, []);

  const shouldResetStreamingClient = useCallback((message: string) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("transcript_stream_session_missing") ||
      normalized.includes("streaming transcript event channel disconnected") ||
      normalized.includes("streaming transcript event channel failed before connecting") ||
      normalized.includes("streaming transcript event channel did not connect in time")
    );
  }, []);

  const ensureStreamingClient = useCallback(
    async (reason: "session-start" | "chunk-send"): Promise<StreamingTranscriptClient | null> => {
      if (streamingClientRef.current) return streamingClientRef.current;
      if (streamingConnectPromiseRef.current) return streamingConnectPromiseRef.current;

      const generation = streamingGenerationRef.current;
      const connectPromise = createStreamingTranscriptClient({
        onSaveAcknowledged: () => {
          if (generation === streamingGenerationRef.current) setServerSaveState("saved");
        },
        onLog: (entry) => {
          if (generation !== streamingGenerationRef.current) return;
          if (shouldDebugLogs) {
            console.log("[transcription][streaming]", entry);
          }
          if (entry.event === "sse-connect-open") {
            setTransportStatus("streaming-session-connected");
            setTransportFallbackReason("");
            setError("");
            return;
          }

          if (entry.event === "sse-reconnecting") {
            setTransportStatus("streaming-session-reconnecting");
            setFeedback("The event channel is reconnecting. Only server-acknowledged final text is recoverable; live audio gaps may remain.");
            return;
          }
          if (entry.event === "sse-connect-error") {
            const detail = entry.detail || "Streaming transcript event channel disconnected.";
            if (entry.sessionId && streamingClientRef.current?.sessionId === entry.sessionId) {
              resetStreamingClient(detail);
            } else {
              streamingFallbackReasonRef.current = detail;
              setTransportStatus("streaming-session-failed");
              setTransportFallbackReason(detail);
            }
            setFeedback("");
            return;
          }
        },
        onTranscript: (response) => {
          if (generation !== streamingGenerationRef.current) return;
          if (!response?.text?.trim()) return;

          startTransition(() => {
            setDraftSegment(response.text.trim());
            setStatus("receiving-transcript");
          });
        },
      })
        .then((client) => {
          if (generation !== streamingGenerationRef.current) {
            void client.stop().catch(() => undefined);
            return null;
          }
          streamingClientRef.current = client;
          serverSessionIdRef.current = client.sessionId;
          setServerSessionId(client.sessionId);
          setSavedGuidance([]);
          setServerSaveState("unsaved");
          try { window.localStorage.setItem("cloud-nexus-pilot:last-owned-stream-session", client.sessionId); } catch { /* No recovery cursor is stored if local storage is unavailable. */ }
          streamingFallbackReasonRef.current = "";
          setTransportStatus("streaming-session-connected");
          setTransportFallbackReason("");
          setError("");
          setFeedback(
            "Streaming transcript session connected. Live chunks now use the persistent session transport."
          );
          logStreamingSeam("create-success", `reason=${reason};sessionId=${client.sessionId}`);
          return client;
        })
        .catch((error) => {
          if (generation !== streamingGenerationRef.current) return null;
          const message =
            error instanceof Error ? error.message : "Unable to initialize streaming transcript session.";
          streamingFallbackReasonRef.current = `streaming-connect-failed: ${message}`;
          setTransportStatus("streaming-session-failed");
          setTransportFallbackReason(message);
          logStreamingSeam("create-failed", `reason=${reason};error=${message}`);
          return null;
        })
        .finally(() => {
          if (streamingConnectPromiseRef.current === connectPromise) {
            streamingConnectPromiseRef.current = null;
          }
        });

      streamingConnectPromiseRef.current = connectPromise;
      return connectPromise;
    },
    [logStreamingSeam, resetStreamingClient]
  );

  const appendSegment = useCallback(
    (
      chunkIndex: number,
      text: string,
      nextSource: LiveTranscriptionSource,
      speakerId?: number | null
    ) => {
      const cleaned = cleanTranscriptText(text);
      if (!cleaned) return null;
      const createdAt = Date.now();
      const previousSegment = segmentsRef.current.at(-1) ?? null;
      const nextSpeakerId = speakerId ?? null;

      // Merge short adjacent live chunks into one card for readable live transcription.
      if (
        previousSegment &&
        shouldMergeLiveSegment({
          previousSegment,
          nextText: cleaned,
          nextSource,
          nextSpeakerId,
          now: createdAt,
        })
      ) {
        const mergedSegment: TranscriptSegment = {
          ...previousSegment,
          text: cleanTranscriptText(`${previousSegment.text} ${cleaned}`),
          chunkIndex,
        };
        const nextSegments = [...segmentsRef.current.slice(0, -1), mergedSegment];
        const nextTranscript = nextSegments.map((segment) => segment.text).join("\n");
        segmentsRef.current = nextSegments;
        transcriptRef.current = nextTranscript;

        startTransition(() => {
          setLatestSegment(mergedSegment.text);
          setSegments(nextSegments);
          setTranscript(nextTranscript);
        });

        return {
          nextSegments,
          nextTranscript,
        };
      }

      const nextSegment: TranscriptSegment = {
        id: `segment-${createdAt}-${chunkIndex}`,
        chunkIndex,
        text: cleaned,
        source: nextSource,
        speakerId: nextSpeakerId,
        createdAt,
      };

      const nextSegments = [...segmentsRef.current, nextSegment];
      const nextTranscript = transcriptRef.current
        ? `${transcriptRef.current}\n${cleaned}`
        : cleaned;
      segmentsRef.current = nextSegments;
      transcriptRef.current = nextTranscript;

      startTransition(() => {
        setLatestSegment(cleaned);
        setSegments(nextSegments);
        setTranscript(nextTranscript);
      });

      return {
        nextSegments,
        nextTranscript,
      };
    },
    []
  );

  const flushPendingLiveSegment = useCallback(
    (chunkIndex: number, nextSource: LiveTranscriptionSource) => {
      const bufferedText = cleanTranscriptText(pendingLiveSegmentRef.current);
      const bufferedSpeakerId = pendingLiveSegmentSpeakerRef.current;
      pendingLiveSegmentRef.current = "";
      pendingLiveSegmentAgeRef.current = null;
      pendingLiveSegmentSpeakerRef.current = null;
      setDraftSegment("");

      if (!bufferedText) return null;
      return appendSegment(chunkIndex, bufferedText, nextSource, bufferedSpeakerId);
    },
    [appendSegment]
  );

  const triggerAiQuestionDetection = useCallback(function runQuestionDetection(
    segments: TranscriptSegment[]
  ) {
    if (aiQuestionInFlightRef.current) {
      pendingAiQuestionDetectionRef.current = true;
      return;
    }

    const recentSegments = segments
      .slice(-3)
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .slice(-3);

    if (recentSegments.length === 0) {
      return;
    }

    aiQuestionAbortRef.current?.abort();
    const abortController = new AbortController();
    aiQuestionAbortRef.current = abortController;
    aiQuestionInFlightRef.current = true;

    void fetch("/api/detect-question", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ segments: recentSegments }),
      signal: abortController.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({ question: null }))) as {
          question?: string | null;
        };
        if (abortController.signal.aborted) {
          return;
        }
        const nextQuestion = payload.question?.trim() || "";
        if (nextQuestion && isIncompleteDetectedQuestion(nextQuestion)) {
          // Avoid generating answers from partial live questions; wait briefly for the next chunk.
          setAiDetectedQuestion("");
          if (pendingIncompleteQuestionRef.current !== nextQuestion) {
            pendingIncompleteQuestionRef.current = nextQuestion;
            if (incompleteQuestionTimerRef.current) {
              window.clearTimeout(incompleteQuestionTimerRef.current);
            }
            incompleteQuestionTimerRef.current = window.setTimeout(() => {
              incompleteQuestionTimerRef.current = null;
              runQuestionDetection(segmentsRef.current);
            }, INCOMPLETE_QUESTION_WAIT_MS);
          }
          return;
        }

        pendingIncompleteQuestionRef.current = "";
        if (incompleteQuestionTimerRef.current) {
          window.clearTimeout(incompleteQuestionTimerRef.current);
          incompleteQuestionTimerRef.current = null;
        }
        setAiDetectedQuestion(nextQuestion);
      })
      .catch(() => {
        if (!abortController.signal.aborted) {
          setAiDetectedQuestion("");
        }
      })
      .finally(() => {
        if (aiQuestionAbortRef.current === abortController) {
          aiQuestionAbortRef.current = null;
        }
        aiQuestionInFlightRef.current = false;
        if (pendingAiQuestionDetectionRef.current) {
          pendingAiQuestionDetectionRef.current = false;
          runQuestionDetection(segmentsRef.current);
        }
      });
  }, []);

  const chunkRetriesRef = useRef(new CaptureRetryQueue());
  const stopInternal = useCallback(() => {
    recoveryEpochRef.current += 1;
    sessionListAbortRef.current?.abort();
    sessionListAbortRef.current = null;
    setIsFindingServerSessions(false);
    fileUploadAbortRef.current?.abort();
    fileUploadAbortRef.current = null;
    trackCleanupRef.current?.();
    trackCleanupRef.current = null;
    chunkRetriesRef.current.cancel();
    setFeedback("");
    inFlightChunkCountRef.current = 0;
    setActiveUploads(0);
    stoppingRef.current = false;
    setCaptureActive(false);
    setIsPaused(false);
    setAudioLevel(0);
    captureOwnershipRef.current.cancel();
    audioStartupAbortRef.current?.abort();
    audioStartupAbortRef.current = null;
    streamingGenerationRef.current += 1;
    audioPipelineRef.current?.stop();
    audioPipelineRef.current = null;
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    recorderRef.current = null;
    flushPendingLiveSegment(chunkIndexRef.current, sourceRef.current);
    aiQuestionAbortRef.current?.abort();
    aiQuestionAbortRef.current = null;
    aiQuestionInFlightRef.current = false;
    pendingAiQuestionDetectionRef.current = false;
    consecutiveChunkUploadFailuresRef.current = 0;
    setAiDetectedQuestion("");
    clearIncompleteQuestionWait();
    void streamingClientRef.current?.stop();
    streamingClientRef.current = null;
    streamingConnectPromiseRef.current = null;
    streamingFallbackReasonRef.current = "";
    transcriptCreationPromiseRef.current = null;
    isCreatingTranscriptRef.current = false;
    setTransportStatus("idle");
    setTransportFallbackReason("");

    if (streamRef.current) {
      if (ownsStreamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
      streamRef.current = null;
      ownsStreamRef.current = true;
    }

    seedChunkRef.current = null;
    pendingChunkPartsRef.current = [];
    pendingChunkBytesRef.current = 0;
    pendingLiveSegmentRef.current = "";
    pendingLiveSegmentAgeRef.current = null;
    pendingLiveSegmentSpeakerRef.current = null;
    setDraftSegment("");
  }, [clearIncompleteQuestionWait, flushPendingLiveSegment]);

  const processAudioChunk = useCallback(
    async (audioBlob: Blob, chunkIndex: number, nextSource: LiveTranscriptionSource, overrideContentType?: string, attempt = 0) => {
      const generation = streamingGenerationRef.current;
      if (audioBlob.size === 0) return;

      if (inFlightChunkCountRef.current >= MAX_IN_FLIGHT_LIVE_CHUNKS) {
        console.warn("[transcription] live chunk skipped: too many uploads in flight", {
          chunkIndex,
          inFlightUploads: inFlightChunkCountRef.current,
          maxInFlightUploads: MAX_IN_FLIGHT_LIVE_CHUNKS,
          size: audioBlob.size,
          source: nextSource,
        });
        stopInternal();
        setStatus("failed");
        setError("Capture stopped because transcription could not keep up. An audio gap was not saved. Review retained text, then retry capture.");
        return;
      }

      inFlightChunkCountRef.current += 1;
      setActiveUploads(inFlightChunkCountRef.current);
      setStatus("receiving-transcript");

      try {
        const contentType =
          overrideContentType || recorderRef.current?.mimeType || audioBlob.type || getPreferredMimeType() || "audio/webm";
        if (shouldDebugLogs) {
          console.log("[transcription] batch upload start", {
            chunkIndex,
            size: audioBlob.size,
            contentType,
            source: nextSource,
          });
        }
        // Live transcription stays on the persistent streaming session path.
        let streamingClient = streamingClientRef.current;
        if (!streamingClient) {
          streamingClient = await ensureStreamingClient("chunk-send");
        }

        if (!streamingClient) {
          const reason = streamingFallbackReasonRef.current || "streaming-session-unavailable";
          setTransportStatus("streaming-session-failed");
          setTransportFallbackReason(reason);
          throw new Error(reason);
        }

        setServerSaveState("saving");
        const result = await streamingClient.sendChunk({
          blob: audioBlob, chunkIndex, source: nextSource, contentType,
        });
        if (generation !== streamingGenerationRef.current) return;

        setTransportStatus("streaming-session-connected");
        setTransportFallbackReason("");
        consecutiveChunkUploadFailuresRef.current = 0;
        activeByteSizeRef.current += audioBlob.size;
        activeContentTypeRef.current = result.contentType || contentType;

        const cleanedChunkText = cleanTranscriptText(result.text) || result.text.trim();
        if (!cleanedChunkText) {
          if (shouldDebugLogs) {
            console.log("[transcription] transcript accepted: no usable speech detected", {
              chunkIndex: result.chunkIndex,
              size: audioBlob.size,
              textLength: result.text.length,
              source: result.source,
            });
          }
          setStatus("no-speech-yet");
          setFeedback(
            "Live audio stream is active and transcription is connected, but no speech has been detected yet."
          );
          setError("");
          await persistCurrentTranscript({
            transcriptText: transcriptRef.current,
            segments: segmentsRef.current,
            status: "processing",
            source: nextSource,
            filename: activeFilenameRef.current,
            contentType: activeContentTypeRef.current,
            byteSize: activeByteSizeRef.current,
            captureMode: activeCaptureModeRef.current,
          });
          return;
        }

        startTransition(() => {
          setLatestSegment(cleanedChunkText);
        });

        const now = Date.now();
        if (typeof result.speakerId === "number" && Number.isFinite(result.speakerId)) {
          pendingLiveSegmentSpeakerRef.current = result.speakerId;
        }

        if (!pendingLiveSegmentRef.current) {
          pendingLiveSegmentRef.current = cleanedChunkText;
          pendingLiveSegmentAgeRef.current = now;
        } else {
          pendingLiveSegmentRef.current = cleanTranscriptText(
            `${pendingLiveSegmentRef.current} ${cleanedChunkText}`
          );
        }

        startTransition(() => {
          setDraftSegment(pendingLiveSegmentRef.current);
        });

        const bufferedText = pendingLiveSegmentRef.current;
        const bufferedWordCount = bufferedText.split(/\s+/).filter(Boolean).length;
        const bufferedAgeMs =
          pendingLiveSegmentAgeRef.current == null ? 0 : now - pendingLiveSegmentAgeRef.current;
        const endsWithSentence = /[.?!]["']?\s*$/.test(bufferedText);
        const shouldFlushBufferedSegment =
          endsWithSentence ||
          bufferedAgeMs >= MAX_LIVE_SEGMENT_BUFFER_MS ||
          (bufferedWordCount >= 20 && bufferedAgeMs >= 2_000);

        if (!shouldFlushBufferedSegment) {
          setStatus("receiving-transcript");
          setFeedback("Receiving transcript from the configured transcription provider.");
          setError("");
          return;
        }

        const appended = flushPendingLiveSegment(result.chunkIndex, result.source);
        if (!appended) {
          return;
        }

        triggerAiQuestionDetection(appended.nextSegments);

        if (shouldDebugLogs) {
          console.log("[transcription] transcript accepted", {
            chunkIndex: result.chunkIndex,
            segmentChars: appended.nextSegments.at(-1)?.text.length ?? 0,
            transcriptChars: appended.nextTranscript.length,
            source: result.source,
          });
          console.log("[transcription] transcript state update", {
            status: "receiving-transcript",
            chunkIndex: result.chunkIndex,
            totalSegments: appended.nextSegments.length,
            totalChars: appended.nextTranscript.length,
          });
        }
        await persistCurrentTranscript({
          transcriptText: appended.nextTranscript,
          segments: appended.nextSegments,
          status: "processing",
          source: result.source,
          filename: activeFilenameRef.current,
          contentType: activeContentTypeRef.current,
          byteSize: activeByteSizeRef.current,
          captureMode: activeCaptureModeRef.current,
        });
        if (generation !== streamingGenerationRef.current) return;
        setStatus("receiving-transcript");
        setFeedback("Receiving transcript from the configured transcription provider.");
        setError("");
      } catch (uploadError) {
        if (generation !== streamingGenerationRef.current) return;
        setServerSaveState("failed");
        const message =
          uploadError instanceof Error
            ? uploadError.message
            : "Unable to process the latest audio chunk.";
        if (stoppingRef.current || !shouldRetryChunk(uploadError, attempt)) {
          if (!stoppingRef.current) stopInternal();
          setFeedback(stoppedCaptureFeedback(uploadError));
          setError(`${message} The latest audio may not have been saved. Retained text remains available.`);
          setStatus("failed");
          return;
        }
        consecutiveChunkUploadFailuresRef.current += 1;
        console.warn("[transcription] live chunk failed; retrying without ending session", {
          chunkIndex,
          consecutiveFailures: consecutiveChunkUploadFailuresRef.current,
          message,
        });
        setError("");
        setFeedback(
          consecutiveChunkUploadFailuresRef.current >= 3
            ? "Connection unstable — retrying..."
            : "The latest live audio chunk failed, but the session is still listening."
        );
        setStatus(transcriptRef.current.trim() ? "receiving-transcript" : "listening");
        chunkRetriesRef.current.schedule(() => {
          if (!stoppingRef.current && generation === streamingGenerationRef.current &&
              (recorderRef.current?.state === "recording" || audioPipelineRef.current)) {
            void processAudioChunk(audioBlob, chunkIndex, nextSource, overrideContentType, attempt + 1);
          }
        }, CHUNK_UPLOAD_RETRY_BACKOFF_MS);
        return;
      } finally {
        if (generation === streamingGenerationRef.current) {
          inFlightChunkCountRef.current = Math.max(0, inFlightChunkCountRef.current - 1);
          setActiveUploads(() => {
            const nextValue = inFlightChunkCountRef.current;
            if (
              nextValue === 0 &&
              recorderRef.current?.state === "recording" &&
              streamingClientRef.current
            ) {
              const hasTranscript = transcriptRef.current.trim().length > 0;
              setStatus(hasTranscript ? "listening" : "no-speech-yet");
            }
            return nextValue;
          });
        }
      }
    },
    [
      ensureStreamingClient,
      flushPendingLiveSegment,
      logStreamingSeam,
      persistCurrentTranscript,
      resetStreamingClient,
      shouldResetStreamingClient,
      stopInternal,
      triggerAiQuestionDetection,
    ]
  );

  const startCapture = useCallback(
    async (options?: StartCaptureOptions): Promise<boolean> => {
      if (!isAudioCaptureSupported()) {
        setStatus("unsupported");
        setError("Audio capture is unsupported in this browser.");
        return false;
      }

      if (recorderRef.current?.state === "recording" || audioPipelineRef.current) {
        return true;
      }

      if (stoppingRef.current) return false;
      const ownership = captureOwnershipRef.current;
      const token = ownership.begin();
      if (token === null) return false;
      recoveryEpochRef.current += 1;
      chunkRetriesRef.current.begin();

      setError("");
      setFeedback("");
      setTransportStatus("streaming-session-creating");
      setTransportFallbackReason("");
      setSelectedFileName("");
      setTranscript("");
      setLatestSegment("");
      setSegments([]);
      setStatus("connecting");
      transcriptRef.current = "";
      segmentsRef.current = [];
      aiQuestionAbortRef.current?.abort();
      aiQuestionAbortRef.current = null;
      aiQuestionInFlightRef.current = false;
      pendingAiQuestionDetectionRef.current = false;
      consecutiveChunkUploadFailuresRef.current = 0;
      setAiDetectedQuestion("");
      clearIncompleteQuestionWait();
      pendingLiveSegmentRef.current = "";
      pendingLiveSegmentAgeRef.current = null;
      pendingLiveSegmentSpeakerRef.current = null;
      stoppingRef.current = false;
      setIsPaused(false);
      const nextSource = options?.source ?? sourceRef.current;
      sourceRef.current = nextSource;
      if (options?.source) {
        setSource(options.source);
      }
      activeCaptureModeRef.current = "live-capture";
      activeContentTypeRef.current = "audio/wav";
      activeFilenameRef.current = `live-capture-${Date.now()}.wav`;
      activeByteSizeRef.current = 0;
      chunkIndexRef.current = 0;
      seedChunkRef.current = null;
      pendingChunkPartsRef.current = [];
      pendingChunkBytesRef.current = 0;
      setActiveTranscriptId(null);

      try {
        const sourceStream = options?.existingStream ?? (await createCaptureStream(nextSource));
        if (!options?.existingStream) {
          if (!ownership.adopt(token, sourceStream)) return false;
        } else if (!ownership.isCurrent(token)) {
          return false;
        }
        const audioTracks = requireActiveAudioTracks(sourceStream);
        const handleEnded = () => {
          stopInternal();
          setStatus("stopped");
          setError("The selected audio source ended. Unacknowledged final audio may be missing; retained transcript remains available. Select a source explicitly to resume.");
        };
        for (const track of audioTracks) track.addEventListener("ended", handleEnded, { once: true });
        trackCleanupRef.current = () => {
          for (const track of audioTracks) track.removeEventListener("ended", handleEnded);
        };

        // Keep transcription capture audio-only so downstream chunks are stable.
        const stream = new MediaStream(audioTracks);
        streamRef.current = stream;
        ownsStreamRef.current = !options?.existingStream;

        const initialStreamingClient = await ensureStreamingClient("session-start");
        if (!ownership.isCurrent(token)) return false;
        if (!initialStreamingClient) {
          throw new Error(
            streamingFallbackReasonRef.current || "Streaming session create failed."
          );
        }
        setTransportStatus("streaming-session-connected");
        setTransportFallbackReason("");
        logStreamingSeam("fallback-cleared", "streaming-session-active");

        if (!isPcmAudioPipelineSupported()) {
          throw new Error("Live PCM capture is unavailable. Upload a completed audio recording instead; no incomplete MediaRecorder fragments will be sent.");
        }
        const startupController = new AbortController();
        audioStartupAbortRef.current = startupController;
        const pipeline = await createLiveAudioPipeline({
          stream,
          signal: startupController.signal,
          flushIntervalMs: PCM_CHUNK_FLUSH_INTERVAL_MS,
          minFramesPerChunk: PCM_MIN_FRAMES_PER_CHUNK,
          onLevel: (value) => {
            const now = Date.now();
            if (value === 0 || now - lastMeterUpdateRef.current >= 150) {
              lastMeterUpdateRef.current = now;
              setAudioLevel(value);
            }
          },
          onError: (pipelineError) => {
            stopInternal();
            setError(pipelineError.message);
            setStatus("failed");
          },
          onChunk: (chunk) => {
            if (!ownership.isCurrent(token)) return;
            const chunkIndex = chunkIndexRef.current++;
            const task = processAudioChunk(chunk.blob, chunkIndex, nextSource, chunk.contentType);
            pendingChunkTasksRef.current.add(task);
            void task.finally(() => pendingChunkTasksRef.current.delete(task));
          },
        });
        if (!ownership.isCurrent(token)) { pipeline.stop(); return false; }
        audioPipelineRef.current = pipeline;
        setCaptureActive(true);
        setStatus("listening");
        setFeedback("The selected audio source is active. Watch the input meter; transcript progress is reported separately.");
        return true;
      } catch (startError) {
        if (!ownership.isCurrent(token)) return false;
        const message =
          startError instanceof DOMException && startError.name === "NotAllowedError"
            ? "Audio permission denied. Allow microphone or tab audio access to continue."
            : nextSource === "system-audio"
              ? startError instanceof Error && startError.message
                ? startError.message
                : "Unable to start shared-tab audio capture right now."
              : startError instanceof Error && startError.message
                ? startError.message
                : "Unable to start microphone capture right now.";
        stopInternal();
        setError(message);
        setStatus("failed");
        if (streamingFallbackReasonRef.current) {
          setTransportStatus("streaming-session-failed");
          setTransportFallbackReason(streamingFallbackReasonRef.current);
        }
        return false;
      } finally {
        ownership.finish(token);
      }
    },
    [clearIncompleteQuestionWait, ensureStreamingClient, logStreamingSeam, processAudioChunk, stopInternal]
  );

  const stopCapture = useCallback(() => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    chunkRetriesRef.current.cancel();
    trackCleanupRef.current?.();
    trackCleanupRef.current = null;
    // Flush valid final PCM before invalidating capture, and retain its bounded
    // in-flight upload until acknowledgement. Tracks stop immediately.
    audioPipelineRef.current?.stop();
    audioPipelineRef.current = null;
    captureOwnershipRef.current.cancel();
    audioStartupAbortRef.current?.abort();
    audioStartupAbortRef.current = null;
    setCaptureActive(false);
    setIsPaused(false);
    setAudioLevel(0);
    setStatus("stopping");
    const generation = streamingGenerationRef.current;
    void Promise.allSettled([...pendingChunkTasksRef.current]).then(() => {
      if (generation !== streamingGenerationRef.current) return;
      stopInternal();
      setStatus("stopped");
      setFeedback("Capture stopped. Completed transcript remains available; any reported failed audio is a gap.");
    });
  }, [stopInternal]);

  const pauseCapture = useCallback(() => {
    if (!audioPipelineRef.current || stoppingRef.current) return;
    audioPipelineRef.current.pause();
    setIsPaused(true);
    setStatus("paused");
    setFeedback("Audio processing is paused. The selected source remains acquired; Stop releases it.");
  }, []);
  const resumeCapture = useCallback(() => {
    if (!audioPipelineRef.current || stoppingRef.current) return;
    audioPipelineRef.current.resume();
    setIsPaused(false);
    setStatus("listening");
    setFeedback("Audio processing resumed on the same selected source.");
  }, []);

  const ensureServerSession = useCallback(async (signal?: AbortSignal): Promise<string> => {
    recoveryEpochRef.current += 1;
    if (streamingClientRef.current) return streamingClientRef.current.sessionId;
    if (guidanceSessionPromiseRef.current) return guidanceSessionPromiseRef.current;
    const pending = ensureOwnedGuidanceSession(serverSessionIdRef.current, signal).then((id) => {
      if (signal?.aborted) throw new DOMException("Guidance was cancelled.", "AbortError");
      if (id !== serverSessionIdRef.current) setSavedGuidance([]);
      serverSessionIdRef.current = id;
      setServerSessionId(id);
      setServerSaveState("unsaved");
      try { window.localStorage.setItem("cloud-nexus-pilot:last-owned-stream-session", id); } catch { /* The server remains authoritative. */ }
      return id;
    }).finally(() => { if (guidanceSessionPromiseRef.current === pending) guidanceSessionPromiseRef.current = null; });
    guidanceSessionPromiseRef.current = pending;
    return pending;
  }, []);
  const refreshServerGuidance = useCallback(async (sessionId?: string) => {
    const id = sessionId ?? serverSessionIdRef.current;
    if (!id) return;
    const saved = await loadSavedTranscriptSession(id);
    if (serverSessionIdRef.current !== id) return;
    setSavedGuidance(savedGuidanceAssociations(saved));
    setServerSaveState("saved");
  }, []);

  const findServerSessions = useCallback(async () => {
    sessionListAbortRef.current?.abort();
    const controller = new AbortController(); sessionListAbortRef.current = controller;
    setIsFindingServerSessions(true); setSavedServerSessions([]); setError("");
    try {
      const sessions = await listOwnedTranscriptSessions(controller.signal);
      if (controller.signal.aborted) return;
      setSavedServerSessions(sessions);
      setFeedback(sessions.length ? "Showing the most recent 100 saved sessions at most for the signed-in account. Select one to recover." : "No saved sessions were returned for this signed-in account.");
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to list saved sessions.");
    } finally {
      if (sessionListAbortRef.current === controller) { sessionListAbortRef.current = null; setIsFindingServerSessions(false); }
    }
  }, []);
  const recoverServerSession = useCallback(async (selectedId?: string) => {
    const id = selectedId ?? serverSessionId;
    if (!id || captureActive || stoppingRef.current) return;
    const epoch = ++recoveryEpochRef.current;
    const startingSessionId = serverSessionIdRef.current;
    try {
      const saved = await loadSavedTranscriptSession(id);
      if (epoch !== recoveryEpochRef.current || serverSessionIdRef.current !== startingSessionId) return;
      // Selecting metadata is not a save acknowledgement. Adopt the cursor only
      // after the owner-scoped full read succeeds.
      serverSessionIdRef.current = saved.sessionId;
      setServerSessionId(saved.sessionId);
      try { window.localStorage.setItem("cloud-nexus-pilot:last-owned-stream-session", saved.sessionId); } catch { /* Recovery remains valid without a local cursor. */ }
      setSavedGuidance(savedGuidanceAssociations(saved));
      const restored = saved.events.map((event) => ({
        id: event.id ?? `saved-${event.sequence}`,
        chunkIndex: Number.isSafeInteger(event.provider_result?.chunkIndex) ? event.provider_result!.chunkIndex! : event.sequence,
        text: event.text, source: event.source, createdAt: Date.parse(event.captured_at ?? "") || Date.now(),
      }));
      const text = restored.map((event) => event.text).join("\n");
      setTranscript(text); transcriptRef.current = text;
      setSegments(restored); segmentsRef.current = restored;
      setLatestSegment(restored.at(-1)?.text ?? "");
      setActiveTranscriptId(null);
      setServerSaveState("saved");
      setStatus("stopped");
      setFeedback(saved.captureGap || "Saved final events restored. Live audio gaps are not recoverable.");
      setError("");
    } catch (error) {
      if (epoch !== recoveryEpochRef.current || serverSessionIdRef.current !== startingSessionId) return;
      setError(error instanceof Error ? error.message : "Unable to recover saved session.");
      setServerSaveState("failed");
    }
  }, [serverSessionId, captureActive]);
  const exportServerSession = useCallback(async () => {
    if (!serverSessionId) return;
    try {
      await loadSavedTranscriptSession(serverSessionId);
      const link = document.createElement("a");
      link.href = `/api/transcribe/stream/session/${encodeURIComponent(serverSessionId)}?format=export`;
      link.download = "pilot-session.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setFeedback("Export requested from acknowledged server records. Check your browser's downloads; an export is not confirmed until the file is saved.");
      setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to export saved session."); }
  }, [serverSessionId]);
  const deleteServerSession = useCallback(async () => {
    if (!serverSessionId || captureActive || stoppingRef.current) return;
    const epoch = ++recoveryEpochRef.current;
    try {
      await deleteSavedTranscriptSession(serverSessionId);
      setSavedServerSessions(current => current.filter(item => item.sessionId !== serverSessionId));
      if (epoch !== recoveryEpochRef.current || serverSessionIdRef.current !== serverSessionId) return;
      try { window.localStorage.removeItem("cloud-nexus-pilot:last-owned-stream-session"); } catch { /* Server deletion is already acknowledged. */ }
      serverSessionIdRef.current = null; setServerSessionId(null); setServerSaveState("unavailable"); setSavedGuidance([]);
      setTranscript(""); transcriptRef.current = "";
      setSegments([]); segmentsRef.current = [];
      setLatestSegment(""); setDraftSegment("");
      setFeedback("Server session deletion acknowledged. Separate browser-local transcript copies must be deleted from local history too.");
      setError("");
    } catch (error) {
      if (epoch !== recoveryEpochRef.current || serverSessionIdRef.current !== serverSessionId) return;
      setError(error instanceof Error ? error.message : "Unable to delete saved session.");
    }
  }, [serverSessionId, captureActive]);

  const clearTranscript = useCallback(() => {
    stopInternal();
    chunkIndexRef.current = 0;
    setTranscript("");
    setLatestSegment("");
    setSegments([]);
    setSelectedFileName("");
    setError("");
    setFeedback("Transcript workspace cleared.");
    setStatus(isAudioCaptureSupported() ? "idle" : "unsupported");
    setActiveTranscriptId(null);
    activeByteSizeRef.current = 0;
    activeCaptureModeRef.current = "live-capture";
    activeContentTypeRef.current = "audio/webm";
    activeFilenameRef.current = "live-capture.webm";
    seedChunkRef.current = null;
    pendingChunkPartsRef.current = [];
    pendingChunkBytesRef.current = 0;
    aiQuestionAbortRef.current?.abort();
    aiQuestionAbortRef.current = null;
    aiQuestionInFlightRef.current = false;
    setAiDetectedQuestion("");
    pendingLiveSegmentRef.current = "";
    pendingLiveSegmentAgeRef.current = null;
    pendingLiveSegmentSpeakerRef.current = null;
    transcriptRef.current = "";
    segmentsRef.current = [];
  }, [stopInternal]);

  const uploadFile = useCallback(
    async (file: File) => {
      stopInternal();
      const uploadController = new AbortController();
      fileUploadAbortRef.current = uploadController;
      setSelectedFileName(file.name);
      setError("");
      setFeedback("");
      setStatus("receiving-transcript");

      try {
        const uploadResult = await transcribeUploadedAsset(file, uploadController.signal);
        if (uploadController.signal.aborted) return;
        const nextTranscript = cleanTranscriptText(uploadResult.transcript);
        const nextRecordSegments =
          nextTranscript.length > 0
            ? [
                {
                  id: `upload-${Date.now()}`,
                  chunkIndex: 0,
                  text: nextTranscript,
                  source: "microphone" as const,
                  speakerId: null,
                  createdAt: Date.now(),
                },
              ]
            : [];

        startTransition(() => {
          setTranscript(nextTranscript);
          setLatestSegment(nextTranscript.split("\n").at(-1) ?? nextTranscript);
          setSegments(nextRecordSegments);
          setStatus(nextTranscript ? "stopped" : "no-speech-yet");
        });

        transcriptRef.current = nextTranscript;
        segmentsRef.current = nextRecordSegments;
        activeCaptureModeRef.current = "file-upload";
        activeContentTypeRef.current = uploadResult.contentType;
        activeFilenameRef.current = file.name;
        activeByteSizeRef.current = file.size;
        setActiveTranscriptId(null);

        const result = await repository.createTranscript(
          {
            filename: file.name,
            contentType: uploadResult.contentType,
            byteSize: file.size,
            captureMode: "file-upload",
            source: "microphone",
          },
          {
            transcriptText: nextTranscript,
            segments: nextRecordSegments.map((segment) => ({
              id: segment.id,
              chunkIndex: segment.chunkIndex,
              text: segment.text,
              source: segment.source,
              contentType: uploadResult.contentType,
              createdAt: segment.createdAt,
              durationMs: null,
            })),
            status: nextTranscript ? "completed" : "processing",
          }
        );
        if (uploadController.signal.aborted) return;
        setActiveTranscriptId(result.transcript.id);
        setTranscriptRecords((current) => [result.transcript, ...current]);
        setPersistenceInfo(result.persistence);
        void loadTranscriptInventory();
        console.info("[transcription][upload] verification-complete", {
          fileName: uploadResult.fileName,
          verificationSource: uploadResult.source,
          contentType: uploadResult.contentType,
          chars: nextTranscript.length,
          durationMs: uploadResult.durationMs ?? null,
          hasTranscript: nextTranscript.length > 0,
        });
        setFeedback(
          uploadResult.source === "audio-backend"
            ? nextTranscript
              ? "Backend transcription verified. The uploaded audio file was sent through /api/transcribe and the returned transcript is now shown below."
              : "Backend transcription completed for the uploaded audio file, but no speech was detected."
            : nextTranscript
              ? "Text upload loaded into the transcript surface."
              : "Upload received. No transcript text was found in the provided file."
        );
      } catch (uploadError) {
        if (uploadController.signal.aborted) return;
        const message =
          uploadError instanceof Error
            ? uploadError.message
            : "Unable to process the selected file.";
        console.error("[transcription][upload] verification-failed", {
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
          message,
        });
        setError(message);
        setStatus("failed");
      } finally {
        if (fileUploadAbortRef.current === uploadController) fileUploadAbortRef.current = null;
      }
    },
    [loadTranscriptInventory, repository, stopInternal]
  );

  const loadLocalScenario = useCallback(
    (scenario: LocalTranscriptionScenario) => {
      stopInternal();
      chunkIndexRef.current = scenario.segments.length;
      setTranscript(scenario.transcript);
      setLatestSegment(scenario.latestSegment);
      setSegments(scenario.segments);
      setSelectedFileName(scenario.selectedFileName);
      setError("");
      setFeedback(scenario.feedback);
      setStatus("stopped");
      setActiveTranscriptId(null);
      activeByteSizeRef.current = scenario.transcript.length;
      activeCaptureModeRef.current = "file-upload";
      activeContentTypeRef.current = "text/plain";
      activeFilenameRef.current = scenario.selectedFileName;
      transcriptRef.current = scenario.transcript;
      segmentsRef.current = scenario.segments;
    },
    [stopInternal]
  );

  const selectTranscript = useCallback(
    async (id: TranscriptId) => {
      recoveryEpochRef.current += 1;
      const result = await repository.getTranscriptById(id);
      if (!result.transcript) {
        setError("Selected transcript could not be found.");
        return;
      }

      hydrateFromTranscriptRecord(result.transcript);
      writeTranscriptWorkspaceRecoveryIntent(result.transcript.id);
      setPersistenceInfo(result.persistence);
      setFeedback(
        `Loaded "${result.transcript.title}" from local transcript history for browser-local workspace recovery.`
      );
      setError("");
      setStatus("stopped");
    },
    [hydrateFromTranscriptRecord, repository]
  );

  const deleteTranscript = useCallback(
    async (id: TranscriptId) => {
      const result = await repository.deleteTranscript(id);
      setTranscriptRecords((current) => current.filter((item) => item.id !== id));
      setPersistenceInfo(result.persistence);
      void loadTranscriptInventory();

      if (activeTranscriptIdRef.current === id) {
        setActiveTranscriptId(null);
        setTranscript("");
        setLatestSegment("");
        setSegments([]);
        setSelectedFileName("");
        setStatus(isAudioCaptureSupported() ? "idle" : "unsupported");
        transcriptRef.current = "";
        segmentsRef.current = [];
      }

      setFeedback("Transcript removed from local history.");
      setError("");
    },
    [loadTranscriptInventory, repository]
  );

  const importLocalTranscripts = useCallback(async () => {
    setIsImporting(true);
    setError("");
    setFeedback("");

    try {
      const result = await repository.importLocalTranscriptsToCloud();
      setTranscriptRecords(result.transcripts);
      setPersistenceInfo(result.persistence);
      setImportStatus(result.importStatus);

      const selectedTranscript =
        result.transcripts.find((item) => item.id === activeTranscriptIdRef.current) ??
        result.transcripts[0] ??
        null;

      if (selectedTranscript) {
        hydrateFromTranscriptRecord(selectedTranscript);
      }

      setFeedback(
        result.importedCount > 0
          ? `Imported ${result.importedCount} local transcript${result.importedCount === 1 ? "" : "s"} into cloud history without overwriting existing cloud records.`
          : "No local transcripts needed import. Your cloud history already contains the current transcript set."
      );
    } catch (importError) {
      const message =
        importError instanceof Error
          ? importError.message
          : "Unable to import local transcripts right now.";
      setError(message);
    } finally {
      setIsImporting(false);
    }
  }, [hydrateFromTranscriptRecord, repository]);

  useEffect(() => {
    return () => {
      stopInternal();
    };
  }, [stopInternal]);

  const transcriptSummary = useMemo(() => summarizeTranscriptState(transcript), [transcript]);
  const questionBoundaryDetected = useMemo(
    () => {
      const detectedQuestion = getDetectedQuestion(latestSegment);
      return Boolean(detectedQuestion && !isIncompleteDetectedQuestion(detectedQuestion));
    },
    [latestSegment]
  );
  const latestDetectedQuestion = useMemo(() => {
    const detectedQuestion = getDetectedQuestion(latestSegment) ?? "";
    return detectedQuestion && !isIncompleteDetectedQuestion(detectedQuestion) ? detectedQuestion : "";
  }, [latestSegment]);
  const activeTranscriptRecord = useMemo(
    () => transcriptRecords.find((item) => item.id === activeTranscriptId) ?? null,
    [activeTranscriptId, transcriptRecords]
  );

  return {
    status,
    transcript,
    latestSegment,
    draftSegment,
    segments,
    selectedFileName,
    error,
    feedback,
    transportStatus,
    transportFallbackReason,
    source,
    isSupported: isAudioCaptureSupported(),
    systemAudioSupported: canCaptureSystemAudio(),
    serverSessionId,
    savedGuidance,
    ensureServerSession,
    refreshServerGuidance,
    serverSaveState,
    recoverServerSession,
    findServerSessions,
    savedServerSessions,
    isFindingServerSessions,
    exportServerSession,
    deleteServerSession,
    isRecording: captureActive || status === "connecting",
    isPaused,
    audioLevel,
    pauseCapture,
    resumeCapture,
    isTranscribing: activeUploads > 0 || status === "receiving-transcript",
    canUseTranscript: Boolean(transcript.trim() || latestSegment.trim()),
    transcriptSummary,
    questionBoundaryDetected,
    latestDetectedQuestion,
    aiDetectedQuestion,
    transcriptRecords,
    activeTranscriptId,
    activeTranscriptRecord,
    persistenceInfo,
    importStatus,
    isImporting,
    setSource,
    startCapture,
    stopCapture,
    clearTranscript,
    uploadFile,
    loadLocalScenario,
    selectTranscript,
    deleteTranscript,
    importLocalTranscripts,
  };
}
