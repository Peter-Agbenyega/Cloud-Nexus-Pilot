import { cleanTranscriptText } from "@/features/transcription/transcript-bridge";
import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";

type DeepgramListenResponse = {
  metadata?: {
    duration?: number;
  };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: Array<{
          speaker?: number;
        }>;
      }>;
    }>;
  };
};

export class DeepgramTranscriptionError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(params: { status: number; code: string; message: string; detail?: string }) {
    super(params.message);
    this.name = "DeepgramTranscriptionError";
    this.status = params.status;
    this.code = params.code;
    this.detail = params.detail ?? "";
  }
}

export function getDeepgramApiKey(): string {
  return process.env.DEEPGRAM_API_KEY?.trim() ?? "";
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

function toDeepgramContentType(contentType: string): string {
  const mimeType = extractMimeType(contentType);

  if (mimeType === "video/webm") return "audio/webm";
  if (mimeType === "audio/webm") return "audio/webm";
  if (mimeType === "audio/ogg") return "audio/ogg";
  if (mimeType === "audio/wav") return "audio/wav";
  if (mimeType === "audio/mpeg") return "audio/mpeg";
  if (mimeType === "audio/mp3") return "audio/mpeg";
  if (mimeType === "audio/mp4") return "audio/mp4";

  return "audio/webm";
}

function applyDeepgramAudioHints(url: URL, contentType: string) {
  const mimeType = extractMimeType(contentType);

  if (mimeType === "audio/webm" || mimeType === "audio/ogg" || mimeType === "video/webm") {
    url.searchParams.set("encoding", "opus");
  }
}

function getTranscriptFromDeepgram(payload: DeepgramListenResponse): string {
  const transcript =
    payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  return cleanTranscriptText(transcript);
}

function getSpeakerIdFromDeepgram(payload: DeepgramListenResponse): number | null {
  const words = payload.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  if (words.length === 0) {
    return null;
  }

  const speakerCounts = new Map<number, number>();
  for (const word of words) {
    if (typeof word.speaker !== "number" || !Number.isFinite(word.speaker)) {
      continue;
    }

    speakerCounts.set(word.speaker, (speakerCounts.get(word.speaker) ?? 0) + 1);
  }

  let dominantSpeaker: number | null = null;
  let dominantCount = 0;
  for (const [speakerId, count] of speakerCounts) {
    if (count > dominantCount) {
      dominantSpeaker = speakerId;
      dominantCount = count;
    }
  }

  return dominantSpeaker;
}

function getDurationMs(payload: DeepgramListenResponse): number | null {
  const seconds = payload.metadata?.duration;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.round(seconds * 1000);
}

export async function transcribeWithDeepgram(params: {
  arrayBuffer: ArrayBuffer;
  requestContentType: string;
  chunkIndexHeader: string | null;
  sourceHeader: string | null;
}): Promise<TranscriptionResponse> {
  const deepgramApiKey = getDeepgramApiKey();
  if (!deepgramApiKey) {
    throw new DeepgramTranscriptionError({
      status: 503,
      code: "transcript_backend_unavailable",
      message:
        "Deepgram is not configured. Set DEEPGRAM_API_KEY to enable live transcription.",
      detail: "The server received this request but DEEPGRAM_API_KEY was empty at request time.",
    });
  }

  if (params.arrayBuffer.byteLength === 0) {
    throw new DeepgramTranscriptionError({
      status: 400,
      code: "transcript_validation_failed",
      message: "Audio chunk is empty.",
    });
  }

  const requestContentType = params.requestContentType?.trim() || "audio/webm";
  const deepgramContentType = toDeepgramContentType(requestContentType);
  const chunkIndex = toChunkIndex(params.chunkIndexHeader);
  const source = toSafeTranscriptSource(params.sourceHeader);

  const deepgramUrl = new URL("https://api.deepgram.com/v1/listen");
  deepgramUrl.searchParams.set("model", "nova-2");
  deepgramUrl.searchParams.set("language", "en-US");
  deepgramUrl.searchParams.set("punctuate", "true");
  deepgramUrl.searchParams.set("smart_format", "true");
  deepgramUrl.searchParams.set("diarize", "true");
  applyDeepgramAudioHints(deepgramUrl, deepgramContentType);
  console.info("[transcription][deepgram] request", {
    bytes: params.arrayBuffer.byteLength,
    requestContentType,
    deepgramContentType,
    source,
    chunkIndex,
    url: deepgramUrl.toString(),
  });

  const deepgramResponse = await fetch(deepgramUrl, {
    method: "POST",
    headers: {
      Authorization: `Token ${deepgramApiKey}`,
      "Content-Type": deepgramContentType,
    },
    body: params.arrayBuffer,
    cache: "no-store",
  });

  if (!deepgramResponse.ok) {
    const bodyText = await deepgramResponse.text();
    let upstreamMessage = bodyText.trim();
    let upstreamCode = "";

    if (upstreamMessage) {
      try {
        const parsed = JSON.parse(upstreamMessage) as {
          err_code?: string;
          err_msg?: string;
          message?: string;
        };
        upstreamCode = parsed.err_code?.trim() || "";
        upstreamMessage = parsed.err_msg?.trim() || parsed.message?.trim() || upstreamMessage;
      } catch {
        // keep raw text
      }
    }

    throw new DeepgramTranscriptionError({
      status: deepgramResponse.status,
      code: "transcript_processing_failed",
      message: upstreamMessage || `Deepgram request failed with status ${deepgramResponse.status}.`,
      detail: [
        upstreamCode ? `Deepgram code: ${upstreamCode}` : "",
        `Deepgram status: ${deepgramResponse.status}`,
        `Request chunk bytes: ${params.arrayBuffer.byteLength}`,
        `Request content-type: ${requestContentType}`,
        `Deepgram content-type: ${deepgramContentType}`,
      ]
        .filter(Boolean)
        .join(" | "),
    });
  }

  const payload = (await deepgramResponse.json()) as DeepgramListenResponse;
  const transcriptText = getTranscriptFromDeepgram(payload);
  const durationMs = getDurationMs(payload);
  const speakerId = getSpeakerIdFromDeepgram(payload);
  console.info("[transcription][deepgram] response", {
    chunkIndex,
    status: deepgramResponse.status,
    transcriptLength: transcriptText.length,
    hasText: Boolean(transcriptText.trim()),
    durationMs: durationMs ?? null,
    speakerId,
  });
  return {
    text: transcriptText,
    chunkIndex,
    source,
    contentType: deepgramContentType,
    durationMs,
    speakerId,
  };
}
