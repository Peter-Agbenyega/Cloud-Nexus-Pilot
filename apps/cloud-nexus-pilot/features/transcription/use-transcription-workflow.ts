"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  canCaptureSystemAudio,
  createCaptureStream,
  getPreferredMimeType,
  isAudioCaptureSupported,
  type LiveTranscriptionSource,
} from "@/features/transcription/audio-capture";
import {
  cleanTranscriptText,
  detectQuestionBoundary,
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
  | "stopped"
  | "unsupported"
  | "failed";

export type TranscriptionTransportStatus =
  | "idle"
  | "streaming-session-creating"
  | "streaming-session-connected"
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
  isRecording: boolean;
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
  startCapture: (options?: StartCaptureOptions) => Promise<void>;
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
const MIN_UPLOAD_CHUNK_BYTES = 1_024;
const MIN_RAW_CHUNK_BYTES = 256;
const MAX_BUFFERED_CHUNKS_BEFORE_UPLOAD = 3;
const PCM_CHUNK_FLUSH_INTERVAL_MS = DEFAULT_CHUNK_INTERVAL_MS;
const PCM_MIN_FRAMES_PER_CHUNK = 64_000;
const MIN_LIVE_SEGMENT_WORDS = 5;
const MAX_LIVE_SEGMENT_BUFFER_MS = 4_000;
const MAX_IN_FLIGHT_LIVE_CHUNKS = 6;
const LIVE_SEGMENT_MERGE_WINDOW_MS = 10_000;
const SHORT_LIVE_FRAGMENT_WORDS = 8;
const shouldDebugLogs = process.env.NODE_ENV !== "production";

const WHISPER_SILENCE_HALLUCINATIONS = new Set([
  "thank you",
  "thank you for watching",
  "thank you for joining us",
  "thanks for watching",
  "please subscribe",
  "music",
  "applause",
  "you should not receive a live exit from the train in the netherlands",
]);

const QUESTION_CUE_PATTERNS = [
  /\b(who|what|when|where|why|how|explain|describe)\b/i,
  /\btell me\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
] as const;

const DOMAIN_CONTEXT_PATTERNS = [
  /\bcloud nexus pilot\b/i,
  /\binterview copilot\b/i,
  /\bmock interview\b/i,
  /\brecruiter screen\b/i,
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

function containsDomainContext(text: string): boolean {
  return DOMAIN_CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function isLikelyHallucinatedTranscript(text: string): boolean {
  const normalized = normalizeTranscriptForFiltering(text);
  if (!normalized) return true;

  // Avoid Whisper silence hallucinations from noisy chunks before they become transcript segments.
  if (containsQuestionCue(text)) return false;
  if (WHISPER_SILENCE_HALLUCINATIONS.has(normalized)) return true;
  if (containsDomainContext(text)) return false;

  return countMeaningfulWords(text) < 4;
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
  const audioPipelineRef = useRef<LiveAudioPipelineHandle | null>(null);
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
  const aiQuestionAbortRef = useRef<AbortController | null>(null);
  const pendingLiveSegmentRef = useRef("");
  const pendingLiveSegmentAgeRef = useRef<number | null>(null);
  const pendingLiveSegmentSpeakerRef = useRef<number | null>(null);
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

  const hydrateFromTranscriptRecord = useCallback((record: TranscriptRecord | null) => {
    if (!record) return;

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
  }, []);

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

      const connectPromise = createStreamingTranscriptClient({
        onLog: (entry) => {
          if (shouldDebugLogs) {
            console.log("[transcription][streaming]", entry);
          }
          if (entry.event === "sse-connect-open") {
            setTransportStatus("streaming-session-connected");
            setTransportFallbackReason("");
            setError("");
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
          if (!response?.text?.trim()) return;

          startTransition(() => {
            setDraftSegment(response.text.trim());
            setStatus("receiving-transcript");
          });
        },
      })
        .then((client) => {
          streamingClientRef.current = client;
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
          const message =
            error instanceof Error ? error.message : "Unable to initialize streaming transcript session.";
          streamingFallbackReasonRef.current = `streaming-connect-failed: ${message}`;
          setTransportStatus("streaming-session-failed");
          setTransportFallbackReason(message);
          logStreamingSeam("create-failed", `reason=${reason};error=${message}`);
          return null;
        })
        .finally(() => {
          streamingConnectPromiseRef.current = null;
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
      if (isLikelyHallucinatedTranscript(cleaned)) {
        if (shouldDebugLogs) {
          console.log("[transcription] segment suppressed: likely silence hallucination", {
            chunkIndex,
            text: cleaned,
          });
        }
        return null;
      }

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

  const triggerAiQuestionDetection = useCallback((segments: TranscriptSegment[]) => {
    if (aiQuestionInFlightRef.current) {
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
        setAiDetectedQuestion(payload.question?.trim() || "");
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
      });
  }, []);

  const stopInternal = useCallback(() => {
    audioPipelineRef.current?.stop();
    audioPipelineRef.current = null;
    recorderRef.current?.stop();
    recorderRef.current = null;
    flushPendingLiveSegment(chunkIndexRef.current, sourceRef.current);
    aiQuestionAbortRef.current?.abort();
    aiQuestionAbortRef.current = null;
    aiQuestionInFlightRef.current = false;
    setAiDetectedQuestion("");
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
  }, [flushPendingLiveSegment]);

  const processAudioChunk = useCallback(
    async (audioBlob: Blob, chunkIndex: number, nextSource: LiveTranscriptionSource, overrideContentType?: string) => {
      if (audioBlob.size === 0) return;

      if (inFlightChunkCountRef.current >= MAX_IN_FLIGHT_LIVE_CHUNKS) {
        console.warn("[transcription] live chunk skipped: too many uploads in flight", {
          chunkIndex,
          inFlightUploads: inFlightChunkCountRef.current,
          maxInFlightUploads: MAX_IN_FLIGHT_LIVE_CHUNKS,
          size: audioBlob.size,
          source: nextSource,
        });
        setFeedback("Live transcription is still catching up. A chunk was skipped to keep the session stable.");
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

        let result: Awaited<ReturnType<StreamingTranscriptClient["sendChunk"]>> | null = null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            result = await streamingClient.sendChunk({
              blob: audioBlob,
              chunkIndex,
              source: nextSource,
              contentType,
            });
            break;
          } catch (streamingError) {
            const message =
              streamingError instanceof Error
                ? streamingError.message
                : "Unable to process the latest audio chunk.";
            const shouldRetry = attempt === 0 && shouldResetStreamingClient(message);

            if (!shouldRetry) {
              throw streamingError;
            }

            console.warn("[transcription] streaming session reset after chunk failure", {
              chunkIndex,
              message,
            });
            resetStreamingClient(message);
            streamingClient = await ensureStreamingClient("chunk-send");

            if (!streamingClient) {
              const reason = streamingFallbackReasonRef.current || message;
              setTransportStatus("streaming-session-failed");
              setTransportFallbackReason(reason);
              throw new Error(reason);
            }
          }
        }

        if (!result) {
          throw new Error("Unable to process the latest audio chunk.");
        }

        setTransportStatus("streaming-session-connected");
        setTransportFallbackReason("");
        activeByteSizeRef.current += audioBlob.size;
        activeContentTypeRef.current = result.contentType || contentType;

        const cleanedChunkText = cleanTranscriptText(result.text) || result.text.trim();
        const shouldSuppressChunk =
          Boolean(cleanedChunkText) && isLikelyHallucinatedTranscript(cleanedChunkText);
        if (!cleanedChunkText || shouldSuppressChunk) {
          if (shouldDebugLogs) {
            console.log("[transcription] transcript accepted: no usable speech detected", {
              chunkIndex: result.chunkIndex,
              size: audioBlob.size,
              textLength: result.text.length,
              source: result.source,
              suppressed: shouldSuppressChunk,
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
          setFeedback("Receiving transcript from OpenAI in near real time.");
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
        setStatus("receiving-transcript");
        setFeedback("Receiving transcript from OpenAI in near real time.");
        setError("");
      } catch (uploadError) {
        const message =
          uploadError instanceof Error
            ? uploadError.message
            : "Unable to process the latest audio chunk.";
        const canContinueSession =
          streamingClientRef.current !== null || streamingConnectPromiseRef.current !== null;
        if (canContinueSession) {
          console.warn("[transcription] live chunk failed; session remains active", {
            chunkIndex,
            message,
          });
          setError(message);
          setFeedback("The latest live audio chunk failed, but the session is still listening.");
          setStatus(transcriptRef.current.trim() ? "receiving-transcript" : "listening");
          return;
        }
        setError(message);
        setStatus("failed");
        logStreamingSeam("create-failed", message);
        await persistCurrentTranscript({
          transcriptText: transcriptRef.current,
          segments: segmentsRef.current,
          status: "failed",
          source: sourceRef.current,
          filename: activeFilenameRef.current,
          contentType: activeContentTypeRef.current,
          byteSize: activeByteSizeRef.current,
          captureMode: activeCaptureModeRef.current,
          errorMessage: message,
        });
      } finally {
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
    },
    [
      ensureStreamingClient,
      flushPendingLiveSegment,
      logStreamingSeam,
      persistCurrentTranscript,
      resetStreamingClient,
      shouldResetStreamingClient,
      triggerAiQuestionDetection,
    ]
  );

  const startCapture = useCallback(
    async (options?: StartCaptureOptions) => {
      if (!isAudioCaptureSupported()) {
        setStatus("unsupported");
        setError("Audio capture is unsupported in this browser.");
        return;
      }

      if (recorderRef.current?.state === "recording" || audioPipelineRef.current) {
        return;
      }

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
      setAiDetectedQuestion("");
      pendingLiveSegmentRef.current = "";
      pendingLiveSegmentAgeRef.current = null;
      pendingLiveSegmentSpeakerRef.current = null;
      const nextSource = options?.source ?? sourceRef.current;
      if (options?.source && options.source !== sourceRef.current) {
        setSource(options.source);
      }
      activeCaptureModeRef.current = "live-capture";
      activeContentTypeRef.current = getPreferredMimeType() || "audio/webm";
      activeFilenameRef.current = `live-capture-${Date.now()}.webm`;
      activeByteSizeRef.current = 0;
      chunkIndexRef.current = 0;
      seedChunkRef.current = null;
      pendingChunkPartsRef.current = [];
      pendingChunkBytesRef.current = 0;
      setActiveTranscriptId(null);

      try {
        const initialStreamingClient = await ensureStreamingClient("session-start");
        if (!initialStreamingClient) {
          throw new Error(
            streamingFallbackReasonRef.current || "Streaming session create failed."
          );
        }
        setTransportStatus("streaming-session-connected");
        setTransportFallbackReason("");
        logStreamingSeam("fallback-cleared", "streaming-session-active");

        const sourceStream = options?.existingStream ?? (await createCaptureStream(nextSource));
        const audioTracks = sourceStream.getAudioTracks();
        if (audioTracks.length === 0) {
          throw new Error("No live audio track was found for this capture source.");
        }

        // Keep transcription capture audio-only so downstream chunks are stable.
        const stream = new MediaStream(audioTracks);
        streamRef.current = stream;
        ownsStreamRef.current = !options?.existingStream;

        // Prefer Web Audio PCM chunks first to keep live streaming inputs stable.
        // MediaRecorder remains only as an alternate capture mechanism into the same streaming path.
        if (isPcmAudioPipelineSupported()) {
          try {
            audioPipelineRef.current = await createLiveAudioPipeline({
              stream,
              flushIntervalMs: PCM_CHUNK_FLUSH_INTERVAL_MS,
              minFramesPerChunk: PCM_MIN_FRAMES_PER_CHUNK,
              onDebug: (event, metadata) => {
                if (shouldDebugLogs) {
                  console.log("[transcription][pcm-pipeline]", event, metadata ?? {});
                }
              },
              onError: (pipelineError) => {
                setError(pipelineError.message);
                setStatus("failed");
              },
              onChunk: (chunk) => {
                const chunkIndex = chunkIndexRef.current;
                chunkIndexRef.current += 1;
                if (shouldDebugLogs) {
                  console.log("[transcription] batch upload queued", {
                    chunkIndex,
                    size: chunk.blob.size,
                    contentType: chunk.contentType,
                    durationMs: chunk.durationMs,
                    engine: "pcm-pipeline",
                  });
                }
                void processAudioChunk(chunk.blob, chunkIndex, nextSource, chunk.contentType);
              },
            });

            setStatus("listening");
            setFeedback(
              "Live PCM audio pipeline connected. Waiting for speech for near real-time transcription."
            );
            return;
          } catch (pipelineStartError) {
            console.warn("[transcription] PCM pipeline failed, falling back to MediaRecorder", {
              error:
                pipelineStartError instanceof Error
                  ? pipelineStartError.message
                  : "unknown pipeline start error",
            });
            audioPipelineRef.current = null;
          }
        }

        const mimeType = getPreferredMimeType();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) return;

          const blob = event.data;
          if (shouldDebugLogs) {
            console.log("[transcription] media chunk captured", {
              size: blob.size,
              type: blob.type || recorder.mimeType || "audio/webm",
            });
          }

          if (blob.size < MIN_RAW_CHUNK_BYTES) {
            if (shouldDebugLogs) {
              console.log("[transcription] chunk skipped: tiny media chunk", {
                size: blob.size,
                minimum: MIN_RAW_CHUNK_BYTES,
              });
            }
            return;
          }

          if (!seedChunkRef.current) {
            seedChunkRef.current = blob;
            if (shouldDebugLogs) {
              console.log("[transcription] chunk buffered as seed segment", {
                size: blob.size,
              });
            }
            return;
          }

          pendingChunkPartsRef.current.push(blob);
          pendingChunkBytesRef.current += blob.size;

          const hasEnoughBytes = pendingChunkBytesRef.current >= MIN_UPLOAD_CHUNK_BYTES;
          const hasEnoughParts =
            pendingChunkPartsRef.current.length >= MAX_BUFFERED_CHUNKS_BEFORE_UPLOAD;
          if (!hasEnoughBytes && !hasEnoughParts) {
            if (shouldDebugLogs) {
              console.log("[transcription] chunk buffered: awaiting larger batch", {
                pendingParts: pendingChunkPartsRef.current.length,
                pendingBytes: pendingChunkBytesRef.current,
                targetBytes: MIN_UPLOAD_CHUNK_BYTES,
              });
            }
            return;
          }

          const uploadType = recorder.mimeType || blob.type || "audio/webm";
          const uploadBlob = new Blob(
            [seedChunkRef.current, ...pendingChunkPartsRef.current],
            { type: uploadType }
          );
          if (uploadBlob.size < MIN_UPLOAD_CHUNK_BYTES) {
            if (shouldDebugLogs) {
              console.log("[transcription] chunk skipped: upload batch below threshold", {
                size: uploadBlob.size,
                minimum: MIN_UPLOAD_CHUNK_BYTES,
              });
            }
            pendingChunkPartsRef.current = [];
            pendingChunkBytesRef.current = 0;
            return;
          }

          const chunkIndex = chunkIndexRef.current;
          chunkIndexRef.current += 1;
          if (shouldDebugLogs) {
            console.log("[transcription] batch upload queued", {
              chunkIndex,
              size: uploadBlob.size,
              contentType: uploadType,
              parts: pendingChunkPartsRef.current.length + 1,
            });
          }
          pendingChunkPartsRef.current = [];
          pendingChunkBytesRef.current = 0;
          void processAudioChunk(uploadBlob, chunkIndex, nextSource);
        };

        recorder.onerror = () => {
          setStatus("failed");
          setError("Recording failed. Please stop and try again.");
        };

        recorder.onstop = () => {
          if (activeUploadsRef.current === 0) {
            setStatus("stopped");
            setFeedback(
              "Listening stopped. Transcript text remains visible for review in this session."
            );
          }
        };

        recorderRef.current = recorder;
        recorder.start(DEFAULT_CHUNK_INTERVAL_MS);
        setStatus("listening");
        setFeedback(
          "Live audio stream and transcription runtime are connected. Waiting for speech."
        );
      } catch (startError) {
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
      }
    },
    [ensureStreamingClient, logStreamingSeam, processAudioChunk, stopInternal]
  );

  const stopCapture = useCallback(() => {
    stopInternal();
    setStatus(activeUploadsRef.current > 0 ? "receiving-transcript" : "stopped");
  }, [stopInternal]);

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
      setSelectedFileName(file.name);
      setError("");
      setFeedback("");
      setStatus("receiving-transcript");

      try {
        const uploadResult = await transcribeUploadedAsset(file);
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
    () => detectQuestionBoundary(latestSegment),
    [latestSegment]
  );
  const latestDetectedQuestion = useMemo(() => getDetectedQuestion(latestSegment) ?? "", [latestSegment]);
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
    isRecording:
      status === "connecting" ||
      status === "listening" ||
      status === "receiving-transcript" ||
      status === "no-speech-yet",
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
