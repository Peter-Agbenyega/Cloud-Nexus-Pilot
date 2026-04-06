import type {
  PromptCategory,
  PromptVisibility,
  PromptVaultItem,
} from "@/lib/prompt-vault";

export type PromptId = PromptVaultItem["id"];

export type Prompt = PromptVaultItem & {
  ownerScope: "local-user" | "authenticated-user" | "system-starter";
  ownerId: string | null;
  version: 1;
};

export type CreatePromptInput = {
  title: string;
  category: PromptCategory;
  promptText: string;
  visibility: PromptVisibility;
  description: string;
};

export type UpdatePromptInput = {
  id: PromptId;
  title: string;
  category: PromptCategory;
  promptText: string;
  visibility: PromptVisibility;
  description: string;
};

export type PromptListResponse = {
  prompts: Prompt[];
  source: "local" | "remote";
};

export type PromptResponse = {
  prompt: Prompt;
  source: "local" | "remote";
};

export type DeletePromptResponse = {
  id: PromptId;
  deleted: true;
  source: "local" | "remote";
};

export type ClonePromptResponse = {
  prompt: Prompt;
  clonedFromId: PromptId;
  source: "local" | "remote";
};

export type PromptValidationError = {
  field: "title" | "category" | "promptText" | "visibility" | "description" | "id";
  code: "required" | "invalid" | "not_found" | "forbidden" | "conflict";
  message: string;
};

export type PromptApiError = {
  error: {
    code:
      | "prompt_validation_failed"
      | "prompt_not_found"
      | "prompt_conflict"
      | "prompt_access_denied"
      | "prompt_backend_unavailable";
    message: string;
    details?: PromptValidationError[];
  };
};

export type PromptValidationIssue = PromptValidationError;
export type PromptContractErrorResponse = PromptApiError;

export const PROMPT_VAULT_ENDPOINTS = {
  list: "/prompts",
  create: "/prompts",
  update: "/prompts/:id",
  remove: "/prompts/:id",
  clone: "/prompts/:id/clone",
} as const;

export const PROMPT_VAULT_STORAGE_OWNERSHIP = {
  currentMode: "local-user",
  ownerId: null,
  authRequired: false,
  futureOwnerSource: "supabase-auth-user-id",
  ownershipNote:
    "v1 remains local-first in the browser. Future persistence should map prompts to the authenticated Supabase user id without changing the frontend prompt shape.",
} as const;

export const PROMPT_VAULT_CONTRACT_VERSION = {
  version: 1,
  note: "v1 keeps the frontend shape stable while ownerId transitions from local-only null to authenticated user identity later.",
} as const;

export function createPromptContractRecord(
  item: PromptVaultItem,
  ownerScope: Prompt["ownerScope"] = "local-user",
  ownerId: string | null = null
): Prompt {
  return {
    ...item,
    ownerScope,
    ownerId,
    version: 1,
  };
}

export function createPromptCreatePayload(input: CreatePromptInput) {
  return {
    title: input.title.trim(),
    category: input.category,
    promptText: input.promptText.trim(),
    visibility: input.visibility,
    description: input.visibility === "publish_ready" ? input.description.trim() : "",
  };
}

export function createPromptUpdatePayload(input: UpdatePromptInput) {
  return {
    id: input.id,
    title: input.title.trim(),
    category: input.category,
    promptText: input.promptText.trim(),
    visibility: input.visibility,
    description: input.visibility === "publish_ready" ? input.description.trim() : "",
  };
}
