"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  SessionMode,
  SessionPromptRef,
  SessionTranscriptRef,
} from "@/lib/contracts/session-context";
import type {
  SessionAnswerResponse,
  SessionExecutionStatus,
  SessionTurnRecord,
} from "@/lib/contracts/session-execution";

export const SESSION_WORKSPACE_STORAGE_KEY = "cloudnexus.session-workspace.v1";
export const SESSION_WORKSPACE_EXPORT_VERSION = 1;
export const SESSION_TEMPLATE_LIBRARY_STORAGE_KEY = "cloudnexus.session-templates.v1";
export const SESSION_WORKSPACE_RECOVERY_STORAGE_KEY = "cloudnexus.session-workspace.recovery.v1";
export const SESSION_WORKSPACE_ACTIVITY_LOG_STORAGE_KEY = "cloudnexus.session-workspace.activity-log.v1";
export const SESSION_WORKSPACE_CHANGE_BASELINE_STORAGE_KEY =
  "cloudnexus.session-workspace.change-baseline.v1";
export const SESSION_WORKSPACE_REVIEWED_STATE_STORAGE_KEY =
  "cloudnexus.session-workspace.reviewed-state.v1";
export const SESSION_WORKSPACE_BASELINE_HISTORY_STORAGE_KEY =
  "cloudnexus.session-workspace.baseline-history.v1";

export type SessionNoteStatus = "open" | "resolved";

export type SessionNoteRecord = {
  id: string;
  type: "freeform" | "decision" | "blocker" | "action-item";
  content: string;
  status: SessionNoteStatus;
  createdAt: number;
};

export type SessionWorkspaceLocalState = {
  mode: SessionMode;
  goal: string;
  selectedPromptRefs: SessionPromptRef[];
  selectedTranscriptRefs: SessionTranscriptRef[];
  executionStatus: SessionExecutionStatus;
  draftUserTurn: string;
  stagedTurns: SessionTurnRecord[];
  assistantPlaceholder: SessionAnswerResponse | null;
  draftNote: string;
  draftNoteType: SessionNoteRecord["type"];
  stagedNotes: SessionNoteRecord[];
};

export type SessionWorkspacePreset = {
  goal: string;
  executionStatus: SessionExecutionStatus;
  starterNotes: Array<Pick<SessionNoteRecord, "type" | "content">>;
};

export type SessionWorkspaceExportPayload = {
  version: typeof SESSION_WORKSPACE_EXPORT_VERSION;
  exportedAt: string;
  readinessSummary?: string;
  state: SessionWorkspaceLocalState;
};

export type SessionWorkspaceTemplate = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  state: Pick<
    SessionWorkspaceLocalState,
    | "mode"
    | "goal"
    | "selectedPromptRefs"
    | "selectedTranscriptRefs"
    | "executionStatus"
    | "stagedNotes"
  >;
};

export type SessionWorkspaceRecoverySnapshot = {
  capturedAt: number;
  reason: string;
  state: SessionWorkspaceLocalState;
};

export type SessionWorkspaceActivityType =
  | "template-saved"
  | "template-loaded"
  | "template-renamed"
  | "template-deleted"
  | "export-triggered"
  | "import-applied"
  | "reset-performed"
  | "restore-performed"
  | "notes-cleared"
  | "turns-cleared"
  | "mode-changed";

export type SessionWorkspaceActivityRecord = {
  id: string;
  type: SessionWorkspaceActivityType;
  message: string;
  createdAt: number;
};

export type SessionWorkspaceChangeBaseline = {
  capturedAt: number;
  reason: string;
  note: string;
  state: Pick<
    SessionWorkspaceLocalState,
    | "mode"
    | "goal"
    | "selectedPromptRefs"
    | "selectedTranscriptRefs"
    | "stagedNotes"
    | "stagedTurns"
  >;
};

export type SessionWorkspaceBaselineHistoryEntry = {
  id: string;
  capturedAt: number;
  reason: string;
  note: string;
};

export type SessionWorkspaceReviewableArea =
  | "mode"
  | "goal"
  | "prompts"
  | "transcripts"
  | "notes"
  | "turns";

export type SessionWorkspaceReviewedState = {
  baselineCapturedAt: number | null;
  reviewedAreas: SessionWorkspaceReviewableArea[];
};

export type SessionWorkspaceImportResult =
  | {
      ok: true;
      data: SessionWorkspaceLocalState;
    }
  | {
      ok: false;
      error: string;
    };

type UseSessionWorkspaceStateOptions = {
  initialState: SessionWorkspaceLocalState;
};

