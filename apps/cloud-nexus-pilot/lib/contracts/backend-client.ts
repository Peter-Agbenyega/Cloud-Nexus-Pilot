import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  createInterviewRequestPayload,
  INTERVIEW_ENDPOINTS,
  type InterviewRequest,
} from "@/lib/contracts/interview";
import {
  createTranscriptionRequestHeaders,
  TRANSCRIPTION_ENDPOINTS,
  type TranscriptionRequestHeaders,
} from "@/lib/contracts/transcription";

export function getInterviewEndpointUrl() {
  return `${getApiBaseUrl()}${INTERVIEW_ENDPOINTS.answer}`;
}

export function getInterviewStreamEndpointUrl() {
  return `${getApiBaseUrl()}${INTERVIEW_ENDPOINTS.stream}`;
}

export function getTranscriptionEndpointUrl() {
  return `${getApiBaseUrl()}${TRANSCRIPTION_ENDPOINTS.transcribe}`;
}

export function createInterviewRequestInit(request: InterviewRequest): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createInterviewRequestPayload(request)),
  };
}

export function createTranscriptionRequestInit(
  audioChunk: Blob | ArrayBuffer | Uint8Array,
  headers: TranscriptionRequestHeaders
): RequestInit {
  const body: Blob =
    audioChunk instanceof Blob
      ? audioChunk
      : audioChunk instanceof Uint8Array
        ? (() => {
            const copiedBytes = new Uint8Array(audioChunk.byteLength);
            copiedBytes.set(audioChunk);
            return new Blob([copiedBytes]);
          })()
        : new Blob([new Uint8Array(audioChunk.slice(0))]);

  return {
    method: "POST",
    headers: createTranscriptionRequestHeaders(headers),
    body,
  };
}
