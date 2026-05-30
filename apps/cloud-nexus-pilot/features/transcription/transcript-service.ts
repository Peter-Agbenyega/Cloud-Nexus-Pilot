import { cleanTranscriptText } from "@/features/transcription/transcript-bridge";
import type {
  TranscriptSource,
  TranscriptionResponse,
} from "@/lib/contracts/transcription";

import type { LiveTranscriptionSource } from "@/features/transcription/audio-capture";

export type UploadedTranscriptionResult = {
  transcript: string;
  source: "text-local" | "audio-backend";
  contentType: string;
  fileName: string;
  durationMs?: number | null;
};

function toTranscriptSource(source: LiveTranscriptionSource): TranscriptSource {
  return source;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

export async function transcribeLiveAudioChunk(params: {
  audioBlob: Blob;
  chunkIndex: number;
  source: LiveTranscriptionSource;
  contentType: string;
  filename?: string;
}): Promise<TranscriptionResponse> {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": params.contentType,
      "X-Chunk-Index": String(params.chunkIndex),
      "X-Transcript-Source": toTranscriptSource(params.source),
      "X-Audio-Filename": params.filename?.trim() || "live-capture.webm",
    },
    body: params.audioBlob,
  });

  if (!response.ok) {
    const fallback = "Unable to transcribe the latest audio chunk.";

    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; detail?: string };
      };
      const code = body.error?.code?.trim();
      const message = body.error?.message?.trim();
      const detail = body.error?.detail?.trim();
      const nextMessage = [
        code ? `${code} (${response.status})` : "",
        message || fallback,
        detail || "",
      ]
        .filter(Boolean)
        .join(": ");
      throw new Error(nextMessage);
    } catch (error) {
      throw new Error(toErrorMessage(error, fallback));
    }
  }

  const payload = (await response.json()) as TranscriptionResponse;

  return {
    text: cleanTranscriptText(payload.text),
    chunkIndex: payload.chunkIndex,
    source: payload.source,
    contentType: payload.contentType,
    durationMs: payload.durationMs ?? null,
    speakerId: payload.speakerId ?? null,
  };
}

export async function transcribeUploadedFile(file: File): Promise<string> {
  const isTextLike =
    file.type.startsWith("text/") || /\.(txt|md|json|srt|vtt)$/i.test(file.name);

  if (isTextLike) {
    const rawText = await file.text();
    const transcript = cleanTranscriptText(rawText);
    console.info("[transcription][upload] local-text-ingest-success", {
      fileName: file.name,
      contentType: file.type || "text/plain",
      chars: transcript.length,
    });
    return transcript;
  }

  if (file.type.startsWith("audio/")) {
    const result = await transcribeLiveAudioChunk({
      audioBlob: file,
      chunkIndex: 0,
      source: "microphone",
      contentType: file.type || "audio/webm",
      filename: file.name,
    });

    return cleanTranscriptText(result.text);
  }

  return "";
}

export async function transcribeUploadedAsset(
  file: File
): Promise<UploadedTranscriptionResult> {
  const isTextLike =
    file.type.startsWith("text/") || /\.(txt|md|json|srt|vtt)$/i.test(file.name);

  console.info("[transcription][upload] verification-start", {
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
  });

  if (isTextLike) {
    const transcript = await transcribeUploadedFile(file);
    return {
      transcript,
      source: "text-local",
      contentType: file.type || "text/plain",
      fileName: file.name,
      durationMs: null,
    };
  }

  if (file.type.startsWith("audio/")) {
    const result = await transcribeLiveAudioChunk({
      audioBlob: file,
      chunkIndex: 0,
      source: "microphone",
      contentType: file.type || "audio/webm",
      filename: file.name,
    });
    const transcript = cleanTranscriptText(result.text);
    console.info("[transcription][upload] backend-audio-ingest-success", {
      fileName: file.name,
      contentType: file.type || "audio/webm",
      chars: transcript.length,
      durationMs: result.durationMs ?? null,
    });
    return {
      transcript,
      source: "audio-backend",
      contentType: result.contentType || file.type || "audio/webm",
      fileName: file.name,
      durationMs: result.durationMs ?? null,
    };
  }

  throw new Error(
    "Unsupported upload type for transcription verification. Use a known audio file or a text transcript file."
  );
}