function createTemplateId() {
  return `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createActivityId() {
  return `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBaselineHistoryId() {
  return `baseline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createPresetNote(
  type: SessionNoteRecord["type"],
  content: string,
  index: number
): SessionNoteRecord {
  return {
    id: `preset-note-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    content,
    status: "open",
    createdAt: Date.now() + index,
  };
}

export const SESSION_WORKSPACE_PRESETS: Record<SessionMode, SessionWorkspacePreset> = {
  consultation: {
    goal: "Frame the client problem, capture constraints, and stage expert prompts before any real copilot execution begins.",
    executionStatus: "ready",
    starterNotes: [
      { type: "decision", content: "Define the primary consulting objective for this session." },
      { type: "blocker", content: "Capture missing infrastructure, budget, or timeline constraints." },
      { type: "action-item", content: "List the next client-facing recommendation to validate." },
    ],
  },
  interview: {
    goal: "Prepare interview context, attach the strongest prompt references, and stage candidate-specific talking points locally.",
    executionStatus: "ready",
    starterNotes: [
      { type: "decision", content: "Select the interview angle to emphasize first." },
      { type: "blocker", content: "Capture the missing examples or stories still needed." },
      { type: "action-item", content: "Queue the next answer or follow-up topic to practice." },
    ],
  },
  "note-taking": {
    goal: "Capture decisions, blockers, and action items cleanly while keeping all note scaffolding browser-local.",
    executionStatus: "idle",
    starterNotes: [
      { type: "decision", content: "Decision: add the first confirmed outcome here." },
      { type: "blocker", content: "Blocker: add the first open risk or unresolved dependency here." },
      { type: "action-item", content: "Action item: add the first owner and next step here." },
    ],
  },
  "resume-writing": {
    goal: "Stage resume rewrite context, attach the right prompts, and capture role-target notes before any AI drafting runtime is introduced.",
    executionStatus: "ready",
    starterNotes: [
      { type: "decision", content: "Identify the target role and resume angle for this pass." },
      { type: "blocker", content: "List the missing metrics, outcomes, or project details." },
      { type: "action-item", content: "Choose the next resume section to rewrite manually or later automate." },
    ],
  },
  "meeting-copilot": {
    goal: "Stage meeting transcript context, note-taking scaffolds, and follow-up prompts before live orchestration exists.",
    executionStatus: "ready",
    starterNotes: [
      { type: "decision", content: "Decision: record the first confirmed meeting decision here." },
      { type: "blocker", content: "Blocker: capture the first open issue or dependency here." },
      { type: "action-item", content: "Action item: capture the next owner-driven follow-up here." },
    ],
  },
};

function isSessionMode(value: unknown): value is SessionMode {
  return (
    value === "consultation" ||
    value === "interview" ||
    value === "note-taking" ||
    value === "resume-writing" ||
    value === "meeting-copilot"
  );
}

function isExecutionStatus(value: unknown): value is SessionExecutionStatus {
  return (
    value === "idle" ||
    value === "ready" ||
    value === "running" ||
    value === "streaming" ||
    value === "completed" ||
    value === "failed"
  );
}

function isPromptRef(value: unknown): value is SessionPromptRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionPromptRef>;
  return (
    typeof item.promptId === "string" &&
    typeof item.title === "string" &&
    typeof item.category === "string" &&
    (item.visibility === "private" || item.visibility === "publish_ready") &&
    item.snapshotVersion === 1 &&
    typeof item.hasSessionOverride === "boolean"
  );
}

function isTranscriptRef(value: unknown): value is SessionTranscriptRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionTranscriptRef>;
  const excerptSegmentIdsValid =
    item.excerptSegmentIds === undefined ||
    (Array.isArray(item.excerptSegmentIds) &&
      item.excerptSegmentIds.every((segmentId) => typeof segmentId === "string"));

  return (
    typeof item.transcriptId === "string" &&
    typeof item.title === "string" &&
    (item.status === "uploaded" ||
      item.status === "processing" ||
      item.status === "completed" ||
      item.status === "failed") &&
    (item.excerptText === undefined || typeof item.excerptText === "string") &&
    excerptSegmentIdsValid &&
    item.snapshotVersion === 1
  );
}

function isTurnRecord(value: unknown): value is SessionTurnRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionTurnRecord>;

  return (
    typeof item.id === "string" &&
    typeof item.sessionExecutionId === "string" &&
    (item.role === "user" || item.role === "assistant" || item.role === "system") &&
    typeof item.content === "string" &&
    Array.isArray(item.promptRefs) &&
    item.promptRefs.every(isPromptRef) &&
    Array.isArray(item.transcriptRefs) &&
    item.transcriptRefs.every(isTranscriptRef) &&
    typeof item.createdAt === "number"
  );
}

