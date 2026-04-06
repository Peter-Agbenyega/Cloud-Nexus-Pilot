import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  createSessionContextCreatePayload,
  createSessionContextUpdatePayload,
  SESSION_CONTEXT_ENDPOINTS,
  type CreateSessionContextInput,
  type SessionContextId,
  type UpdateSessionContextInput,
} from "@/lib/contracts/session-context";

function resolveSessionContextEndpoint(pathTemplate: string, id?: SessionContextId) {
  return `${getApiBaseUrl()}${pathTemplate.replace(":id", id ?? "")}`;
}

export function getSessionContextListEndpointUrl() {
  return resolveSessionContextEndpoint(SESSION_CONTEXT_ENDPOINTS.list);
}

export function getSessionContextCreateEndpointUrl() {
  return resolveSessionContextEndpoint(SESSION_CONTEXT_ENDPOINTS.create);
}

export function getSessionContextDetailEndpointUrl(id: SessionContextId) {
  return resolveSessionContextEndpoint(SESSION_CONTEXT_ENDPOINTS.detail, id);
}

export function getSessionContextUpdateEndpointUrl(id: SessionContextId) {
  return resolveSessionContextEndpoint(SESSION_CONTEXT_ENDPOINTS.update, id);
}

export function createSessionContextCreateRequestInit(
  input: CreateSessionContextInput
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createSessionContextCreatePayload(input)),
  };
}

export function createSessionContextUpdateRequestInit(
  input: UpdateSessionContextInput
): RequestInit {
  return {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createSessionContextUpdatePayload(input)),
  };
}
