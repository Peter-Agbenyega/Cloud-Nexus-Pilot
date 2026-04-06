export type TranscriptSource = "microphone" | "system-audio";

export type TranscriptId = string;
export type TranscriptStatus = "uploaded" | "processing" | "completed" | "failed";
export type TranscriptCaptureMode = "live-capture" | "file-upload";

export type TranscriptSegment = {
  id: string;
  chunkIndex: number;
  text: string;
  source: TranscriptSource;
  contentType: string;
  durationMs?: number | null;
  speakerId?: number | null;
  createdAt: number;
};

export type TranscriptSummary = {
  preview: string;
  latestSegment: string;
  wordCount: number;
  questionBoundaryDetected: boolean;
};

export type TranscriptRecord = {
  id: TranscriptId;
  title: string;
  filename: string;
  status: TranscriptStatus;
  captureMode: TranscriptCaptureMode;
  source: TranscriptSource | null;
  contentType: string;
  transcriptText: string;
  segments: TranscriptSegment[];
  summary: TranscriptSummary;
  byteSize: number;
  durationMs?: number | null;
  storageKey?: string | null;
  errorMessage?: string | null;
  createdAt: number;
  updatedAt: number;
  ownerScope: "local-user" | "authenticated-user";
  ownerId: string | null;
  version: 1;
};

export type UploadTranscriptInput = {
  title?: string;
  filename: string;
  contentType: string;
  byteSize: number;
  captureMode: TranscriptCaptureMode;
  source?: TranscriptSource;
  storageKey?: string | null;
  chunkIndex?: number;
};

export type TranscriptionRequestHeaders = {
  chunkIndex?: number;
  source?: TranscriptSource;
  filename?: string;
  contentType: string;
};

export type TranscriptionResponse = {
  text: string;
  chunkIndex: number;
  source: TranscriptSource;
  contentType: string;
  durationMs?: number | null;
  speakerId?: number | null;
};

export type UploadTranscriptResponse = {
  transcript: TranscriptRecord;
  source: "local" | "remote";
};

export type TranscriptListResponse = {
  transcripts: TranscriptRecord[];
  source: "local" | "remote";
};

export type TranscriptResponse = {
  transcript: TranscriptRecord;
  source: "local" | "remote";
};

export type TranscriptProcessingResponse = {
  transcript: TranscriptRecord;
  segment?: TranscriptSegment;
  source: "local" | "remote";
};

export type TranscriptValidationError = {
  field:
    | "title"
    | "filename"
    | "contentType"
    | "byteSize"
    | "source"
    | "chunkIndex"
    | "storageKey"
    | "id";
  code: "required" | "invalid" | "unsupported" | "too_large" | "not_found" | "forbidden";
  message: string;
};

export type TranscriptApiError = {
  error: {
    code:
      | "transcript_validation_failed"
      | "transcript_not_found"
      | "transcript_access_denied"
      | "transcript_processing_failed"
      | "transcript_backend_unavailable";
    message: string;
    details?: TranscriptValidationError[];
  };
};

export const TRANSCRIPTION_ENDPOINTS = {
  transcribe: "/transcribe",
  upload: "/transcripts",
  list: "/transcripts",
  detail: "/transcripts/:id",
  status: "/transcripts/:id/status",
} as const;

export const TRANSCRIPTION_STORAGE_OWNERSHIP = {
  currentMode: "local-user",
  ownerId: null,
  authRequired: false,
  futureOwnerSource: "supabase-auth-user-id",
  storageBoundary:
    "v1 remains local-first in browser memory and local file selection. Future persistence should store transcript metadata in the backend and large binary files in object storage.",
} as const;

export const TRANSCRIPTION_CONTRACT_VERSION = {
  version: 1,
  note: "v1 keeps the current frontend capture, upload, and transcript review model stable while backend persistence is added later.",
} as const;

export function createTranscriptionRequestHeaders(
  input: TranscriptionRequestHeaders
): HeadersInit {
  return {
    "Content-Type": input.contentType,
    "X-Chunk-Index": String(input.chunkIndex ?? 0),
    "X-Transcript-Source": input.source ?? "microphone",
    "X-Audio-Filename": input.filename?.trim() || "chunk.webm",
  };
}