function isAssistantPlaceholder(value: unknown): value is SessionAnswerResponse {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionAnswerResponse>;

  return (
    typeof item.sessionExecutionId === "string" &&
    (item.turnId === undefined || item.turnId === null || typeof item.turnId === "string") &&
    isExecutionStatus(item.status) &&
    typeof item.answer === "string" &&
    (item.answerMode === "general" ||
      item.answerMode === "concise" ||
      item.answerMode === "detailed" ||
      item.answerMode === "technical" ||
      item.answerMode === "star") &&
    (item.suggestedFollowups === undefined ||
      (Array.isArray(item.suggestedFollowups) &&
        item.suggestedFollowups.every((followup) => typeof followup === "string"))) &&
    (item.source === "local" || item.source === "remote")
  );
}

function isNoteStatus(value: unknown): value is SessionNoteStatus {
  return value === "open" || value === "resolved";
}

function isNoteRecord(value: unknown): value is SessionNoteRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionNoteRecord>;

  return (
    typeof item.id === "string" &&
    (item.type === "freeform" ||
      item.type === "decision" ||
      item.type === "blocker" ||
      item.type === "action-item") &&
    typeof item.content === "string" &&
    isNoteStatus(item.status) &&
    typeof item.createdAt === "number"
  );
}

function isTemplateRecord(value: unknown): value is SessionWorkspaceTemplate {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionWorkspaceTemplate>;

  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number" &&
    !!item.state &&
    typeof item.state === "object" &&
    isSessionMode(item.state.mode) &&
    typeof item.state.goal === "string" &&
    Array.isArray(item.state.selectedPromptRefs) &&
    item.state.selectedPromptRefs.every(isPromptRef) &&
    Array.isArray(item.state.selectedTranscriptRefs) &&
    item.state.selectedTranscriptRefs.every(isTranscriptRef) &&
    isExecutionStatus(item.state.executionStatus) &&
    Array.isArray(item.state.stagedNotes) &&
    item.state.stagedNotes.every(isNoteRecord)
  );
}

function isRecoverySnapshot(value: unknown): value is SessionWorkspaceRecoverySnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionWorkspaceRecoverySnapshot>;

  return (
    typeof item.capturedAt === "number" &&
    typeof item.reason === "string" &&
    !!item.state &&
    typeof item.state === "object"
  );
}

function isActivityRecord(value: unknown): value is SessionWorkspaceActivityRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionWorkspaceActivityRecord>;

  return (
    typeof item.id === "string" &&
    typeof item.type === "string" &&
    typeof item.message === "string" &&
    typeof item.createdAt === "number"
  );
}

function isChangeBaseline(value: unknown): value is SessionWorkspaceChangeBaseline {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionWorkspaceChangeBaseline>;

  return (
    typeof item.capturedAt === "number" &&
    typeof item.reason === "string" &&
    typeof item.note === "string" &&
    !!item.state &&
    typeof item.state === "object" &&
    isSessionMode(item.state.mode) &&
    typeof item.state.goal === "string" &&
    Array.isArray(item.state.selectedPromptRefs) &&
    item.state.selectedPromptRefs.every(isPromptRef) &&
    Array.isArray(item.state.selectedTranscriptRefs) &&
    item.state.selectedTranscriptRefs.every(isTranscriptRef) &&
    Array.isArray(item.state.stagedNotes) &&
    item.state.stagedNotes.every(isNoteRecord) &&
    Array.isArray(item.state.stagedTurns) &&
    item.state.stagedTurns.every(isTurnRecord)
  );
}

