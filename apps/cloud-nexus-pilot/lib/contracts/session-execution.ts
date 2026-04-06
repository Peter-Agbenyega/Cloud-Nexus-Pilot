import type { AnswerMode, InterviewIntent } from "@/lib/contracts/interview";
import type {
  SessionContextId,
  SessionMode,
  SessionPromptRef,
  SessionTranscriptRef,
} from "@/lib/contracts/session-context";

export type SessionExecutionId = string;
export type SessionTurnId = string;
export type SessionTurnRole = "user" | "assistant" | "system";

export type SessionExecutionStatus =
  | "idle"
  | "ready"
  | "running"
  | "streaming"
  | "completed"
  | "failed";

export type SessionTurnRecord = {
  id: SessionTurnId;
  sessionExecutionId: SessionExecutionId;
  role: SessionTurnRole;
  content: string;
  promptRefs: SessionPromptRef[];
  transcriptRefs: SessionTranscriptRef[];
  createdAt: number;
};

export type CreateOrResumeSessionInput = {
  sessionContextId?: SessionContextId | null;
  mode: SessionMode;
  title?: string;
  goal?: string;
  promptRefs?: SessionPromptRef[];
  transcriptRefs?: SessionTranscriptRef[];
  currentRoute?: string | null;
};

export type CreateOrResumeSessionResponse = {
  sessionExecutionId: SessionExecutionId;
  sessionContextId: SessionContextId | null;
  mode: SessionMode;
  status: SessionExecutionStatus;
  turnCount: number;
  promptRefs: SessionPromptRef[];
  transcriptRefs: SessionTranscriptRef[];
  source: "local" | "remote";
};

export type AppendSessionTurnInput = {
  sessionExecutionId: SessionExecutionId;
  sessionContextId?: SessionContextId | null;
  role: SessionTurnRole;
  content: string;
  promptRefs?: SessionPromptRef[];
  transcriptRefs?: SessionTranscriptRef[];
};

export type AppendSessionTurnResponse = {
  turn: SessionTurnRecord;
  sessionExecutionId: SessionExecutionId;
  status: SessionExecutionStatus;
  source: "local" | "remote";
};

export type RequestSessionAnswerInput = {
  sessionExecutionId: SessionExecutionId;
  sessionContextId?: SessionContextId | null;
  message: string;
  answerMode?: AnswerMode;
  interviewIntent?: InterviewIntent | null;
  promptRefs?: SessionPromptRef[];
  transcriptRefs?: SessionTranscriptRef[];
};

export type SessionAnswerChunk = {
  id: string;
  sessionExecutionId: SessionExecutionId;
  turnId?: SessionTurnId | null;
  token: string;
  index: number;
  done: boolean;
};

export type SessionAnswerResponse = {
  sessionExecutionId: SessionExecutionId;
  turnId?: SessionTurnId | null;
  status: SessionExecutionStatus;
  answer: string;
  answerMode: AnswerMode;
  suggestedFollowups?: string[];
  source: "local" | "remote";
};

export type StreamSessionAnswerRequest = RequestSessionAnswerInput;

export type SessionExecutionValidationError = {
  field:
    | "sessionExecutionId"
    | "sessionContextId"
    | "mode"
    | "title"
    | "goal"
    | "role"
    | "content"
    | "message"
    | "answerMode"
    | "interviewIntent"
    | "promptRefs"
    | "transcriptRefs"
    | "currentRoute";
  code: "required" | "invalid" | "not_found" | "forbidden" | "conflict";
  message: string;
};

export type SessionExecutionApiError = {
  error: {
    code:
      | "session_execution_validation_failed"
      | "session_execution_not_found"
      | "session_execution_access_denied"
      | "session_execution_conflict"
      | "session_execution_backend_unavailable";
    message: string;
    details?: SessionExecutionValidationError[];
  };
};

export const SESSION_EXECUTION_ENDPOINTS = {
  createOrResume: "/sessions/execute",
  appendTurn: "/sessions/execute/:id/turns",
  answer: "/sessions/execute/:id/answer",
  stream: "/sessions/execute/:id/stream",
} as const;

export const SESSION_EXECUTION_CONTRACT_VERSION = {
  version: 1,
  note: "v1 separates execution from session context so runtime orchestration can arrive later without changing Prompt Vault or Transcription ownership boundaries.",
} as const;

export function createOrResumeSessionPayload(input: CreateOrResumeSessionInput) {
  return {
    sessionContextId: input.sessionContextId?.trim() || null,
    mode: input.mode,
    title: input.title?.trim() || "",
    goal: input.goal?.trim() || "",
    promptRefs: [...(input.promptRefs ?? [])],
    transcriptRefs: [...(input.transcriptRefs ?? [])],
    currentRoute: input.currentRoute?.trim() || null,
  };
}

export function createAppendSessionTurnPayload(input: AppendSessionTurnInput) {
  return {
    sessionExecutionId: input.sessionExecutionId,
    sessionContextId: input.sessionContextId?.trim() || null,
    role: input.role,
    content: input.content.trim(),
    promptRefs: [...(input.promptRefs ?? [])],
    transcriptRefs: [...(input.transcriptRefs ?? [])],
  };
}

export function createRequestSessionAnswerPayload(input: RequestSessionAnswerInput) {
  return {
    sessionExecutionId: input.sessionExecutionId,
    sessionContextId: input.sessionContextId?.trim() || null,
    message: input.message.trim(),
    answerMode: input.answerMode ?? "general",
    interviewIntent: input.interviewIntent ?? null,
    promptRefs: [...(input.promptRefs ?? [])],
    transcriptRefs: [...(input.transcriptRefs ?? [])],
  };
}
