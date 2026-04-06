import { SESSION_WORKSPACE_STORAGE_KEY } from "@/lib/session-workspace-state";

export type ReadyStatePreferences = {
  roleMode?: string;
  layout?: string;
  accentMode?: string;
};

export type ReadyStateLocalConfigurationSummary = {
  roleMode: string | null;
  promptCount: number;
  transcriptCount: number;
  noteCount: number;
  executionStatus: string | null;
};

export const READY_STATE_PREFERENCES_STORAGE_KEY = "cloudnexus.ready-state.preferences.v1";

export function readReadyStatePreferences(): ReadyStatePreferences {
  if (typeof window === "undefined") return {};

  try {
    const rawValue = window.localStorage.getItem(READY_STATE_PREFERENCES_STORAGE_KEY);
    if (!rawValue) return {};

    const parsed = JSON.parse(rawValue) as ReadyStatePreferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeReadyStatePreferences(preferences: ReadyStatePreferences) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      READY_STATE_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    );
  } catch {
    // Keep the ready-state screen browser-local and resilient even if storage is unavailable.
  }
}

export function readReadyStateLocalConfiguration(): ReadyStateLocalConfigurationSummary | null {
  if (typeof window === "undefined") return null;

  try {
    const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_STORAGE_KEY);
    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue) as {
      mode?: string;
      selectedPromptRefs?: unknown[];
      selectedTranscriptRefs?: unknown[];
      stagedNotes?: unknown[];
      executionStatus?: string;
    };

    return {
      roleMode: typeof parsed.mode === "string" ? parsed.mode : null,
      promptCount: Array.isArray(parsed.selectedPromptRefs) ? parsed.selectedPromptRefs.length : 0,
      transcriptCount: Array.isArray(parsed.selectedTranscriptRefs)
        ? parsed.selectedTranscriptRefs.length
        : 0,
      noteCount: Array.isArray(parsed.stagedNotes) ? parsed.stagedNotes.length : 0,
      executionStatus: typeof parsed.executionStatus === "string" ? parsed.executionStatus : null,
    };
  } catch {
    return null;
  }
}