function normalizeSessionWorkspaceState(
  parsed: Partial<SessionWorkspaceLocalState>,
  fallbackState: SessionWorkspaceLocalState
): SessionWorkspaceLocalState {
  const mode = isSessionMode(parsed.mode) ? parsed.mode : fallbackState.mode;
  const goal = typeof parsed.goal === "string" ? parsed.goal : fallbackState.goal;
  const selectedPromptRefs = Array.isArray(parsed.selectedPromptRefs)
    ? parsed.selectedPromptRefs.filter(isPromptRef)
    : fallbackState.selectedPromptRefs;
  const selectedTranscriptRefs = Array.isArray(parsed.selectedTranscriptRefs)
    ? parsed.selectedTranscriptRefs.filter(isTranscriptRef)
    : fallbackState.selectedTranscriptRefs;
  const executionStatus = isExecutionStatus(parsed.executionStatus)
    ? parsed.executionStatus
    : fallbackState.executionStatus;
  const draftUserTurn =
    typeof parsed.draftUserTurn === "string" ? parsed.draftUserTurn : fallbackState.draftUserTurn;
  const stagedTurns = Array.isArray(parsed.stagedTurns)
    ? parsed.stagedTurns.filter(isTurnRecord)
    : fallbackState.stagedTurns;
  const assistantPlaceholder = isAssistantPlaceholder(parsed.assistantPlaceholder)
    ? parsed.assistantPlaceholder
    : fallbackState.assistantPlaceholder;
  const draftNote = typeof parsed.draftNote === "string" ? parsed.draftNote : fallbackState.draftNote;
  const draftNoteType =
    parsed.draftNoteType === "freeform" ||
    parsed.draftNoteType === "decision" ||
    parsed.draftNoteType === "blocker" ||
    parsed.draftNoteType === "action-item"
      ? parsed.draftNoteType
      : fallbackState.draftNoteType;
  const stagedNotes = Array.isArray(parsed.stagedNotes)
    ? parsed.stagedNotes.filter(isNoteRecord)
    : fallbackState.stagedNotes;

  return {
    mode,
    goal,
    selectedPromptRefs,
    selectedTranscriptRefs,
    executionStatus,
    draftUserTurn,
    stagedTurns,
    assistantPlaceholder,
    draftNote,
    draftNoteType,
    stagedNotes,
  };
}

function readSessionWorkspaceState(
  initialState: SessionWorkspaceLocalState
): SessionWorkspaceLocalState {
  if (typeof window === "undefined") return initialState;

  const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_STORAGE_KEY);
  if (!rawValue) return initialState;

  try {
    const parsed = JSON.parse(rawValue) as Partial<SessionWorkspaceLocalState>;
    return normalizeSessionWorkspaceState(parsed, initialState);
  } catch {
    return initialState;
  }
}

function writeSessionWorkspaceState(state: SessionWorkspaceLocalState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_WORKSPACE_STORAGE_KEY, JSON.stringify(state));
}

function readSessionWorkspaceRecoverySnapshot(
  initialState: SessionWorkspaceLocalState
): SessionWorkspaceRecoverySnapshot | null {
  if (typeof window === "undefined") return null;

  const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_RECOVERY_STORAGE_KEY);
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecoverySnapshot(parsed)) return null;

    return {
      capturedAt: parsed.capturedAt,
      reason: parsed.reason,
      state: normalizeSessionWorkspaceState(
        parsed.state as Partial<SessionWorkspaceLocalState>,
        initialState
      ),
    };
  } catch {
    return null;
  }
}

function writeSessionWorkspaceRecoverySnapshot(snapshot: SessionWorkspaceRecoverySnapshot | null) {
  if (typeof window === "undefined") return;

  if (!snapshot) {
    window.localStorage.removeItem(SESSION_WORKSPACE_RECOVERY_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(
    SESSION_WORKSPACE_RECOVERY_STORAGE_KEY,
    JSON.stringify(snapshot)
  );
}

function readSessionWorkspaceActivityLog() {
  if (typeof window === "undefined") return [] as SessionWorkspaceActivityRecord[];

  const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_ACTIVITY_LOG_STORAGE_KEY);
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isActivityRecord)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 25);
  } catch {
    return [];
  }
}

function writeSessionWorkspaceActivityLog(entries: SessionWorkspaceActivityRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SESSION_WORKSPACE_ACTIVITY_LOG_STORAGE_KEY,
    JSON.stringify(entries)
  );
}

