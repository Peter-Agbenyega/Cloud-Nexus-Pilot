import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  createAppendSessionTurnPayload,
  createOrResumeSessionPayload,
  createRequestSessionAnswerPayload,
  SESSION_EXECUTION_ENDPOINTS,
  type AppendSessionTurnInput,
  type CreateOrResumeSessionInput,
  type RequestSessionAnswerInput,
  type SessionExecutionId,
  type StreamSessionAnswerRequest,
} from "@/lib/contracts/session-execution";

function resolveSessionExecutionEndpoint(pathTemplate: string, id?: SessionExecutionId) {
  return `${getApiBaseUrl()}${pathTemplate.replace(":id", id ?? "")}`;
}

export function getCreateOrResumeSessionEndpointUrl() {
  return resolveSessionExecutionEndpoint(SESSION_EXECUTION_ENDPOINTS.createOrResume);
}

export function getAppendSessionTurnEndpointUrl(id: SessionExecutionId) {
  return resolveSessionExecutionEndpoint(SESSION_EXECUTION_ENDPOINTS.appendTurn, id);
}

export function getRequestSessionAnswerEndpointUrl(id: SessionExecutionId) {
  return resolveSessionExecutionEndpoint(SESSION_EXECUTION_ENDPOINTS.answer, id);
}

export function getStreamSessionAnswerEndpointUrl(id: SessionExecutionId) {
  return resolveSessionExecutionEndpoint(SESSION_EXECUTION_ENDPOINTS.stream, id);
}

export function createCreateOrResumeSessionRequestInit(
  input: CreateOrResumeSessionInput
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createOrResumeSessionPayload(input)),
  };
}

export function createAppendSessionTurnRequestInit(input: AppendSessionTurnInput): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createAppendSessionTurnPayload(input)),
  };
}

export function createRequestSessionAnswerRequestInit(
  input: RequestSessionAnswerInput
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createRequestSessionAnswerPayload(input)),
  };
}

export function createStreamSessionAnswerRequestInit(
  input: StreamSessionAnswerRequest
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(createRequestSessionAnswerPayload(input)),
  };
}
