import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  createPromptCreatePayload,
  createPromptUpdatePayload,
  PROMPT_VAULT_ENDPOINTS,
  type CreatePromptInput,
  type PromptId,
  type UpdatePromptInput,
} from "@/lib/contracts/prompt-vault";

function resolvePromptEndpoint(pathTemplate: string, id?: PromptId) {
  return `${getApiBaseUrl()}${pathTemplate.replace(":id", id ?? "")}`;
}

export function getPromptVaultListEndpointUrl() {
  return resolvePromptEndpoint(PROMPT_VAULT_ENDPOINTS.list);
}

export function getPromptVaultCreateEndpointUrl() {
  return resolvePromptEndpoint(PROMPT_VAULT_ENDPOINTS.create);
}

export function getPromptVaultUpdateEndpointUrl(id: PromptId) {
  return resolvePromptEndpoint(PROMPT_VAULT_ENDPOINTS.update, id);
}

export function getPromptVaultDeleteEndpointUrl(id: PromptId) {
  return resolvePromptEndpoint(PROMPT_VAULT_ENDPOINTS.remove, id);
}

export function getPromptVaultCloneEndpointUrl(id: PromptId) {
  return resolvePromptEndpoint(PROMPT_VAULT_ENDPOINTS.clone, id);
}

export function createPromptVaultCreateRequestInit(input: CreatePromptInput): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createPromptCreatePayload(input)),
  };
}

export function createPromptVaultUpdateRequestInit(input: UpdatePromptInput): RequestInit {
  return {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createPromptUpdatePayload(input)),
  };
}

export function createPromptVaultDeleteRequestInit(): RequestInit {
  return {
    method: "DELETE",
  };
}

export function createPromptVaultCloneRequestInit(): RequestInit {
  return {
    method: "POST",
  };
}