function readSessionWorkspaceChangeBaseline() {
  if (typeof window === "undefined") return null as SessionWorkspaceChangeBaseline | null;

  const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_CHANGE_BASELINE_STORAGE_KEY);
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return isChangeBaseline(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSessionWorkspaceChangeBaseline(
  baseline: SessionWorkspaceChangeBaseline | null
) {
  if (typeof window === "undefined") return;

  if (!baseline) {
    window.localStorage.removeItem(SESSION_WORKSPACE_CHANGE_BASELINE_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(
    SESSION_WORKSPACE_CHANGE_BASELINE_STORAGE_KEY,
    JSON.stringify(baseline)
  );
}

function isReviewableArea(value: unknown): value is SessionWorkspaceReviewableArea {
  return (
    value === "mode" ||
    value === "goal" ||
    value === "prompts" ||
    value === "transcripts" ||
    value === "notes" ||
    value === "turns"
  );
}

function isReviewedState(value: unknown): value is SessionWorkspaceReviewedState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionWorkspaceReviewedState>;

  return (
    (item.baselineCapturedAt === null || typeof item.baselineCapturedAt === "number") &&
    Array.isArray(item.reviewedAreas) &&
    item.reviewedAreas.every(isReviewableArea)
  );
}

function isBaselineHistoryEntry(value: unknown): value is SessionWorkspaceBaselineHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionWorkspaceBaselineHistoryEntry>;

  return (
    typeof item.id === "string" &&
    typeof item.capturedAt === "number" &&
    typeof item.reason === "string" &&
    typeof item.note === "string"
  );
}

function readSessionWorkspaceReviewedState() {
  if (typeof window === "undefined") {
    return {
      baselineCapturedAt: null,
      reviewedAreas: [],
    } satisfies SessionWorkspaceReviewedState;
  }

  const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_REVIEWED_STATE_STORAGE_KEY);
  if (!rawValue) {
    return {
      baselineCapturedAt: null,
      reviewedAreas: [],
    } satisfies SessionWorkspaceReviewedState;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!isReviewedState(parsed)) {
      return {
        baselineCapturedAt: null,
        reviewedAreas: [],
      } satisfies SessionWorkspaceReviewedState;
    }

    return parsed;
  } catch {
    return {
      baselineCapturedAt: null,
      reviewedAreas: [],
    } satisfies SessionWorkspaceReviewedState;
  }
}

function writeSessionWorkspaceReviewedState(state: SessionWorkspaceReviewedState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SESSION_WORKSPACE_REVIEWED_STATE_STORAGE_KEY,
    JSON.stringify(state)
  );
}

function readSessionWorkspaceBaselineHistory() {
  if (typeof window === "undefined") return [] as SessionWorkspaceBaselineHistoryEntry[];

  const rawValue = window.localStorage.getItem(SESSION_WORKSPACE_BASELINE_HISTORY_STORAGE_KEY);
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isBaselineHistoryEntry)
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function writeSessionWorkspaceBaselineHistory(
  entries: SessionWorkspaceBaselineHistoryEntry[]
) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SESSION_WORKSPACE_BASELINE_HISTORY_STORAGE_KEY,
    JSON.stringify(entries)
  );
}

export function createSessionWorkspaceExportPayload(input: {
  state: SessionWorkspaceLocalState;
  readinessSummary?: string;
}): SessionWorkspaceExportPayload {
  return {
    version: SESSION_WORKSPACE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    readinessSummary: input.readinessSummary,
    state: input.state,
  };
}

export function serializeSessionWorkspaceExport(input: {
  state: SessionWorkspaceLocalState;
  readinessSummary?: string;
}) {
  return JSON.stringify(createSessionWorkspaceExportPayload(input), null, 2);
}

export function parseSessionWorkspaceImport(
  rawValue: string,
  fallbackState: SessionWorkspaceLocalState
): SessionWorkspaceImportResult {
  if (!rawValue.trim()) {
    return { ok: false, error: "Paste a previously exported local session payload first." };
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (parsed && typeof parsed === "object" && "state" in parsed) {
      const payload = parsed as Partial<SessionWorkspaceExportPayload>;

      if (payload.version !== SESSION_WORKSPACE_EXPORT_VERSION) {
        return {
          ok: false,
          error: `Unsupported session export version. Expected v${SESSION_WORKSPACE_EXPORT_VERSION}.`,
        };
      }

      if (!payload.state || typeof payload.state !== "object") {
        return {
          ok: false,
          error: "The exported session payload is missing its local state body.",
        };
      }

      return {
        ok: true,
        data: normalizeSessionWorkspaceState(
          payload.state as Partial<SessionWorkspaceLocalState>,
          fallbackState
        ),
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: "This import payload must be a JSON object exported from the local session shell.",
      };
    }

    return {
      ok: true,
      data: normalizeSessionWorkspaceState(
        parsed as Partial<SessionWorkspaceLocalState>,
        fallbackState
      ),
    };
  } catch {
    return {
      ok: false,
      error: "This import payload is not valid JSON. Paste a clean local session export and try again.",
    };
  }
}

function readSessionWorkspaceTemplates() {
  if (typeof window === "undefined") return [] as SessionWorkspaceTemplate[];

  const rawValue = window.localStorage.getItem(SESSION_TEMPLATE_LIBRARY_STORAGE_KEY);
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTemplateRecord).sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

function writeSessionWorkspaceTemplates(templates: SessionWorkspaceTemplate[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SESSION_TEMPLATE_LIBRARY_STORAGE_KEY,
    JSON.stringify(templates)
  );
}

