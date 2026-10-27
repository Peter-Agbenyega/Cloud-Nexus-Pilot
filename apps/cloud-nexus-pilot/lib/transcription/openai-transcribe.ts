import { readBoundedBytes } from "../server/request-boundary";
import { openAiEndpoint } from "../server/provider-endpoint";
import { cleanTranscriptText } from "@/features/transcription/transcript-bridge";
import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";
import { toPublicTranscriptionError } from "./public-error";

const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const TRANSCRIPTION_CONTEXT_PROMPT =
  "Cloud Nexus Pilot is an AI interview copilot. Common phrases include Cloud Nexus Pilot, interview copilot, microphone transcription, tab audio, share tab audio, longer audio chunks, recruiter screen, mock interview, resume studio, culture scanner, AI-powered answer guidance.";
const shouldDebugLogs = process.env.NODE_ENV !== "production";

type OpenAiTranscriptionResponse = {
  text?: string;
};

export class OpenAiTranscriptionError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(params: { status: number; code: string; message?: string; detail?: string }) {
    const safe = toPublicTranscriptionError(params);
    super(safe.error.message);
    this.name = "OpenAiTranscriptionError";
    this.status = safe.status;
    this.code = safe.error.code;
    this.detail = "";
  }
}

function getOpenAiApiKey(): string {
  return process.env.OPENAI_API_KEY?.trim() ?? "";
}

function getOpenAiTranscriptionModel(): string {
  return process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL;
}

function toSafeTranscriptSource(value: string | null): TranscriptSource {
  if (value === "system-audio") return "system-audio";
  return "microphone";
}

function toChunkIndex(value: string | null): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

function extractMimeType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function toOpenAiFileName(contentType: string): string {
  const mimeType = extractMimeType(contentType);
  if (mimeType === "audio/wav") return "audio-chunk.wav";
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "audio-chunk.mp3";
  if (mimeType === "audio/mp4") return "audio-chunk.mp4";
  if (mimeType === "audio/x-m4a" || mimeType === "audio/m4a") return "audio-chunk.m4a";
  if (mimeType === "video/webm" || mimeType === "audio/webm") return "audio-chunk.webm";
  if (mimeType === "audio/ogg") return "audio-chunk.ogg";
  return "audio-chunk.webm";
}

export async function transcribeWithOpenAi(params: {
  arrayBuffer: ArrayBuffer;
  requestContentType: string;
  chunkIndexHeader: string | null;
  sourceHeader: string | null;
  signal?: AbortSignal;
}): Promise<TranscriptionResponse> {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    throw new OpenAiTranscriptionError({
      status: 503,
      code: "transcript_backend_unavailable",
    });
  }

  if (params.arrayBuffer.byteLength === 0) {
    throw new OpenAiTranscriptionError({
      status: 400,
      code: "transcript_validation_failed",
    });
  }

  const requestContentType = params.requestContentType?.trim() || "audio/webm";
  const chunkIndex = toChunkIndex(params.chunkIndexHeader);
  const source = toSafeTranscriptSource(params.sourceHeader);
  const model = getOpenAiTranscriptionModel();
  const mimeType = extractMimeType(requestContentType) || "audio/webm";
  const audioFile = new File([params.arrayBuffer], toOpenAiFileName(mimeType), {
    type: mimeType,
  });
  const formData = new FormData();
  formData.set("model", model);
  formData.set("file", audioFile);
  formData.set("response_format", "json");
  formData.set("language", "en");
  formData.set("prompt", TRANSCRIPTION_CONTEXT_PROMPT);

  if (shouldDebugLogs) {
    console.info("[transcription][openai] request", {
      bytes: params.arrayBuffer.byteLength,
      requestContentType,
      source,
      chunkIndex,
      model,
    });
  }

  const openAiResponse = await fetch(openAiEndpoint("audio/transcriptions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: formData,
    cache: "no-store",
    redirect: "error",
    signal: params.signal,
  });

  if (!openAiResponse.ok) {
    await openAiResponse.body?.cancel().catch(() => {});
    throw new OpenAiTranscriptionError({
      status: openAiResponse.status,
      code: "transcript_processing_failed",
    });
  }

  const reply = await readBoundedBytes(new Request("http://localhost/provider-result", { method: "POST", body: openAiResponse.body, signal: params.signal, duplex: "half" } as RequestInit), 262_144);
  const payload = JSON.parse(new TextDecoder().decode(reply)) as OpenAiTranscriptionResponse;
  const text = cleanTranscriptText(payload.text ?? "");
  const response: TranscriptionResponse = {
    text,
    chunkIndex,
    source,
    contentType: requestContentType,
    durationMs: null,
    speakerId: null,
  };

  if (shouldDebugLogs) {
    console.info("[transcription][openai] response", {
      chunkIndex,
      status: openAiResponse.status,
      transcriptLength: response.text.length,
      hasText: Boolean(response.text.trim()),
      model,
    });
  }

  return response;
}
