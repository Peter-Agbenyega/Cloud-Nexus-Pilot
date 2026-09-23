"use client";

import type { User } from "@supabase/supabase-js";

import { supabase, supabaseConfigError } from "@/lib/supabase";
import {
  buildPromptClone,
  createPromptVaultItem,
  createEmptyPromptDraft,
  parsePromptVaultItems,
  resolveStoredPromptVaultItems,
  PROMPT_VAULT_STARTERS,
  PROMPT_VAULT_STORAGE_KEY,
  sortPromptVaultItems,
  updatePromptVaultItem,
  type PromptVaultItem,
} from "@/lib/prompt-vault";
import {
  createPromptContractRecord,
  createPromptCreatePayload,
  createPromptUpdatePayload,
  type ClonePromptResponse,
  type CreatePromptInput,
  type DeletePromptResponse,
  type Prompt,
  type PromptId,
  type PromptListResponse,
  type PromptResponse,
  type UpdatePromptInput,
} from "@/lib/contracts/prompt-vault";

export type PromptVaultPersistenceInfo = {
  mode: "local" | "supabase-ready" | "supabase-active";
  note: string;
  cloudSyncReady: boolean;
  authState: "signed-out-local" | "supabase-ready" | "signed-in-cloud";
  userEmail: string | null;
};

export type PromptVaultRepositoryResult<T> = T & {
  persistence: PromptVaultPersistenceInfo;
};

export type PromptVaultImportStatus = {
  available: boolean;
  localPromptCount: number;
  cloudPromptCount: number;
  importableCount: number;
  note: string;
};

export type PromptVaultLoadResult = PromptVaultRepositoryResult<PromptListResponse> & {
  importStatus: PromptVaultImportStatus;
};

export type PromptVaultImportResult = PromptVaultRepositoryResult<PromptListResponse> & {
  importStatus: PromptVaultImportStatus;
  importedCount: number;
};

export interface PromptVaultRepository {
  loadPrompts(): Promise<PromptVaultLoadResult>;
  createPrompt(input: CreatePromptInput): Promise<PromptVaultRepositoryResult<PromptResponse>>;
  updatePrompt(input: UpdatePromptInput): Promise<PromptVaultRepositoryResult<PromptResponse>>;
  deletePrompt(id: PromptId): Promise<PromptVaultRepositoryResult<DeletePromptResponse>>;
  clonePrompt(
    item: PromptVaultItem,
    existingItems: ReadonlyArray<PromptVaultItem>
  ): Promise<PromptVaultRepositoryResult<ClonePromptResponse>>;
  importLocalPromptsToCloud(): Promise<PromptVaultImportResult>;
}

type PromptVaultCloudAdapter = {
  getPersistenceInfo: () => Promise<PromptVaultPersistenceInfo>;
};

type PromptVaultSupabaseRow = {
  id: string;
  user_id: string;
  title: string;
  category: PromptVaultItem["category"];
  prompt_text: string;
  publish_status: PromptVaultItem["visibility"];
  description: string | null;
  created_at: string;
  updated_at: string;
};

function readStoredPrompts(): PromptVaultItem[] {
  if (typeof window === "undefined") return [...PROMPT_VAULT_STARTERS];
  return resolveStoredPromptVaultItems(window.localStorage.getItem(PROMPT_VAULT_STORAGE_KEY));
}

function readRawStoredPrompts(): PromptVaultItem[] {
  if (typeof window === "undefined") return [...PROMPT_VAULT_STARTERS];

  const persisted = parsePromptVaultItems(
    window.localStorage.getItem(PROMPT_VAULT_STORAGE_KEY)
  );

  return sortPromptVaultItems(persisted);
}

function writeStoredPrompts(items: ReadonlyArray<PromptVaultItem>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PROMPT_VAULT_STORAGE_KEY, JSON.stringify(items));
}

function createLocalPersistenceInfo(note?: string): PromptVaultPersistenceInfo {
  return {
    mode: "local",
    note:
      note ||
      "Prompt Vault is running in dependable local mode. Cloud sync will activate only when Supabase env, auth, and table access are all ready.",
    cloudSyncReady: false,
    authState: "signed-out-local",
    userEmail: null,
  };
}

