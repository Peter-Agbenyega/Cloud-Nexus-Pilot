"use client";

export const TRANSCRIPT_WORKSPACE_RECOVERY_KEY =
  "cloudnexus.transcript-workspace-recovery.v1";

export type TranscriptWorkspaceRecoveryIntent = {
  transcriptId: string;
  openedAt: number;
};

export function readTranscriptWorkspaceRecoveryIntent(): TranscriptWorkspaceRecoveryIntent | null {
  if (typeof window === "undefined") return null;

  const rawValue = window.localStorage.getItem(TRANSCRIPT_WORKSPACE_RECOVERY_KEY);
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as Partial<TranscriptWorkspaceRecoveryIntent>;

    if (typeof parsed.transcriptId !== "string" || typeof parsed.openedAt !== "number") {
      return null;
    }

    return {
      transcriptId: parsed.transcriptId,
      openedAt: parsed.openedAt,
    };
  } catch {
    return null;
  }
}

export function writeTranscriptWorkspaceRecoveryIntent(transcriptId: string, openedAt = Date.now()) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(
    TRANSCRIPT_WORKSPACE_RECOVERY_KEY,
    JSON.stringify({
      transcriptId,
      openedAt,
    } satisfies TranscriptWorkspaceRecoveryIntent)
  );
}

export function clearTranscriptWorkspaceRecoveryIntent() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TRANSCRIPT_WORKSPACE_RECOVERY_KEY);
}