export function createSessionWorkspaceTemplate(input: {
  name: string;
  state: SessionWorkspaceLocalState;
}): SessionWorkspaceTemplate {
  const timestamp = Date.now();

  return {
    id: createTemplateId(),
    name: input.name.trim() || "Untitled local session template",
    createdAt: timestamp,
    updatedAt: timestamp,
    state: {
      mode: input.state.mode,
      goal: input.state.goal,
      selectedPromptRefs: input.state.selectedPromptRefs,
      selectedTranscriptRefs: input.state.selectedTranscriptRefs,
      executionStatus: input.state.executionStatus,
      stagedNotes: input.state.stagedNotes,
    },
  };
}

export function applySessionWorkspaceTemplate(input: {
  template: SessionWorkspaceTemplate;
  currentState: SessionWorkspaceLocalState;
}): SessionWorkspaceLocalState {
  return {
    ...input.currentState,
    mode: input.template.state.mode,
    goal: input.template.state.goal,
    selectedPromptRefs: input.template.state.selectedPromptRefs,
    selectedTranscriptRefs: input.template.state.selectedTranscriptRefs,
    executionStatus: input.template.state.executionStatus,
    draftUserTurn: "",
    stagedTurns: [],
    assistantPlaceholder: null,
    draftNote: "",
    draftNoteType: "freeform",
    stagedNotes: input.template.state.stagedNotes,
  };
}

export function useSessionWorkspaceState({
  initialState,
}: UseSessionWorkspaceStateOptions) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [state, setState] = useState<SessionWorkspaceLocalState>(initialState);
  const [recoverySnapshot, setRecoverySnapshot] =
    useState<SessionWorkspaceRecoverySnapshot | null>(null);

  useEffect(() => {
    const nextState = readSessionWorkspaceState(initialState);
    const nextRecoverySnapshot = readSessionWorkspaceRecoverySnapshot(initialState);
    setState(nextState);
    setRecoverySnapshot(nextRecoverySnapshot);
    setIsHydrated(true);
  }, [initialState]);

  useEffect(() => {
    if (!isHydrated) return;
    writeSessionWorkspaceState(state);
  }, [isHydrated, state]);

  useEffect(() => {
    if (!isHydrated) return;
    writeSessionWorkspaceRecoverySnapshot(recoverySnapshot);
  }, [isHydrated, recoverySnapshot]);

  const api = useMemo(
    () => ({
      state,
      isHydrated,
      recoverySnapshot,
      setMode: (mode: SessionMode) => {
        setState((current) => ({ ...current, mode }));
      },
      setGoal: (goal: string) => {
        setState((current) => ({ ...current, goal }));
      },
      setExecutionStatus: (executionStatus: SessionExecutionStatus) => {
        setState((current) => ({ ...current, executionStatus }));
      },
      setDraftUserTurn: (draftUserTurn: string) => {
        setState((current) => ({ ...current, draftUserTurn }));
      },
      setDraftNote: (draftNote: string) => {
        setState((current) => ({ ...current, draftNote }));
      },
      setDraftNoteType: (draftNoteType: SessionNoteRecord["type"]) => {
        setState((current) => ({ ...current, draftNoteType }));
      },
      addPromptRef: (ref: SessionPromptRef) => {
        setState((current) => ({
          ...current,
          selectedPromptRefs: current.selectedPromptRefs.some(
            (item) => item.promptId === ref.promptId
          )
            ? current.selectedPromptRefs
            : [...current.selectedPromptRefs, ref],
        }));
      },
      removePromptRef: (promptId: string) => {
        setState((current) => ({
          ...current,
          selectedPromptRefs: current.selectedPromptRefs.filter(
            (item) => item.promptId !== promptId
          ),
        }));
      },
      addTranscriptRef: (ref: SessionTranscriptRef) => {
        setState((current) => ({
          ...current,
          selectedTranscriptRefs: current.selectedTranscriptRefs.some(
            (item) => item.transcriptId === ref.transcriptId
          )
            ? current.selectedTranscriptRefs
            : [...current.selectedTranscriptRefs, ref],
        }));
      },
      removeTranscriptRef: (transcriptId: string) => {
        setState((current) => ({
          ...current,
          selectedTranscriptRefs: current.selectedTranscriptRefs.filter(
            (item) => item.transcriptId !== transcriptId
          ),
        }));
      },
      stageTurn: (turn: SessionTurnRecord) => {
        setState((current) => ({
          ...current,
          stagedTurns: [...current.stagedTurns, turn].sort(
            (left, right) => left.createdAt - right.createdAt
          ),
          draftUserTurn: "",
        }));
      },
      clearTurns: () => {
        setState((current) => ({
          ...current,
          stagedTurns: [],
          assistantPlaceholder: null,
          draftUserTurn: "",
          executionStatus: "idle",
        }));
      },
      setAssistantPlaceholder: (assistantPlaceholder: SessionAnswerResponse | null) => {
        setState((current) => ({ ...current, assistantPlaceholder }));
      },
      stageNote: (note: SessionNoteRecord) => {
        setState((current) => ({
          ...current,
          stagedNotes: [...current.stagedNotes, note].sort(
            (left, right) => left.createdAt - right.createdAt
          ),
          draftNote: "",
        }));
      },
      toggleNoteStatus: (noteId: string) => {
        setState((current) => ({
          ...current,
          stagedNotes: current.stagedNotes.map((note) =>
            note.id === noteId
              ? { ...note, status: note.status === "open" ? "resolved" : "open" }
              : note
          ),
        }));
      },
      removeNote: (noteId: string) => {
        setState((current) => ({
          ...current,
          stagedNotes: current.stagedNotes.filter((note) => note.id !== noteId),
        }));
      },
      clearNotes: () => {
        setState((current) => ({
          ...current,
          draftNote: "",
          draftNoteType: "freeform",
          stagedNotes: [],
        }));
      },
      applyPreset: (mode: SessionMode) => {
        const preset = SESSION_WORKSPACE_PRESETS[mode];
        setState((current) => ({
          ...current,
          mode,
          goal: preset.goal,
          executionStatus: preset.executionStatus,
          draftUserTurn: "",
          stagedTurns: [],
          assistantPlaceholder: null,
          draftNote: "",
          draftNoteType: "freeform",
          stagedNotes: preset.starterNotes.map((note, index) =>
            createPresetNote(note.type, note.content, index)
          ),
        }));
      },
      resetState: () => {
        setState(initialState);
      },
      replaceState: (nextState: SessionWorkspaceLocalState) => {
        setState(nextState);
      },
      captureRecoverySnapshot: (reason: string) => {
        setRecoverySnapshot({
          capturedAt: Date.now(),
          reason,
          state,
        });
      },
      restoreRecoverySnapshot: () => {
        if (!recoverySnapshot) return false;
        setState(recoverySnapshot.state);
        return true;
      },
      clearRecoverySnapshot: () => {
        setRecoverySnapshot(null);
      },
    }),
    [initialState, isHydrated, recoverySnapshot, state]
  );

  return api;
}

