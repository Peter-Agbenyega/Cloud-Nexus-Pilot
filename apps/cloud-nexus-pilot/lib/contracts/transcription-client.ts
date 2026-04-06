import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  TRANSCRIPTION_ENDPOINTS,
  createTranscriptionRequestHeaders,
  type TranscriptId,
  type TranscriptionRequestHeaders,
  type UploadTranscriptInput,
} from "@/lib/contracts/transcription";

function resolveTranscriptEndpoint(pathTemplate: string, id?: TranscriptId) {
  return `${getApiBaseUrl()}${pathTemplate.replace(":id", id ?? "")}`;
}

export function getTranscriptChunkEndpointUrl() {
  return resolveTranscriptEndpoint(TRANSCRIPTION_ENDPOINTS.transcribe);
}

export function getTranscriptUploadEndpointUrl() {
  return resolveTranscriptEndpoint(TRANSCRIPTION_ENDPOINTS.upload);
}

export function getTranscriptListEndpointUrl() {
  return resolveTranscriptEndpoint(TRANSCRIPTION_ENDPOINTS.list);
}

export function getTranscriptDetailEndpointUrl(id: TranscriptId) {
  return resolveTranscriptEndpoint(TRANSCRIPTION_ENDPOINTS.detail, id);
}

export function getTranscriptStatusEndpointUrl(id: TranscriptId) {
  return resolveTranscriptEndpoint(TRANSCRIPTION_ENDPOINTS.status, id);
}

export function createTranscriptChunkRequestInit(
  body: Blob,
  headers: TranscriptionRequestHeaders
): RequestInit {
  return {
    method: "POST",
    headers: createTranscriptionRequestHeaders(headers),
    body,
  };
}

export function createTranscriptUploadMetadataRequestInit(
  input: UploadTranscriptInput
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: input.title?.trim() || "",
      filename: input.filename.trim(),
      contentType: input.contentType.trim(),
      byteSize: input.byteSize,
      captureMode: input.captureMode,
      source: input.source ?? null,
      storageKey: input.storageKey?.trim() || null,
      chunkIndex: input.chunkIndex ?? null,
    }),
  };
}