function toEpoch(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function mapSupabaseRowToPrompt(row: PromptVaultSupabaseRow): Prompt {
  return createPromptContractRecord(
    {
      id: row.id,
      title: row.title,
      category: row.category,
      promptText: row.prompt_text,
      visibility: row.publish_status,
      description: row.description ?? "",
      createdAt: toEpoch(row.created_at),
      updatedAt: toEpoch(row.updated_at),
    },
    "authenticated-user",
    row.user_id
  );
}

function createPromptFingerprint(
  prompt: Pick<PromptVaultItem, "title" | "category" | "promptText" | "visibility" | "description">
): string {
  return [
    prompt.title.trim().toLowerCase(),
    prompt.category,
    prompt.promptText.trim().toLowerCase(),
    prompt.visibility,
    prompt.description.trim().toLowerCase(),
  ].join("::");
}

function createImportStatus(
  localPrompts: ReadonlyArray<PromptVaultItem>,
  cloudPrompts: ReadonlyArray<Prompt>
): PromptVaultImportStatus {
  const localPromptCount = localPrompts.length;
  const cloudPromptCount = cloudPrompts.length;
  const cloudFingerprints = new Set(cloudPrompts.map(createPromptFingerprint));
  const importableCount = localPrompts.filter(
    (prompt) => !cloudFingerprints.has(createPromptFingerprint(prompt))
  ).length;

  if (localPromptCount === 0) {
    return {
      available: false,
      localPromptCount,
      cloudPromptCount,
      importableCount: 0,
      note: "No local prompts are waiting for cloud import.",
    };
  }

  if (importableCount === 0) {
    return {
      available: false,
      localPromptCount,
      cloudPromptCount,
      importableCount,
      note: "Your local Prompt Vault is already represented in cloud storage.",
    };
  }

  if (cloudPromptCount === 0) {
    return {
      available: true,
      localPromptCount,
      cloudPromptCount,
      importableCount,
      note: `You have ${importableCount} local prompt${importableCount === 1 ? "" : "s"} ready for a first safe import into your cloud vault.`,
    };
  }

  return {
    available: true,
    localPromptCount,
    cloudPromptCount,
    importableCount,
    note: `${importableCount} local prompt${importableCount === 1 ? "" : "s"} are not in your cloud vault yet. Import adds only missing prompts and does not overwrite cloud data.`,
  };
}

async function getAuthenticatedSupabaseUser(): Promise<{
  user: User | null;
  authLookupFailed?: boolean;
  persistence: PromptVaultPersistenceInfo;
}> {
  if (!supabase) {
    return {
      user: null,
      persistence: createLocalPersistenceInfo(
        supabaseConfigError ||
          "Supabase is not configured yet. Prompt Vault is running in dependable local mode."
      ),
    };
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    return {
      user: null,
      authLookupFailed: error.name !== "AuthSessionMissingError",
      persistence: createLocalPersistenceInfo(
        "Supabase auth check failed, so Prompt Vault is using local fallback mode."
      ),
    };
  }

  if (!user) {
    return {
      user: null,
      persistence: {
        mode: "supabase-ready",
        note:
          "Supabase is configured, but no authenticated user is active. Prompt Vault stays in local mode until sign-in is complete.",
        cloudSyncReady: true,
        authState: "supabase-ready",
        userEmail: null,
      },
    };
  }

  return {
    user,
    persistence: {
      mode: "supabase-active",
      note:
        "Authenticated cloud sync is active. Prompt Vault is reading and writing prompts through Supabase.",
      cloudSyncReady: true,
      authState: "signed-in-cloud",
      userEmail: user.email ?? null,
    },
  };
}

async function listSupabasePrompts(user: User) {
  const { data, error } = await supabase!
    .from("prompt_vault_items")
    .select(
      "id,user_id,title,category,prompt_text,publish_status,description,created_at,updated_at"
    )
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(
      `Supabase Prompt Vault query failed. Confirm the prompt_vault_items table and RLS policies are applied. ${error.message}`
    );
  }

  return ((data ?? []) as PromptVaultSupabaseRow[]).map(mapSupabaseRowToPrompt);
}

async function listCloudPromptsWithImportState(user: User): Promise<{
  prompts: Prompt[];
  importStatus: PromptVaultImportStatus;
}> {
  const prompts = await listSupabasePrompts(user);
  const importStatus = createImportStatus(readRawStoredPrompts(), prompts);

  return {
    prompts,
    importStatus,
  };
}