export function useSessionWorkspaceTemplates() {
  const [templates, setTemplates] = useState<SessionWorkspaceTemplate[]>([]);

  useEffect(() => {
    setTemplates(readSessionWorkspaceTemplates());
  }, []);

  useEffect(() => {
    writeSessionWorkspaceTemplates(templates);
  }, [templates]);

  return useMemo(
    () => ({
      templates,
      saveTemplate: (input: { name: string; state: SessionWorkspaceLocalState }) => {
        const template = createSessionWorkspaceTemplate(input);
        setTemplates((current) => [template, ...current].sort((left, right) => right.updatedAt - left.updatedAt));
      },
      renameTemplate: (templateId: string, name: string) => {
        const normalizedName = name.trim();
        if (!normalizedName) return;
        setTemplates((current) =>
          current
            .map((template) =>
              template.id === templateId
                ? { ...template, name: normalizedName, updatedAt: Date.now() }
                : template
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)
        );
      },
      deleteTemplate: (templateId: string) => {
        setTemplates((current) => current.filter((template) => template.id !== templateId));
      },
    }),
    [templates]
  );
}

export function useSessionWorkspaceActivityLog() {
  const [entries, setEntries] = useState<SessionWorkspaceActivityRecord[]>([]);

  useEffect(() => {
    setEntries(readSessionWorkspaceActivityLog());
  }, []);

  useEffect(() => {
    writeSessionWorkspaceActivityLog(entries);
  }, [entries]);

  return useMemo(
    () => ({
      entries,
      logActivity: (input: {
        type: SessionWorkspaceActivityType;
        message: string;
      }) => {
        const nextEntry: SessionWorkspaceActivityRecord = {
          id: createActivityId(),
          type: input.type,
          message: input.message,
          createdAt: Date.now(),
        };

        setEntries((current) =>
          [nextEntry, ...current]
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, 25)
        );
      },
      clearActivityLog: () => {
        setEntries([]);
      },
    }),
    [entries]
  );
}

