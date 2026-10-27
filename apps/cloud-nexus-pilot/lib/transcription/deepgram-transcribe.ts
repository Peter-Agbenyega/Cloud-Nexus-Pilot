import { readBoundedBytes } from "../server/request-boundary";
import { cleanTranscriptText } from "@/features/transcription/transcript-bridge";
import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";
import { toPublicTranscriptionError } from "./public-error";

const DEEPGRAM_TRANSCRIPTION_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_TRANSCRIPTION_MODEL = "nova-3";
const DEEPGRAM_KEYTERMS = [
  "Cloud Nexus Pilot",
  "Cloud Nexus",
  "interview copilot",
  "Deepgram",
  "live transcription",
  "interview coaching",
  "microphone transcription",
  "tab audio",
] as const;
const shouldDebugLogs = process.env.NODE_ENV !== "production";

type DeepgramTranscriptionResponse = {
  metadata?: {
    duration?: number;
  };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
};

export class DeepgramTranscriptionError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(params: { status: number; code: string; message?: string; detail?: string }) {
    const safe = toPublicTranscriptionError(params);
    super(safe.error.message);
    this.name = "DeepgramTranscriptionError";
    this.status = safe.status;
    this.code = safe.error.code;
    this.detail = "";
  }
}

function getDeepgramApiKey(): string {
  return process.env.DEEPGRAM_API_KEY?.trim() ?? "";
}

export function isDeepgramTranscriptionConfigured(): boolean {
  return Boolean(getDeepgramApiKey());
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

export async function transcribeWithDeepgram(params: {
  arrayBuffer: ArrayBuffer;
  requestContentType: string;
  chunkIndexHeader: string | null;
  sourceHeader: string | null;
  signal?: AbortSignal;
}): Promise<TranscriptionResponse> {
  const deepgramApiKey = getDeepgramApiKey();
  if (!deepgramApiKey) {
    throw new DeepgramTranscriptionError({
      status: 503,
      code: "transcript_backend_unavailable",
    });
  }

  if (params.arrayBuffer.byteLength === 0) {
    throw new DeepgramTranscriptionError({
      status: 400,
      code: "transcript_validation_failed",
    });
  }

  const requestContentType = params.requestContentType?.trim() || "audio/webm";
  const mimeType = extractMimeType(requestContentType) || "audio/webm";
  const chunkIndex = toChunkIndex(params.chunkIndexHeader);
  const source = toSafeTranscriptSource(params.sourceHeader);
  const searchParams = new URLSearchParams({
    model: DEEPGRAM_TRANSCRIPTION_MODEL,
    language: "en-US",
    smart_format: "true",
    punctuate: "true",
  });
  for (const keyterm of DEEPGRAM_KEYTERMS) {
    searchParams.append("keyterm", keyterm);
  }

  if (shouldDebugLogs) {
    console.info("[transcription][deepgram] request", {
      bytes: params.arrayBuffer.byteLength,
      requestContentType,
      source,
      chunkIndex,
      model: DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  }

  const deepgramResponse = await fetch(`${DEEPGRAM_TRANSCRIPTION_URL}?${searchParams.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${deepgramApiKey}`,
      "Content-Type": mimeType,
    },
    body: params.arrayBuffer,
    cache: "no-store",
    signal: params.signal,
  });

  if (!deepgramResponse.ok) {
    await deepgramResponse.body?.cancel().catch(() => {});
    throw new DeepgramTranscriptionError({
      status: deepgramResponse.status,
      code: "transcript_processing_failed",
    });
  }

  const reply = await readBoundedBytes(new Request("http://localhost/provider-result", { method: "POST", body: deepgramResponse.body, signal: params.signal, duplex: "half" } as RequestInit), 262_144);
  const payload = JSON.parse(new TextDecoder().decode(reply)) as DeepgramTranscriptionResponse;
  const text = cleanTranscriptText(
    payload.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ""
  );
  const durationSeconds = payload.metadata?.duration;
  const durationMs =
    typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
      ? Math.round(durationSeconds * 1000)
      : null;
  const response: TranscriptionResponse = {
    text,
    chunkIndex,
    source,
    contentType: requestContentType,
    durationMs,
    speakerId: null,
  };

  if (shouldDebugLogs) {
    console.info("[transcription][deepgram] response", {
      chunkIndex,
      status: deepgramResponse.status,
      transcriptLength: response.text.length,
      hasText: Boolean(response.text.trim()),
      durationMs,
      model: DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  }

  return response;
}