async function createSupabasePrompt(user: User, input: CreatePromptInput) {
  const payload = createPromptCreatePayload(input);
  const { data, error } = await supabase!
    .from("prompt_vault_items")
    .insert({
      user_id: user.id,
      title: payload.title,
      category: payload.category,
      prompt_text: payload.promptText,
      publish_status: payload.visibility,
      description: payload.description || null,
    })
    .select(
      "id,user_id,title,category,prompt_text,publish_status,description,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(
      `Supabase Prompt Vault create failed. Confirm the prompt_vault_items table and insert policy exist. ${error?.message ?? ""}`.trim()
    );
  }

  return mapSupabaseRowToPrompt(data as PromptVaultSupabaseRow);
}

async function updateSupabasePrompt(user: User, input: UpdatePromptInput) {
  const payload = createPromptUpdatePayload(input);
  const { data, error } = await supabase!
    .from("prompt_vault_items")
    .update({
      title: payload.title,
      category: payload.category,
      prompt_text: payload.promptText,
      publish_status: payload.visibility,
      description: payload.description || null,
    })
    .eq("id", input.id)
    .eq("user_id", user.id)
    .select(
      "id,user_id,title,category,prompt_text,publish_status,description,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(
      `Supabase Prompt Vault update failed. Confirm the row exists for the signed-in user and RLS update policy is active. ${error?.message ?? ""}`.trim()
    );
  }

  return mapSupabaseRowToPrompt(data as PromptVaultSupabaseRow);
}

async function deleteSupabasePrompt(user: User, id: PromptId) {
  const { error } = await supabase!
    .from("prompt_vault_items")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    throw new Error(
      `Supabase Prompt Vault delete failed. Confirm the row exists for the signed-in user and RLS delete policy is active. ${error.message}`
    );
  }
}

const promptVaultSupabaseAdapter: PromptVaultCloudAdapter = {
  async getPersistenceInfo() {
    const { persistence } = await getAuthenticatedSupabaseUser();
    return persistence;
  },
};