export function createSessionWorkspaceChangeBaseline(input: {
  reason: string;
  note?: string;
  state: SessionWorkspaceLocalState;
}): SessionWorkspaceChangeBaseline {
  return {
    capturedAt: Date.now(),
    reason: input.reason,
    note: input.note?.trim() ?? "",
    state: {
      mode: input.state.mode,
      goal: input.state.goal,
      selectedPromptRefs: input.state.selectedPromptRefs,
      selectedTranscriptRefs: input.state.selectedTranscriptRefs,
      stagedNotes: input.state.stagedNotes,
      stagedTurns: input.state.stagedTurns,
    },
  };
}

function createBaselineHistoryEntry(
  baseline: SessionWorkspaceChangeBaseline
): SessionWorkspaceBaselineHistoryEntry {
  return {
    id: createBaselineHistoryId(),
    capturedAt: baseline.capturedAt,
    reason: baseline.reason,
    note: baseline.note,
  };
}

export function useSessionWorkspaceChangeBaseline() {
  const [baseline, setBaseline] = useState<SessionWorkspaceChangeBaseline | null>(null);
  const [history, setHistory] = useState<SessionWorkspaceBaselineHistoryEntry[]>([]);

  useEffect(() => {
    setBaseline(readSessionWorkspaceChangeBaseline());
    setHistory(readSessionWorkspaceBaselineHistory());
  }, []);

  useEffect(() => {
    writeSessionWorkspaceChangeBaseline(baseline);
  }, [baseline]);

  useEffect(() => {
    writeSessionWorkspaceBaselineHistory(history);
  }, [history]);

  return useMemo(
    () => ({
      baseline,
      history,
      captureBaseline: (input: {
        reason: string;
        note?: string;
        state: SessionWorkspaceLocalState;
      }) => {
        const nextBaseline = createSessionWorkspaceChangeBaseline(input);
        setBaseline(nextBaseline);
        setHistory((current) =>
          [createBaselineHistoryEntry(nextBaseline), ...current]
            .sort((left, right) => right.capturedAt - left.capturedAt)
            .slice(0, 12)
        );
      },
      updateBaselineNote: (note: string) => {
        setBaseline((current) =>
          current
            ? {
                ...current,
                note,
              }
            : current
        );
        setHistory((current) =>
          current.map((entry) =>
            baseline && entry.capturedAt === baseline.capturedAt ? { ...entry, note } : entry
          )
        );
      },
      clearBaselineNote: () => {
        setBaseline((current) =>
          current
            ? {
                ...current,
                note: "",
              }
            : current
        );
        setHistory((current) =>
          current.map((entry) =>
            baseline && entry.capturedAt === baseline.capturedAt ? { ...entry, note: "" } : entry
          )
        );
      },
      deleteHistoryEntry: (entryId: string) => {
        setHistory((current) => current.filter((entry) => entry.id !== entryId));
      },
      clearHistory: () => {
        setHistory([]);
      },
      clearBaseline: () => {
        setBaseline(null);
      },
    }),
    [baseline, history]
  );
}

export function useSessionWorkspaceReviewedState(
  baselineCapturedAt: number | null
) {
  const [reviewedState, setReviewedState] = useState<SessionWorkspaceReviewedState>({
    baselineCapturedAt: null,
    reviewedAreas: [],
  });

  useEffect(() => {
    setReviewedState(readSessionWorkspaceReviewedState());
  }, []);

  useEffect(() => {
    writeSessionWorkspaceReviewedState(reviewedState);
  }, [reviewedState]);

  useEffect(() => {
    setReviewedState((current) => {
      if (current.baselineCapturedAt === baselineCapturedAt) return current;
      return {
        baselineCapturedAt,
        reviewedAreas: [],
      };
    });
  }, [baselineCapturedAt]);

  return useMemo(
    () => ({
      reviewedAreas: reviewedState.reviewedAreas,
      isReviewed: (area: SessionWorkspaceReviewableArea) =>
        reviewedState.baselineCapturedAt === baselineCapturedAt &&
        reviewedState.reviewedAreas.includes(area),
      markReviewed: (area: SessionWorkspaceReviewableArea) => {
        setReviewedState((current) => ({
          baselineCapturedAt,
          reviewedAreas: current.reviewedAreas.includes(area)
            ? current.reviewedAreas
            : [...current.reviewedAreas, area],
        }));
      },
      clearReviewed: (area: SessionWorkspaceReviewableArea) => {
        setReviewedState((current) => ({
          baselineCapturedAt,
          reviewedAreas: current.reviewedAreas.filter((item) => item !== area),
        }));
      },
      clearAllReviewed: () => {
        setReviewedState({
          baselineCapturedAt,
          reviewedAreas: [],
        });
      },
    }),
    [baselineCapturedAt, reviewedState.baselineCapturedAt, reviewedState.reviewedAreas]
  );
}
