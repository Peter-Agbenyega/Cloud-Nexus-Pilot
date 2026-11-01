import { providerLimitErrors } from "../provider-limits";
const publicErrors = {
  ...providerLimitErrors,
  transcript_backend_unavailable: { status: 503, message: "Transcription is currently unavailable. Please try again later." },
  transcript_validation_failed: { status: 400, message: "Audio chunk is empty." },
  transcript_processing_failed: { status: 500, message: "Unable to transcribe this audio chunk. Please try again." },
  transcript_stream_session_missing: { status: 404, message: "Streaming transcription session was not found." },
  invalid_content_type: { status: 415, message: "Unsupported audio content type." },
  empty_payload: { status: 400, message: "Audio chunk body is empty." },
} as const;

type PublicErrorCode = keyof typeof publicErrors;

// Never read exception messages, details, causes or response bodies here. Even
// known provider error codes receive application-owned, allowlisted text.
export function toPublicTranscriptionError(value: unknown): {
  status: number;
  error: { code: PublicErrorCode; message: string };
} {
  let rawCode: unknown;
  let rawStatus: unknown;
  try {
    if (value && typeof value === "object") {
      rawCode = Reflect.get(value, "code");
      rawStatus = Reflect.get(value, "status");
    }
  } catch {
    // An unusual error getter must not prevent a safe error response.
  }
  const code: PublicErrorCode = typeof rawCode === "string" && Object.hasOwn(publicErrors, rawCode)
    ? rawCode as PublicErrorCode
    : "transcript_processing_failed";
  const definition = publicErrors[code];
  // Preserve provider HTTP failures for file transcription. Chunk transport
  // retains its existing code-to-status mapping at its own route boundary.
  const status = code === "transcript_processing_failed" && rawCode === code &&
    typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : definition.status;
  return { status, error: { code, message: definition.message } };
}