const localPromptVaultRepository: PromptVaultRepository = {
  async loadPrompts() {
    const prompts = readStoredPrompts().map((item) => createPromptContractRecord(item));

    return {
      prompts,
      source: "local",
      persistence: createLocalPersistenceInfo(),
      importStatus: createImportStatus(readRawStoredPrompts(), []),
    };
  },

  async createPrompt(input) {
    const nextPrompt = createPromptVaultItem(input);
    const nextItems = sortPromptVaultItems([nextPrompt, ...readStoredPrompts()]);

    writeStoredPrompts(nextItems);

    return {
      prompt: createPromptContractRecord(nextPrompt),
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async updatePrompt(input) {
    const currentItems = readStoredPrompts();
    const updatedItem = currentItems.find((item) => item.id === input.id);

    if (!updatedItem) {
      throw new Error("Prompt could not be found in the local vault.");
    }

    const nextPrompt = updatePromptVaultItem(updatedItem, input);
    const nextItems = sortPromptVaultItems(
      currentItems.map((item) => (item.id === input.id ? nextPrompt : item))
    );

    writeStoredPrompts(nextItems);

    return {
      prompt: createPromptContractRecord(nextPrompt),
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async deletePrompt(id) {
    const nextItems = readStoredPrompts().filter((item) => item.id !== id);

    writeStoredPrompts(nextItems);

    return {
      id,
      deleted: true,
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async clonePrompt(item, existingItems) {
    const clonedPrompt = buildPromptClone(item, existingItems);
    const nextItems = sortPromptVaultItems([clonedPrompt, ...readStoredPrompts()]);

    writeStoredPrompts(nextItems);

    return {
      prompt: createPromptContractRecord(clonedPrompt),
      clonedFromId: item.id,
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async importLocalPromptsToCloud() {
    const prompts = readStoredPrompts().map((item) => createPromptContractRecord(item));

    return {
      prompts,
      source: "local",
      persistence: createLocalPersistenceInfo(),
      importStatus: createImportStatus(readRawStoredPrompts(), []),
      importedCount: 0,
    };
  },
};

export function createPromptVaultRepository(): PromptVaultRepository {
  // Retain cloud provenance across auth loss; a cloud row must never become a local delete.
  const cloudRecordIds = new Set<string>();
  async function runWithFallback<T>(
    action: (user: User) => Promise<T>,
    fallback: () => Promise<PromptVaultRepositoryResult<T>>,
    allowCloudErrorFallback = true,
    requiresCloud = false
  ): Promise<PromptVaultRepositoryResult<T>> {
    const { user, persistence, authLookupFailed } = await getAuthenticatedSupabaseUser();

    if (!user) {
      if (requiresCloud || (!allowCloudErrorFallback && authLookupFailed)) {
        throw new Error("Deletion was not performed because cloud authentication could not be verified. Sign in or retry when authentication is available.");
      }
      const result = await fallback();
      return {
        ...result,
        persistence,
      };
    }

    try {
      const result = await action(user);
      return {
        ...result,
        persistence,
      };
    } catch (error) {
      if (!allowCloudErrorFallback) throw error;
      const fallbackResult = await fallback();
      const message =
        error instanceof Error ? error.message : "Supabase prompt sync failed unexpectedly.";

      return {
        ...fallbackResult,
        persistence: createLocalPersistenceInfo(`${message} Falling back to local prompt storage.`),
      };
    }
  }

  return {
    async loadPrompts() {
      return runWithFallback(
        async (user) => {
          const { prompts, importStatus } = await listCloudPromptsWithImportState(user);
          prompts.forEach((prompt) => cloudRecordIds.add(prompt.id));
          return {
            prompts,
            source: "remote",
            importStatus,
          };
        },
        () => localPromptVaultRepository.loadPrompts()
      );
    },

    async createPrompt(input) {
      return runWithFallback(
        async (user) => {
          const prompt = await createSupabasePrompt(user, input);
          cloudRecordIds.add(prompt.id);
          return {
            prompt,
            source: "remote",
          };
        },
        () => localPromptVaultRepository.createPrompt(input)
      );
    },

    async updatePrompt(input) {
      return runWithFallback(
        async (user) => {
          const prompt = await updateSupabasePrompt(user, input);
          cloudRecordIds.add(prompt.id);
          return {
            prompt,
            source: "remote",
          };
        },
        () => localPromptVaultRepository.updatePrompt(input)
      );
    },

    async deletePrompt(id) {
      return runWithFallback(
        async (user) => {
          cloudRecordIds.add(id);
          await deleteSupabasePrompt(user, id);
          return {
            id,
            deleted: true as const,
            source: "remote" as const,
          };
        },
        () => localPromptVaultRepository.deletePrompt(id),
        false,
        cloudRecordIds.has(id)
      );
    },

    async clonePrompt(item, existingItems) {
      return runWithFallback(
        async (user) => {
          const clonedPrompt = buildPromptClone(
            {
              ...item,
              visibility: item.visibility,
            },
            existingItems
          );
          const prompt = await createSupabasePrompt(user, {
            ...createEmptyPromptDraft(),
            title: clonedPrompt.title,
            category: clonedPrompt.category,
            promptText: clonedPrompt.promptText,
            visibility: clonedPrompt.visibility,
            description: clonedPrompt.description,
          });

          cloudRecordIds.add(prompt.id);
          return {
            prompt,
            clonedFromId: item.id,
            source: "remote",
          };
        },
        () => localPromptVaultRepository.clonePrompt(item, existingItems)
      );
    },

    async importLocalPromptsToCloud() {
      return runWithFallback(
        async (user) => {
          const localPrompts = readRawStoredPrompts();
          const existingCloudPrompts = await listSupabasePrompts(user);
          const existingFingerprints = new Set(
            existingCloudPrompts.map(createPromptFingerprint)
          );
          const promptsToImport = localPrompts.filter(
            (prompt) => !existingFingerprints.has(createPromptFingerprint(prompt))
          );

          let importedCount = 0;
          for (const prompt of promptsToImport) {
            await createSupabasePrompt(user, {
              title: prompt.title,
              category: prompt.category,
              promptText: prompt.promptText,
              visibility: prompt.visibility,
              description: prompt.description,
            });
            importedCount += 1;
          }

          const { prompts, importStatus } = await listCloudPromptsWithImportState(user);
          prompts.forEach((prompt) => cloudRecordIds.add(prompt.id));

          return {
            prompts,
            source: "remote",
            importStatus,
            importedCount,
          };
        },
        () => localPromptVaultRepository.importLocalPromptsToCloud()
      );
    },
  };
}
