import type { PromptId } from "@/lib/contracts/prompt-vault";
import type { TranscriptId } from "@/lib/contracts/transcription";

export type SessionContextId = string;

export type SessionMode =
  | "consultation"
  | "interview"
  | "note-taking"
  | "resume-writing"
  | "meeting-copilot";

export type SessionContextStatus = "draft" | "active" | "paused" | "archived";

export type SessionPromptRef = {
  promptId: PromptId;
  title: string;
  category: string;
  visibility: "private" | "publish_ready";
  snapshotVersion: 1;
  hasSessionOverride: boolean;
};

export type SessionTranscriptRef = {
  transcriptId: TranscriptId;
  title: string;
  status: "uploaded" | "processing" | "completed" | "failed";
  excerptText?: string;
  excerptSegmentIds?: string[];
  snapshotVersion: 1;
};

export type SessionAttachmentRef =
  | {
      type: "prompt";
      ref: SessionPromptRef;
    }
  | {
      type: "transcript";
      ref: SessionTranscriptRef;
    };

export type SessionContextRecord = {
  id: SessionContextId;
  title: string;
  mode: SessionMode;
  status: SessionContextStatus;
  goal: string;
  promptRefs: SessionPromptRef[];
  transcriptRefs: SessionTranscriptRef[];
  attachments: SessionAttachmentRef[];
  recentTurnCount: number;
  noteCount: number;
  currentRoute?: string | null;
  activePane?: "workspace" | "prompt-vault" | "transcripts" | "notes" | "summary" | null;
  createdAt: number;
  updatedAt: number;
  ownerScope: "local-user" | "authenticated-user";
  ownerId: string | null;
  version: 1;
};

export type CreateSessionContextInput = {
  title: string;
  mode: SessionMode;
  goal: string;
  status?: SessionContextStatus;
  promptRefs?: SessionPromptRef[];
  transcriptRefs?: SessionTranscriptRef[];
  currentRoute?: string | null;
  activePane?: SessionContextRecord["activePane"];
};

export type UpdateSessionContextInput = {
  id: SessionContextId;
  title?: string;
  mode?: SessionMode;
  goal?: string;
  status?: SessionContextStatus;
  promptRefs?: SessionPromptRef[];
  transcriptRefs?: SessionTranscriptRef[];
  currentRoute?: string | null;
  activePane?: SessionContextRecord["activePane"];
};

export type SessionContextResponse = {
  sessionContext: SessionContextRecord;
  source: "local" | "remote";
};

export type SessionContextListResponse = {
  sessionContexts: SessionContextRecord[];
  source: "local" | "remote";
};

export type SessionContextValidationError = {
  field:
    | "id"
    | "title"
    | "mode"
    | "goal"
    | "status"
    | "promptRefs"
    | "transcriptRefs"
    | "currentRoute"
    | "activePane";
  code: "required" | "invalid" | "not_found" | "forbidden" | "conflict";
  message: string;
};

export type SessionContextApiError = {
  error: {
    code:
      | "session_context_validation_failed"
      | "session_context_not_found"
      | "session_context_access_denied"
      | "session_context_conflict"
      | "session_context_backend_unavailable";
    message: string;
    details?: SessionContextValidationError[];
  };
};

export const SESSION_CONTEXT_ENDPOINTS = {
  list: "/sessions",
  create: "/sessions",
  detail: "/sessions/:id",
  update: "/sessions/:id",
} as const;

export const SESSION_CONTEXT_OWNERSHIP = {
  currentMode: "local-user",
  ownerId: null,
  authRequired: false,
  futureOwnerSource: "supabase-auth-user-id",
  ownershipNote:
    "Session context should remain a separate orchestration layer above prompts and transcripts. v1 contracts stay frontend-safe while future persistence moves to authenticated user ownership.",
} as const;

export const SESSION_CONTEXT_CONTRACT_VERSION = {
  version: 1,
  note: "v1 keeps Prompt Vault and Transcription connected by reference only, leaving session orchestration implementation for a later milestone.",
} as const;

export function createSessionContextRecord(
  input: CreateSessionContextInput,
  ownerScope: SessionContextRecord["ownerScope"] = "local-user",
  ownerId: string | null = null
): SessionContextRecord {
  const timestamp = Date.now();

  return {
    id: `session-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    title: input.title.trim(),
    mode: input.mode,
    status: input.status ?? "draft",
    goal: input.goal.trim(),
    promptRefs: [...(input.promptRefs ?? [])],
    transcriptRefs: [...(input.transcriptRefs ?? [])],
    attachments: [
      ...(input.promptRefs ?? []).map((ref) => ({ type: "prompt", ref }) as const),
      ...(input.transcriptRefs ?? []).map((ref) => ({ type: "transcript", ref }) as const),
    ],
    recentTurnCount: 0,
    noteCount: 0,
    currentRoute: input.currentRoute?.trim() || null,
    activePane: input.activePane ?? "workspace",
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerScope,
    ownerId,
    version: 1,
  };
}

export function createSessionContextCreatePayload(input: CreateSessionContextInput) {
  return {
    title: input.title.trim(),
    mode: input.mode,
    goal: input.goal.trim(),
    status: input.status ?? "draft",
    promptRefs: [...(input.promptRefs ?? [])],
    transcriptRefs: [...(input.transcriptRefs ?? [])],
    currentRoute: input.currentRoute?.trim() || null,
    activePane: input.activePane ?? "workspace",
  };
}

export function createSessionContextUpdatePayload(input: UpdateSessionContextInput) {
  return {
    id: input.id,
    title: input.title?.trim(),
    mode: input.mode,
    goal: input.goal?.trim(),
    status: input.status,
    promptRefs: input.promptRefs ? [...input.promptRefs] : undefined,
    transcriptRefs: input.transcriptRefs ? [...input.transcriptRefs] : undefined,
    currentRoute: input.currentRoute === undefined ? undefined : input.currentRoute?.trim() || null,
    activePane: input.activePane,
  };
}
