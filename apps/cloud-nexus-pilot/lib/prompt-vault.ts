export const PROMPT_VAULT_CATEGORIES = [
  "Interview",
  "Resume",
  "Job Match",
  "Meeting Notes",
  "Automation",
  "General",
] as const;

export type PromptCategory = (typeof PROMPT_VAULT_CATEGORIES)[number];
export type PromptVisibility = "private" | "publish_ready";

export type PromptVaultItem = {
  id: string;
  title: string;
  category: PromptCategory;
  promptText: string;
  visibility: PromptVisibility;
  description: string;
  createdAt: number;
  updatedAt: number;
};

export type PromptVaultDraft = {
  title: string;
  category: PromptCategory;
  promptText: string;
  visibility: PromptVisibility;
  description: string;
};

export const PROMPT_VAULT_STORAGE_KEY = "cloudnexus.prompt-vault.v1";

export const PROMPT_VAULT_STARTERS: ReadonlyArray<PromptVaultItem> = [
  {
    id: "starter-interview-debrief",
    title: "Interview Debrief Synthesizer",
    category: "Interview",
    promptText:
      "Review this interview transcript and produce strengths, risks, signal summary, and next-step recommendations in a clean hiring debrief format.",
    visibility: "publish_ready",
    description: "Turn raw interview notes into a structured hiring debrief.",
    createdAt: Date.UTC(2026, 2, 1),
    updatedAt: Date.UTC(2026, 2, 1),
  },
  {
    id: "starter-meeting-summary",
    title: "Meeting Summary with Owners",
    category: "Meeting Notes",
    promptText:
      "Summarize this meeting into decisions, action items, open questions, and owners. Keep it concise and operator-friendly.",
    visibility: "private",
    description: "Useful for leadership syncs, hiring reviews, and customer calls.",
    createdAt: Date.UTC(2026, 2, 2),
    updatedAt: Date.UTC(2026, 2, 2),
  },
  {
    id: "starter-scorecard",
    title: "Candidate Scorecard Builder",
    category: "Interview",
    promptText:
      "Map transcript evidence to role competencies, then produce a scorecard with supporting quotes, confidence level, and follow-up questions.",
    visibility: "publish_ready",
    description: "Great for turning interviews into repeatable decision records.",
    createdAt: Date.UTC(2026, 2, 3),
    updatedAt: Date.UTC(2026, 2, 3),
  },
];

export function createEmptyPromptDraft(): PromptVaultDraft {
  return {
    title: "",
    category: "General",
    promptText: "",
    visibility: "private",
    description: "",
  };
}

export function sanitizePromptDraft(draft: PromptVaultDraft): PromptVaultDraft {
  return {
    title: draft.title.trim(),
    category: draft.category,
    promptText: draft.promptText.trim(),
    visibility: draft.visibility,
    description: draft.visibility === "publish_ready" ? draft.description.trim() : "",
  };
}

export function validatePromptDraft(draft: PromptVaultDraft): string {
  const sanitized = sanitizePromptDraft(draft);

  if (!sanitized.title) return "Prompt title is required.";
  if (!sanitized.promptText) return "Prompt text is required.";

  return "";
}

export function createPromptVaultItem(draft: PromptVaultDraft): PromptVaultItem {
  const sanitized = sanitizePromptDraft(draft);
  const timestamp = Date.now();

  return {
    id: `prompt-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    title: sanitized.title,
    category: sanitized.category,
    promptText: sanitized.promptText,
    visibility: sanitized.visibility,
    description: sanitized.description,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updatePromptVaultItem(
  existing: PromptVaultItem,
  draft: PromptVaultDraft
): PromptVaultItem {
  const sanitized = sanitizePromptDraft(draft);

  return {
    ...existing,
    title: sanitized.title,
    category: sanitized.category,
    promptText: sanitized.promptText,
    visibility: sanitized.visibility,
    description: sanitized.description,
    updatedAt: Date.now(),
  };
}

export function buildPromptClone(item: PromptVaultItem, existingItems: ReadonlyArray<PromptVaultItem>) {
  const baseTitle = item.title.trim() || "Untitled Prompt";
  const existingTitles = new Set(existingItems.map((entry) => entry.title.trim().toLowerCase()));
  let nextTitle = `${baseTitle} (Copy)`;
  let copyIndex = 2;

  while (existingTitles.has(nextTitle.toLowerCase())) {
    nextTitle = `${baseTitle} (Copy ${copyIndex})`;
    copyIndex += 1;
  }

  return createPromptVaultItem({
    title: nextTitle,
    category: item.category,
    promptText: item.promptText,
    visibility: "private",
    description: item.description,
  });
}

export function sortPromptVaultItems(items: ReadonlyArray<PromptVaultItem>) {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function parsePromptVaultItems(rawValue: string | null): PromptVaultItem[] {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as PromptVaultItem[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : `prompt-${Date.now()}`,
        title: typeof item.title === "string" ? item.title : "Untitled Prompt",
        category: PROMPT_VAULT_CATEGORIES.includes(item.category as PromptCategory)
          ? (item.category as PromptCategory)
          : "General",
        promptText: typeof item.promptText === "string" ? item.promptText : "",
        visibility:
          item.visibility === "publish_ready" || item.visibility === "private"
            ? item.visibility
            : "private",
        description: typeof item.description === "string" ? item.description : "",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

/** An explicit empty array is a saved empty vault, not a request to reseed examples. */
export function resolveStoredPromptVaultItems(rawValue: string | null): PromptVaultItem[] {
  const items = sortPromptVaultItems(parsePromptVaultItems(rawValue));
  if (items.length > 0) return items;
  try {
    const parsed: unknown = rawValue === null ? null : JSON.parse(rawValue);
    if (Array.isArray(parsed) && parsed.length === 0) return [];
  } catch {
    // Preserve the existing starter fallback for malformed storage.
  }
  return [...PROMPT_VAULT_STARTERS];
}
