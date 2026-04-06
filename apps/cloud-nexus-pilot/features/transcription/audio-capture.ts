export type LiveTranscriptionSource = "microphone" | "system-audio";

const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

export function isAudioCaptureSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export function canCaptureSystemAudio(): boolean {
  return (
    typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia)
  );
}

export function getPreferredMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";

  const supportedMimeType = MIME_TYPE_CANDIDATES.find((mimeType) =>
    MediaRecorder.isTypeSupported(mimeType)
  );

  return supportedMimeType ?? "";
}

export function getFileExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export async function createCaptureStream(
  source: LiveTranscriptionSource
): Promise<MediaStream> {
  if (source === "system-audio") {
    return navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}
