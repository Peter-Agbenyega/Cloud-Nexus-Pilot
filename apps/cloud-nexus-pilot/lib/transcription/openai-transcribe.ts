import { cleanTranscriptText } from "@/features/transcription/transcript-bridge";
import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const shouldDebugLogs = process.env.NODE_ENV !== "production";

type OpenAiTranscriptionResponse = {
  text?: string;
};

export class OpenAiTranscriptionError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(params: { status: number; code: string; message: string; detail?: string }) {
    super(params.message);
    this.name = "OpenAiTranscriptionError";
    this.status = params.status;
    this.code = params.code;
    this.detail = params.detail ?? "";
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

async function readOpenAiError(response: Response): Promise<{ message: string; detail: string }> {
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    return {
      message: `OpenAI transcription request failed with status ${response.status}.`,
      detail: "",
    };
  }

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; code?: string; type?: string };
    };
    return {
      message:
        parsed.error?.message?.trim() ||
        `OpenAI transcription request failed with status ${response.status}.`,
      detail: [parsed.error?.type, parsed.error?.code].filter(Boolean).join(" | "),
    };
  } catch {
    return {
      message: bodyText.trim(),
      detail: "",
    };
  }
}

export async function transcribeWithOpenAi(params: {
  arrayBuffer: ArrayBuffer;
  requestContentType: string;
  chunkIndexHeader: string | null;
  sourceHeader: string | null;
}): Promise<TranscriptionResponse> {
  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    throw new OpenAiTranscriptionError({
      status: 503,
      code: "transcript_backend_unavailable",
      message:
        "OpenAI transcription is not configured. Set OPENAI_API_KEY on the server to enable transcription.",
      detail: "The server received this request but OPENAI_API_KEY was empty at request time.",
    });
  }

  if (params.arrayBuffer.byteLength === 0) {
    throw new OpenAiTranscriptionError({
      status: 400,
      code: "transcript_validation_failed",
      message: "Audio chunk is empty.",
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

  if (shouldDebugLogs) {
    console.info("[transcription][openai] request", {
      bytes: params.arrayBuffer.byteLength,
      requestContentType,
      source,
      chunkIndex,
      model,
    });
  }

  const openAiResponse = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: formData,
    cache: "no-store",
  });

  if (!openAiResponse.ok) {
    const upstream = await readOpenAiError(openAiResponse);
    throw new OpenAiTranscriptionError({
      status: openAiResponse.status,
      code: "transcript_processing_failed",
      message: upstream.message,
      detail: [
        upstream.detail,
        `OpenAI status: ${openAiResponse.status}`,
        `Request chunk bytes: ${params.arrayBuffer.byteLength}`,
        `Request content-type: ${requestContentType}`,
        `Model: ${model}`,
      ]
        .filter(Boolean)
        .join(" | "),
    });
  }

  const payload = (await openAiResponse.json()) as OpenAiTranscriptionResponse;
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
