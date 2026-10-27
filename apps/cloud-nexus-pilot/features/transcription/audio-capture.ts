export type LiveTranscriptionSource = "microphone" | "system-audio";

const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

export function isAudioCaptureSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) &&
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

/** Missing/ended audio is a capability error, never a request to switch sources. */
export function requireActiveAudioTracks(stream: MediaStream): MediaStreamTrack[] {
  const tracks = stream.getAudioTracks().filter((track) => track.readyState === "live" && track.enabled);
  if (!tracks.length) throw new Error("The selected source did not provide active audio. Select a supported tab with Share audio enabled, choose Microphone explicitly, or upload a completed recording.");
  return tracks;
}

export async function createCaptureStream(source: LiveTranscriptionSource): Promise<MediaStream> {
  const stream = source === "system-audio"
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  try {
    requireActiveAudioTracks(stream);
    return stream;
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}
