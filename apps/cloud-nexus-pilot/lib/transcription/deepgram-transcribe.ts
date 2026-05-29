import "./ws-patch";
import { cleanTranscriptText } from "@/features/transcription/transcript-bridge";
import type { TranscriptSource, TranscriptionResponse } from "@/lib/contracts/transcription";
import WebSocket from "ws";
const shouldDebugLogs = process.env.NODE_ENV !== "production";

type DeepgramListenResponse = {
  type?: string;
  metadata?: {
    duration?: number;
  };
  is_final?: boolean;
  speech_final?: boolean;
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

type DeepgramStreamingResultMeta = {
  isFinal: boolean;
  speechFinal: boolean;
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

function applyDeepgramStreamingOptions(url: URL, contentType: string) {
  url.searchParams.set("model", "nova-2");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("endpointing", "300");
  url.searchParams.set("vad_events", "true");
  url.searchParams.set("diarize", "true");

  const mimeType = extractMimeType(contentType);
  if (mimeType === "audio/wav") {
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("channels", "1");
    return;
  }

  applyDeepgramAudioHints(url, contentType);
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

function buildTranscriptionResponse(params: {
  payload: DeepgramListenResponse;
  chunkIndex: number;
  source: TranscriptSource;
  deepgramContentType: string;
}): TranscriptionResponse {
  return {
    text: getTranscriptFromDeepgram(params.payload),
    chunkIndex: params.chunkIndex,
    source: params.source,
    contentType: params.deepgramContentType,
    durationMs: getDurationMs(params.payload),
    speakerId: getSpeakerIdFromDeepgram(params.payload),
  };
}

function stripWaveHeader(arrayBuffer: ArrayBuffer): Buffer {
  const bytes = new Uint8Array(arrayBuffer);
  const hasWaveHeader =
    bytes.length >= 44 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";

  return Buffer.from(hasWaveHeader ? bytes.slice(44) : bytes);
}

async function transcribeWithDeepgramStreaming(
  params: {
    arrayBuffer: ArrayBuffer;
    requestContentType: string;
    chunkIndexHeader: string | null;
    sourceHeader: string | null;
    onStreamingResult?: (
      response: TranscriptionResponse,
      meta: DeepgramStreamingResultMeta
    ) => void;
  },
  deepgramApiKey: string
): Promise<TranscriptionResponse> {
  const requestContentType = params.requestContentType?.trim() || "audio/webm";
  const deepgramContentType = toDeepgramContentType(requestContentType);
  const chunkIndex = toChunkIndex(params.chunkIndexHeader);
  const source = toSafeTranscriptSource(params.sourceHeader);
  const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen");
  applyDeepgramStreamingOptions(deepgramUrl, deepgramContentType);

  const audioPayload =
    extractMimeType(deepgramContentType) === "audio/wav"
      ? stripWaveHeader(params.arrayBuffer)
      : Buffer.from(new Uint8Array(params.arrayBuffer));

  if (shouldDebugLogs) {
    console.info("[transcription][deepgram] streaming-request", {
      bytes: audioPayload.byteLength,
      requestContentType,
      deepgramContentType,
      source,
      chunkIndex,
      url: deepgramUrl.toString(),
    });
  }

  return await new Promise<TranscriptionResponse>((resolve, reject) => {
    const socket = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
      },
    });

    const timeoutId = setTimeout(() => {
      socket.close();
      reject(
        new DeepgramTranscriptionError({
          status: 504,
          code: "transcript_processing_failed",
          message: "Deepgram streaming transcription timed out.",
          detail: `Timed out waiting for a streaming transcript for chunk ${chunkIndex}.`,
        })
      );
    }, 15_000);

    let settled = false;
    let latestResponse: TranscriptionResponse | null = null;
    let finalResponse: TranscriptionResponse | null = null;

    const finish = (response: TranscriptionResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
      resolve(response);
    };

    const fail = (error: DeepgramTranscriptionError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
      reject(error);
    };

    socket.on("open", () => {
      socket.send(audioPayload, { binary: true });
      socket.send(JSON.stringify({ type: "Finalize" }));
    });

    socket.on("message", (raw) => {
      let payload: DeepgramListenResponse;
      try {
        payload = JSON.parse(raw.toString()) as DeepgramListenResponse;
      } catch {
        return;
      }

      const transcriptResponse = buildTranscriptionResponse({
        payload,
        chunkIndex,
        source,
        deepgramContentType,
      });
      const hasText = Boolean(transcriptResponse.text.trim());
      const meta = {
        isFinal: payload.is_final === true,
        speechFinal: payload.speech_final === true,
      };

      if (shouldDebugLogs) {
        console.info("[transcription][deepgram] streaming-message", {
          chunkIndex,
          type: payload.type ?? "Results",
          isFinal: meta.isFinal,
          speechFinal: meta.speechFinal,
          hasText,
          textLength: transcriptResponse.text.length,
        });
      }

      if (hasText) {
        latestResponse = transcriptResponse;
        params.onStreamingResult?.(transcriptResponse, meta);
      }

      if (meta.isFinal && hasText) {
        finalResponse = transcriptResponse;
      }

      if (meta.isFinal || meta.speechFinal) {
        finish(
          finalResponse ??
            latestResponse ?? {
              text: "",
              chunkIndex,
              source,
              contentType: deepgramContentType,
              durationMs: transcriptResponse.durationMs ?? null,
              speakerId: transcriptResponse.speakerId ?? null,
            }
        );
      }
    });

    socket.on("error", (error) => {
      fail(
        new DeepgramTranscriptionError({
          status: 502,
          code: "transcript_processing_failed",
          message: "Deepgram streaming connection failed.",
          detail: error instanceof Error ? error.message : "Unknown WebSocket error.",
        })
      );
    });

    socket.on("close", () => {
      if (settled) return;
      finish(
        finalResponse ??
          latestResponse ?? {
            text: "",
            chunkIndex,
            source,
            contentType: deepgramContentType,
            durationMs: null,
            speakerId: null,
          }
      );
    });
  });
}

export async function transcribeWithDeepgram(params: {
  arrayBuffer: ArrayBuffer;
  requestContentType: string;
  chunkIndexHeader: string | null;
  sourceHeader: string | null;
  onStreamingResult?: (
    response: TranscriptionResponse,
    meta: DeepgramStreamingResultMeta
  ) => void;
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

  if (params.onStreamingResult) {
    return transcribeWithDeepgramStreaming(params, deepgramApiKey);
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
  if (shouldDebugLogs) {
    console.info("[transcription][deepgram] request", {
      bytes: params.arrayBuffer.byteLength,
      requestContentType,
      deepgramContentType,
      source,
      chunkIndex,
      url: deepgramUrl.toString(),
    });
  }

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
  const response = buildTranscriptionResponse({
    payload,
    chunkIndex,
    source,
    deepgramContentType,
  });
  if (shouldDebugLogs) {
    console.info("[transcription][deepgram] response", {
      chunkIndex,
      status: deepgramResponse.status,
      transcriptLength: response.text.length,
      hasText: Boolean(response.text.trim()),
      durationMs: response.durationMs ?? null,
      speakerId: response.speakerId ?? null,
    });
  }
  return response;
}