export function buildTranscriptSummary(
  transcriptText: string,
  latestSegment = ""
): TranscriptSummary {
  const normalizedText = transcriptText.trim();
  const preview =
    normalizedText.length > 180
      ? `${normalizedText.slice(0, 177).trimEnd()}...`
      : normalizedText;
  const wordCount = normalizedText ? normalizedText.split(/\s+/).filter(Boolean).length : 0;
  const questionBoundaryDetected =
    normalizedText.includes("?") || wordCount > 15 || latestSegment.includes("?");

  return {
    preview: preview || "No transcript available yet.",
    latestSegment: latestSegment.trim(),
    wordCount,
    questionBoundaryDetected,
  };
}

export function createTranscriptSegment(
  response: TranscriptionResponse,
  createdAt = Date.now()
): TranscriptSegment {
  return {
    id: `segment-${createdAt}-${response.chunkIndex}`,
    chunkIndex: response.chunkIndex,
    text: response.text.trim(),
    source: response.source,
    contentType: response.contentType,
    durationMs: response.durationMs ?? null,
    speakerId: response.speakerId ?? null,
    createdAt,
  };
}

export function createTranscriptRecord(
  input: UploadTranscriptInput,
  transcriptText = "",
  segments: ReadonlyArray<TranscriptSegment> = [],
  status: TranscriptStatus = "uploaded"
): TranscriptRecord {
  const timestamp = Date.now();
  const normalizedTitle = input.title?.trim() || input.filename.replace(/\.[^.]+$/, "") || "Untitled Transcript";
  const latestSegment = segments.at(-1)?.text ?? transcriptText;

  return {
    id: `transcript-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    title: normalizedTitle,
    filename: input.filename.trim(),
    status,
    captureMode: input.captureMode,
    source: input.source ?? null,
    contentType: input.contentType.trim(),
    transcriptText: transcriptText.trim(),
    segments: [...segments],
    summary: buildTranscriptSummary(transcriptText, latestSegment),
    byteSize: input.byteSize,
    durationMs: segments.reduce<number | null>((total, segment) => {
      if (segment.durationMs == null) return total;
      return (total ?? 0) + segment.durationMs;
    }, null),
    storageKey: input.storageKey?.trim() || null,
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerScope: "local-user",
    ownerId: null,
    version: 1,
  };
}

export function updateTranscriptRecord(
  existing: TranscriptRecord,
  updates: {
    title?: string;
    filename?: string;
    status?: TranscriptStatus;
    source?: TranscriptSource | null;
    contentType?: string;
    transcriptText?: string;
    segments?: ReadonlyArray<TranscriptSegment>;
    byteSize?: number;
    durationMs?: number | null;
    storageKey?: string | null;
    errorMessage?: string | null;
  }
): TranscriptRecord {
  const nextTranscriptText = updates.transcriptText ?? existing.transcriptText;
  const nextSegments = updates.segments ? [...updates.segments] : existing.segments;
  const latestSegment = nextSegments.at(-1)?.text ?? existing.summary.latestSegment;

  return {
    ...existing,
    title: updates.title?.trim() || existing.title,
    filename: updates.filename?.trim() || existing.filename,
    status: updates.status ?? existing.status,
    source: updates.source === undefined ? existing.source : updates.source,
    contentType: updates.contentType?.trim() || existing.contentType,
    transcriptText: nextTranscriptText.trim(),
    segments: nextSegments,
    summary: buildTranscriptSummary(nextTranscriptText, latestSegment),
    byteSize: updates.byteSize ?? existing.byteSize,
    durationMs: updates.durationMs === undefined ? existing.durationMs : updates.durationMs,
    storageKey: updates.storageKey === undefined ? existing.storageKey : updates.storageKey,
    errorMessage:
      updates.errorMessage === undefined ? existing.errorMessage : updates.errorMessage,
    updatedAt: Date.now(),
  };
}
