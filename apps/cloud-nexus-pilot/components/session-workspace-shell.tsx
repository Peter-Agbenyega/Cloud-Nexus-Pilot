"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TranscriptionRuntimeSurface } from "@/features/transcription/transcription-runtime-surface";
import {
  useTranscriptionWorkflow,
  type LocalTranscriptionScenario,
  type TranscriptSegment as WorkflowTranscriptSegment,
} from "@/features/transcription/use-transcription-workflow";
import {
  createSessionContextCreatePayload,
  type SessionContextRecord,
  type SessionMode,
  type SessionPromptRef,
  type SessionTranscriptRef,
} from "@/lib/contracts/session-context";
import {
  createAppendSessionTurnPayload,
  createOrResumeSessionPayload,
  createRequestSessionAnswerPayload,
  type CreateOrResumeSessionResponse,
  type SessionAnswerResponse,
  type SessionExecutionStatus,
  type SessionTurnRecord,
} from "@/lib/contracts/session-execution";
import type { TranscriptRecord, TranscriptSource } from "@/lib/contracts/transcription";
import {
  applySessionWorkspaceTemplate,
  parseSessionWorkspaceImport,
  serializeSessionWorkspaceExport,
  SESSION_WORKSPACE_PRESETS,
  useSessionWorkspaceActivityLog,
  useSessionWorkspaceChangeBaseline,
  useSessionWorkspaceReviewedState,
  type SessionWorkspaceReviewableArea,
  useSessionWorkspaceState,
  useSessionWorkspaceTemplates,
  type SessionWorkspaceTemplate,
  type SessionNoteRecord,
} from "@/lib/session-workspace-state";
import {
  clearTranscriptWorkspaceRecoveryIntent,
  readTranscriptWorkspaceRecoveryIntent,
} from "@/lib/transcript-workspace-recovery";
import { writeReadyStatePreferences } from "@/lib/ready-state-preferences";
import { getLocalStoredTranscriptById } from "@/lib/transcription-persistence";

const SESSION_MODE_OPTIONS: SessionMode[] = [
  "consultation",
  "interview",
  "note-taking",
  "resume-writing",
  "meeting-copilot",
];

const SESSION_NOTE_TYPE_OPTIONS: SessionNoteRecord["type"][] = [
  "freeform",
  "decision",
  "blocker",
  "action-item",
];

const PROMPT_REFERENCE_CANDIDATES: SessionPromptRef[] = [
  {
    promptId: "prompt-session-consultation",
    title: "Cloud Strategy Consultation",
    category: "meeting",
    visibility: "private",
    snapshotVersion: 1,
    hasSessionOverride: false,
  },
  {
    promptId: "prompt-session-interview",
    title: "Interview Debrief Operator",
    category: "interview",
    visibility: "publish_ready",
    snapshotVersion: 1,
    hasSessionOverride: false,
  },
  {
    promptId: "prompt-session-resume",
    title: "ATS Resume Rewrite",
    category: "summary",
    visibility: "private",
    snapshotVersion: 1,
    hasSessionOverride: true,
  },
  {
    promptId: "prompt-session-notes",
    title: "Structured Note Ledger",
    category: "summary",
    visibility: "private",
    snapshotVersion: 1,
    hasSessionOverride: false,
  },
  {
    promptId: "prompt-session-meeting",
    title: "Meeting Copilot Operator",
    category: "meeting",
    visibility: "publish_ready",
    snapshotVersion: 1,
    hasSessionOverride: false,
  },
];

const TRANSCRIPT_REFERENCE_CANDIDATES: SessionTranscriptRef[] = [
  {
    transcriptId: "transcript-session-intake",
    title: "Client Intake Discovery Call",
    status: "completed",
    excerptText: "Need a practical automation roadmap for AWS and cloud security controls.",
    excerptSegmentIds: ["segment-1", "segment-2"],
    snapshotVersion: 1,
  },
  {
    transcriptId: "transcript-session-mock-interview",
    title: "Platform Engineer Mock Interview",
    status: "completed",
    excerptText: "Focus on systems thinking, ownership, and incident response examples.",
    excerptSegmentIds: ["segment-4"],
    snapshotVersion: 1,
  },
  {
    transcriptId: "transcript-session-notes",
    title: "Weekly Leadership Sync",
    status: "processing",
    excerptText: "Capture decisions, blockers, and action items without generating AI output yet.",
    excerptSegmentIds: ["segment-2"],
    snapshotVersion: 1,
  },
  {
    transcriptId: "transcript-session-resume",
    title: "Resume Experience Intake",
    status: "completed",
    excerptText: "Highlight quantified impact, scope, and ownership before resume rewriting starts.",
    excerptSegmentIds: ["segment-3"],
    snapshotVersion: 1,
  },
];

const MODE_REFERENCE_RECOMMENDATIONS: Record<
  SessionMode,
  {
    promptIds: string[];
    transcriptIds: string[];
    hint: string;
  }
> = {
  consultation: {
    promptIds: ["prompt-session-consultation"],
    transcriptIds: ["transcript-session-intake"],
    hint: "Attach the strategy consultation prompt and the client intake transcript first so the shell stays anchored on the problem statement.",
  },
  interview: {
    promptIds: ["prompt-session-interview"],
    transcriptIds: ["transcript-session-mock-interview"],
    hint: "Start with the interview debrief prompt and the mock interview transcript to keep practice turns grounded in the right examples.",
  },
  "note-taking": {
    promptIds: ["prompt-session-notes"],
    transcriptIds: ["transcript-session-notes"],
    hint: "Attach the note ledger prompt and the meeting transcript first so manual notes, decisions, and blockers have the right context.",
  },
  "resume-writing": {
    promptIds: ["prompt-session-resume"],
    transcriptIds: ["transcript-session-resume"],
    hint: "Attach the ATS rewrite prompt and the resume intake transcript first so the shell is focused on measurable experience and role alignment.",
  },
  "meeting-copilot": {
    promptIds: ["prompt-session-meeting", "prompt-session-notes"],
    transcriptIds: ["transcript-session-notes"],
    hint: "Start with the meeting copilot operator, then keep the note ledger prompt nearby so follow-ups and manual note capture stay aligned.",
  },
};

function createStableId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

type NoteDiffLine = {
  kind: "added" | "removed" | "unchanged";
  value: string;
};

function createBaselineNoteDiff(currentNote: string, historicalNote: string): NoteDiffLine[] {
  const currentLines = currentNote
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const historicalLines = historicalNote
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const maxLength = Math.max(currentLines.length, historicalLines.length);
  const diff: NoteDiffLine[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const currentLine = currentLines[index];
    const historicalLine = historicalLines[index];

    if (currentLine === historicalLine && currentLine) {
      diff.push({ kind: "unchanged", value: currentLine });
      continue;
    }

    if (historicalLine) {
      diff.push({ kind: "added", value: historicalLine });
    }

    if (currentLine) {
      diff.push({ kind: "removed", value: currentLine });
    }
  }

  return diff;
}

type ReadinessItem = {
  label: string;
  status: "ready" | "missing" | "partial";
  detail: string;
};

function isTranscriptRequired(mode: SessionMode) {
  return mode !== "resume-writing";
}

function createReadinessChecklist(input: {
  mode: SessionMode;
  goal: string;
  promptCount: number;
  transcriptCount: number;
  noteCount: number;
  turnCount: number;
  executionStatus: SessionExecutionStatus;
}) {
  const items: ReadinessItem[] = [
    {
      label: "Mode selected",
      status: "ready",
      detail: `${input.mode} preset is active.`,
    },
    {
      label: "Goal text",
      status: input.goal.trim() ? "ready" : "missing",
      detail: input.goal.trim()
        ? "Session goal is present."
        : "Add a local goal so the future runtime has a clear objective.",
    },
    {
      label: "Prompt reference",
      status: input.promptCount > 0 ? "ready" : "missing",
      detail:
        input.promptCount > 0
          ? `${input.promptCount} prompt reference${input.promptCount === 1 ? "" : "s"} attached.`
          : "Attach at least one prompt reference for this mode.",
    },
    {
      label: "Transcript reference",
      status: input.transcriptCount > 0 ? "ready" : isTranscriptRequired(input.mode) ? "missing" : "partial",
      detail:
        input.transcriptCount > 0
          ? `${input.transcriptCount} transcript reference${input.transcriptCount === 1 ? "" : "s"} attached.`
          : isTranscriptRequired(input.mode)
            ? "Attach a transcript reference to ground this mode in source context."
            : "Optional for this mode, but useful if you want richer source context later.",
    },
    {
      label: "Note layer",
      status: input.noteCount > 0 ? "ready" : "missing",
      detail:
        input.noteCount > 0
          ? `${input.noteCount} local note${input.noteCount === 1 ? "" : "s"} staged.`
          : "Start the note layer so decisions, blockers, or action items are captured locally.",
    },
    {
      label: "Turn history",
      status: input.turnCount > 0 ? "ready" : "missing",
      detail:
        input.turnCount > 0
          ? `${input.turnCount} local turn${input.turnCount === 1 ? "" : "s"} staged.`
          : "Stage at least one local turn so the shell has an execution envelope to audit.",
    },
    {
      label: "Passive execution status",
      status: input.executionStatus === "idle" ? "partial" : "ready",
      detail:
        input.executionStatus === "idle"
          ? "Execution is still idle. Mark it ready when the local shell feels prepared."
          : `Passive execution is marked ${input.executionStatus}.`,
    },
  ];

  const hasMissing = items.some((item) => item.status === "missing");
  const hasPartial = items.some((item) => item.status === "partial");

  return {
    items,
    summary: hasMissing ? "partially ready" : hasPartial ? "partially ready" : "ready",
  };
}

function describePromptValue(mode: SessionMode, ref: SessionPromptRef): string {
  if (mode === "consultation" && ref.promptId === "prompt-session-consultation") {
    return "Keeps the workspace focused on problem framing, constraints, and practical client guidance.";
  }

  if (mode === "interview" && ref.promptId === "prompt-session-interview") {
    return "Anchors the session on interview-ready debriefing, follow-up structure, and answer practice.";
  }

  if (mode === "note-taking" && ref.promptId === "prompt-session-notes") {
    return "Supports a structured manual note flow for decisions, blockers, and action items.";
  }

  if (mode === "resume-writing" && ref.promptId === "prompt-session-resume") {
    return "Keeps the shell centered on ATS-safe rewriting and measurable experience framing.";
  }

  if (mode === "meeting-copilot" && ref.promptId === "prompt-session-meeting") {
    return "Provides the meeting-focused operating prompt for follow-ups, facilitation, and synthesis later.";
  }

  if (mode === "meeting-copilot" && ref.promptId === "prompt-session-notes") {
    return "Adds a structured note ledger alongside the meeting operator so manual capture stays organized.";
  }

  return "Adds an attached prompt reference that can still be reused later when real session runtime arrives.";
}

function describeTranscriptValue(mode: SessionMode, ref: SessionTranscriptRef): string {
  if (mode === "consultation" && ref.transcriptId === "transcript-session-intake") {
    return "Captures the client discovery context so the workspace stays grounded in the real problem statement.";
  }

  if (mode === "interview" && ref.transcriptId === "transcript-session-mock-interview") {
    return "Provides practice material and technical examples that fit the interview preset best.";
  }

  if (
    (mode === "note-taking" || mode === "meeting-copilot") &&
    ref.transcriptId === "transcript-session-notes"
  ) {
    return "Supplies a meeting-style transcript reference so manual notes, blockers, and follow-ups have context.";
  }

  if (mode === "resume-writing" && ref.transcriptId === "transcript-session-resume") {
    return "Provides raw experience and impact language that can later feed resume drafting or rewrite workflows.";
  }

  return "Adds transcript context by reference so the workspace can stay audit-friendly without duplicating source data.";
}

function compareStringLists(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function normalizeReplayComparisonContext(
  input: ReplayComparisonContext,
  validBaselineHistoryIds: Set<string>
): ReplayComparisonContext {
  const focusedCandidateIds = input.focusedCandidateIds.filter((entryId) =>
    validBaselineHistoryIds.has(entryId)
  );
  const activeCompareTargetId =
    input.activeCompareTargetId && focusedCandidateIds.includes(input.activeCompareTargetId)
      ? input.activeCompareTargetId
      : focusedCandidateIds[0] ?? null;

  return {
    focusedCandidateIds,
    activeCompareTargetId,
  };
}

function normalizeReplayLiveContext(
  input: ReplayLiveContext,
  validBaselineHistoryIds: Set<string>
): ReplayLiveContext {
  const focusedCandidateIds = input.focusedCandidateIds.filter((entryId) =>
    validBaselineHistoryIds.has(entryId)
  );
  const activeCompareTargetId =
    input.activeCompareTargetId && focusedCandidateIds.includes(input.activeCompareTargetId)
      ? input.activeCompareTargetId
      : focusedCandidateIds[0] ?? null;
  const comparisonBaselineHistoryId =
    input.comparisonBaselineHistoryId && validBaselineHistoryIds.has(input.comparisonBaselineHistoryId)
      ? input.comparisonBaselineHistoryId
      : null;

  return {
    focusedCandidateIds,
    activeCompareTargetId,
    comparisonBaselineHistoryId,
  };
}

type BaselineHistorySortMode =
  | "newest-first"
  | "oldest-first"
  | "note-present-first"
  | "current-first";

type DecisionSnapshot = {
  candidateId: string;
  timestamp: number;
  comparisonContext: {
    focusedCandidateIds: string[];
    activeCompareTargetId: string | null;
  };
};

type ReplayModeState = {
  snapshotTimestamp: number;
  candidateId: string;
  liveContext: {
    focusedCandidateIds: string[];
    activeCompareTargetId: string | null;
    comparisonBaselineHistoryId: string | null;
  };
  replayContext: {
    focusedCandidateIds: string[];
    activeCompareTargetId: string | null;
  };
};

type ReplayLiveContext = ReplayModeState["liveContext"];
type ReplayComparisonContext = ReplayModeState["replayContext"];

type LiveMeetingCapabilityTrack = {
  meetingSource: {
    provider: "zoom" | "teams" | "google-meet" | "unknown";
    status: "placeholder-only";
  };
  tabShareIntent: {
    status: "placeholder-only";
    target: "browser-tab";
  };
  transcriptStream: {
    status: "placeholder-only";
    mode: "manual-or-future-live";
  };
  speakerSegments: {
    status: "placeholder-only";
    strategy: "future-speaker-separation";
  };
  humanAnswerOutput: {
    status: "placeholder-only";
    mode: "human-authored";
  };
};

type LiveMeetingCapabilityPlaceholderItem = {
  label: string;
  detail: string;
};

type LiveMeetingSourceSelectorOption = {
  label: string;
  value: string;
};

type LiveMeetingSourceSelectorViewModel = {
  label: string;
  helperText: string;
  selectedValue: string;
  options: LiveMeetingSourceSelectorOption[];
  isDisabled: boolean;
};

type LiveMeetingTabShareIntentPlaceholderViewModel = {
  label: string;
  helperText: string;
  actionLabel: string;
  stagedIntentValue: string;
  isDisabled: boolean;
};

type LiveMeetingOutputInteractionItem = {
  label: string;
  detail: string;
  helperText: string;
  actionLabel: string;
  isDisabled: boolean;
};

type LiveMeetingBrowserMediaCapabilityState = {
  hasMediaDevices: boolean;
  hasDisplayMedia: boolean;
  hasUserMedia: boolean;
  hasMediaRecorder: boolean;
};

type LiveMeetingCaptureReadinessViewModel = {
  title: string;
  capabilityLabel: string;
  sourceSelectionReadiness: string;
  permissionStatus: string;
  captureStatus: string;
  explanation: string;
  items: LiveMeetingCaptureReadinessItem[];
  shouldRenderCluster: boolean;
};

type LiveMeetingCaptureSessionPlaceholderViewModel = {
  title: string;
  statusLabel: string;
  statusValue: string;
  helperText: string;
  verificationTitle: string;
  verificationStateText: string;
  verificationHelperText: string;
  verificationItems: LiveMeetingRuntimeVerificationItemViewModel[];
  metadataText: string | null;
  observationText: string | null;
  audioReadinessText: string | null;
  transcriptReadinessText: string | null;
  transcriptBoundaryText: string | null;
  transcriptRuntimeText: string | null;
  transcriptRuntimeEventText: string | null;
  transcriptInputTitle: string;
  transcriptInputPlaceholder: string;
  transcriptInputActionLabel: string;
  transcriptInputHelperText: string;
  canIngestTranscriptInput: boolean;
  transcriptIngestionStateText: string;
  transcriptReviewTitle: string;
  transcriptReviewStateText: string;
  transcriptReviewEmptyText: string;
  transcriptReviewLines: LiveMeetingTranscriptReviewLineViewModel[];
  transcriptChunkSummaryText: string | null;
  transcriptChunks: LiveMeetingTranscriptRuntimeChunk[];
  answerReadinessTitle: string;
  answerReadinessStateText: string;
  answerReadinessHelperText: string;
  answerPreparationStateText: string;
  answerPreparationContextItems: LiveMeetingAnswerPreparationContextItem[];
  answerRuntimeStateText: string;
  answerRuntimeHelperText: string;
  answerPreparationLabel: string;
  answerPreparationHelperText: string;
  canPrepareAnswer: boolean;
  answerDraftTitle: string;
  answerDraftStateText: string;
  answerDraftHelperText: string;
  answerDraftReviewStateText: string;
  answerDraftReviewEmptyText: string;
  answerDraftContextItems: LiveMeetingAnswerPreparationContextItem[];
  answerDraftSurfaceTitle: string;
  answerDraftSurfaceText: string | null;
  transcriptStartTitle: string;
  transcriptStartLabel: string;
  transcriptStartHelperText: string;
  canStartTranscript: boolean;
  stopReasonText: string | null;
  actionHelperText: string;
  startActionLabel: string;
  stopActionLabel: string;
  resetActionLabel: string;
  resetActionHelperText: string;
  canStartSession: boolean;
  canStopSession: boolean;
  canResetRuntime: boolean;
};

type LiveMeetingCaptureIntentState =
  | "not-started"
  | "source-selected"
  | "blocked-by-permission-later"
  | "ready-later";

type LiveMeetingPreCaptureActionViewModel = {
  title: string;
  readinessLabel: string;
  readinessValue: string;
  helperText: string;
  actionLabel: string;
  isDisabled: boolean;
  items: LiveMeetingPreCaptureActionItem[];
  shouldRenderShell: boolean;
};

type LiveMeetingCaptureProgressionIndicatorViewModel = {
  title: string;
  intentLabel: string;
  intentValue: string;
  steps: LiveMeetingCaptureProgressionStep[];
  shouldRenderShell: boolean;
};

type LiveMeetingCaptureProgressionStep = {
  label: string;
  value: string;
};

type LiveMeetingPermissionReadinessState =
  | "not-requested"
  | "required-later"
  | "blocked-until-user-action";

type LiveMeetingPermissionRequestStatus =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "unsupported"
  | "failed";

type LiveMeetingGrantedSessionSnapshot = {
  permissionGranted: true;
  streamReceived: true;
  streamStoppedImmediately: true;
  captureRunning: false;
  streamId: string;
  videoTrackCount: number;
  audioTrackCount: number;
};

type LiveMeetingPermissionRequestState = {
  status: LiveMeetingPermissionRequestStatus;
  detail: string;
  grantedSessionSnapshot: LiveMeetingGrantedSessionSnapshot | null;
};

type LiveMeetingPermissionRuntimeDetails = {
  permissionValue: string;
  runtimeBoundaryExplanation: string;
  permissionExplanation: string;
  permissionCtaHelperText: string;
  explicitActionValue: string;
  explicitActionExplanation: string;
  explicitActionCtaHelperText: string;
  progressionActionBoundaryValue: string;
  progressionLaunchValue: string;
  progressionSessionValue: string;
  captureStatusValue: string;
  captureStatusExplanation: string;
  captureSessionStatusValue: string;
  captureSessionHelperText: string;
};

type LiveMeetingSessionRuntimeStatus =
  | "idle"
  | "granted-but-stopped"
  | "active"
  | "stopped"
  | "failed";

type LiveMeetingSessionStopReason =
  | "not-applicable"
  | "stopped-by-user"
  | "stopped-on-cleanup"
  | "track-ended"
  | "failed";

type LiveMeetingSessionMetadataSnapshot = {
  streamId: string | null;
  videoTrackCount: number;
  audioTrackCount: number;
  startedAt: number | null;
  sourceKind: "display-media" | "saved-local-transcript";
};

type LiveMeetingStreamObservationSnapshot = {
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
  videoTrackEnabled: boolean | null;
  audioTrackEnabled: boolean | null;
  videoTrackReadyState: MediaStreamTrackState | null;
  audioTrackReadyState: MediaStreamTrackState | null;
};

type LiveMeetingAudioReadinessSnapshot = {
  hasAudioTrack: boolean;
  audioTrackEnabled: boolean | null;
  audioTrackReadyState: MediaStreamTrackState | null;
  isUsableForFutureTranscriptReadiness: boolean;
};

type LiveMeetingTranscriptReadinessState =
  | "not-ready"
  | "ready-later"
  | "blocked-by-missing-audio"
  | "blocked-by-no-active-session";

type LiveMeetingTranscriptSessionStatus =
  | "idle"
  | "blocked"
  | "requested"
  | "not-implemented";

type LiveMeetingTranscriptSessionState = {
  status: LiveMeetingTranscriptSessionStatus;
  detail: string;
  hasUserTriggeredStart: boolean;
};

type LiveMeetingTranscriptRuntimeStatus =
  | "idle"
  | "requested"
  | "active"
  | "stopped"
  | "unavailable";

type LiveMeetingTranscriptIngestionStatus =
  | "idle"
  | "ingesting"
  | "empty"
  | "unavailable"
  | "stopped";

type LiveMeetingTranscriptReviewStatus =
  | "ready-to-review"
  | "ingesting"
  | "empty"
  | "unavailable"
  | "stopped";

type LiveMeetingAnswerReadinessState =
  | "not-ready"
  | "ready-later"
  | "blocked-by-no-transcript"
  | "blocked-by-no-active-session";

type LiveMeetingAnswerRuntimeStatus =
  | "idle"
  | "blocked"
  | "requested"
  | "not-implemented";

type LiveMeetingAnswerRuntimeState = {
  status: LiveMeetingAnswerRuntimeStatus;
  detail: string;
  hasUserTriggeredPrepare: boolean;
  draftBodyText: string | null;
};

type LiveMeetingAnswerPreparationState =
  | "not-ready"
  | "ready-to-prepare"
  | "requested"
  | "unavailable";

type LiveMeetingAnswerPreparationContextSnapshot = {
  hasTranscriptChunks: boolean;
  transcriptChunkCount: number;
  hasLatestTranscriptRuntimeEvent: boolean;
  hasActiveSession: boolean;
};

type LiveMeetingAnswerPreparationContextItem = {
  label: string;
  value: string;
};

type LiveMeetingAnswerDraftStatus =
  | "idle"
  | "preparing"
  | "drafted"
  | "unavailable";

type LiveMeetingAnswerDraftReviewStatus =
  | "ready-to-review"
  | "drafting"
  | "empty"
  | "unavailable"
  | "stopped";

type LiveMeetingAnswerDraftContextSnapshot = LiveMeetingAnswerPreparationContextSnapshot & {
  answerPreparationState: LiveMeetingAnswerPreparationState;
};

type LiveMeetingAnswerDraftContent = {
  title: string;
  bodyText: string | null;
  contextItems: LiveMeetingAnswerPreparationContextItem[];
  bodyLabel: string;
  bodyEmptyText: string;
};

type LiveMeetingTranscriptRuntimeEvent = {
  kind: LiveMeetingTranscriptRuntimeStatus;
  message: string;
  timestamp: number;
};

type LiveMeetingTranscriptRuntimeChunk = {
  id: string;
  timestamp: number;
  text: string;
  sourceLabel: string;
  typeLabel: string;
};

type LiveMeetingTranscriptReviewLineViewModel = {
  id: string;
  timestampText: string;
  text: string;
  sourceBadgeLabel: string;
  typeBadgeLabel: string;
};

type LiveMeetingTranscriptRuntimeState = {
  status: LiveMeetingTranscriptRuntimeStatus;
  detail: string;
  events: LiveMeetingTranscriptRuntimeEvent[];
  chunks: LiveMeetingTranscriptRuntimeChunk[];
};

type LiveMeetingSessionRuntimeState = {
  status: LiveMeetingSessionRuntimeStatus;
  detail: string;
  metadata: LiveMeetingSessionMetadataSnapshot;
  observation: LiveMeetingStreamObservationSnapshot;
  stopReason: LiveMeetingSessionStopReason;
};

type LiveMeetingSessionRuntimeDetails = {
  progressionSessionValue: string;
  captureStatusValue: string;
  captureStatusExplanation: string;
  captureSessionStatusValue: string;
  captureSessionHelperText: string;
  captureSessionVerificationTitle: string;
  captureSessionVerificationStateText: string;
  captureSessionVerificationHelperText: string;
  captureSessionVerificationItems: LiveMeetingRuntimeVerificationItemViewModel[];
  captureSessionMetadataText: string | null;
  captureSessionObservationText: string | null;
  captureSessionAudioReadinessText: string | null;
  captureSessionTranscriptReadinessText: string | null;
  captureSessionTranscriptBoundaryText: string | null;
  captureSessionTranscriptRuntimeText: string | null;
  captureSessionTranscriptRuntimeEventText: string | null;
  captureSessionTranscriptInputTitle: string;
  captureSessionTranscriptInputPlaceholder: string;
  captureSessionTranscriptInputActionLabel: string;
  captureSessionTranscriptInputHelperText: string;
  canIngestTranscriptInput: boolean;
  captureSessionTranscriptIngestionStateText: string;
  captureSessionTranscriptReviewTitle: string;
  captureSessionTranscriptReviewStateText: string;
  captureSessionTranscriptReviewEmptyText: string;
  captureSessionTranscriptReviewLines: LiveMeetingTranscriptReviewLineViewModel[];
  captureSessionTranscriptChunkSummaryText: string | null;
  captureSessionTranscriptChunks: LiveMeetingTranscriptRuntimeChunk[];
  captureSessionAnswerReadinessTitle: string;
  captureSessionAnswerReadinessStateText: string;
  captureSessionAnswerReadinessHelperText: string;
  captureSessionAnswerPreparationStateText: string;
  captureSessionAnswerPreparationContextItems: LiveMeetingAnswerPreparationContextItem[];
  captureSessionAnswerRuntimeStateText: string;
  captureSessionAnswerRuntimeHelperText: string;
  captureSessionAnswerPreparationLabel: string;
  captureSessionAnswerPreparationHelperText: string;
  canPrepareAnswer: boolean;
  captureSessionAnswerDraftTitle: string;
  captureSessionAnswerDraftStateText: string;
  captureSessionAnswerDraftHelperText: string;
  captureSessionAnswerDraftReviewStateText: string;
  captureSessionAnswerDraftReviewEmptyText: string;
  captureSessionAnswerDraftContextItems: LiveMeetingAnswerPreparationContextItem[];
  captureSessionAnswerDraftSurfaceTitle: string;
  captureSessionAnswerDraftSurfaceText: string | null;
  captureSessionTranscriptStartTitle: string;
  captureSessionTranscriptStartLabel: string;
  captureSessionTranscriptStartHelperText: string;
  canStartTranscript: boolean;
  captureSessionStopReasonText: string | null;
  captureSessionActionHelperText: string;
  captureSessionResetActionLabel: string;
  captureSessionResetActionHelperText: string;
  canStartSession: boolean;
  canStopSession: boolean;
  canResetRuntime: boolean;
};

type LiveMeetingRuntimeVerificationTarget =
  | "permission-denied-path"
  | "permission-granted-but-stopped-path"
  | "session-start-path"
  | "session-stop-path"
  | "session-reset-path"
  | "session-restart-path"
  | "transcript-ingest-path"
  | "transcript-review-path"
  | "answer-preparation-path"
  | "answer-draft-path"
  | "reset-after-answer-draft-path";

type LiveMeetingRuntimeVerificationStatus =
  | "not-run"
  | "ready-to-test"
  | "observed"
  | "warning";

type LiveMeetingRuntimeVerificationObservationState = Partial<
  Record<LiveMeetingRuntimeVerificationTarget, number>
>;

type LiveMeetingRuntimeVerificationItemViewModel = {
  key: LiveMeetingRuntimeVerificationTarget;
  label: string;
  status: LiveMeetingRuntimeVerificationStatus;
  statusLabel: string;
  detail: string;
  observedAtText: string | null;
};

type LiveMeetingPermissionReadinessViewModel = {
  title: string;
  stateLabel: string;
  stateValue: string;
  explanation: string;
  ctaLabel: string;
  ctaHelperText: string;
  isDisabled: boolean;
  shouldRenderShell: boolean;
};

type LiveMeetingExplicitActionGateState =
  | "action-required"
  | "waiting-for-user"
  | "unavailable-until-triggered";

type LiveMeetingRuntimeBoundaryTriggerState =
  | "not-yet-triggered"
  | "user-triggered-not-requesting";

type LiveMeetingExplicitActionGateViewModel = {
  title: string;
  stateLabel: string;
  stateValue: string;
  explanation: string;
  ctaLabel: string;
  ctaHelperText: string;
  isDisabled: boolean;
  shouldRenderShell: boolean;
};

type LiveMeetingPreCaptureActionItem =
  | {
      kind: "readiness";
      label: string;
      value: string;
    }
  | {
      kind: "helper-text";
      text: string;
    }
  | {
      kind: "cta";
      label: string;
      isDisabled: boolean;
    };

type LiveMeetingCaptureReadinessItem = {
  kind:
    | "browser-capability"
    | "source-selection"
    | "permission-status"
    | "capture-status";
  label: string;
  value: string;
};

type LiveMeetingStagedActivationViewModel = {
  readinessLabel: string;
  readinessValue: string;
  inactiveExplanation: string;
  ctaLabel: string;
  ctaHelperText: string;
  isDisabled: boolean;
  items: LiveMeetingStagedActivationItem[];
  shouldRenderShell: boolean;
};

type LiveMeetingStagedActivationItem = {
  kind: "readiness" | "inactive-explanation" | "cta";
  text: string;
};

type LiveMeetingOutputInteractionKind =
  | "transcript-stream"
  | "speaker-segments"
  | "human-answer-output";

type LiveMeetingOutputInteractionCopy = Omit<
  LiveMeetingOutputInteractionItem,
  "detail" | "isDisabled"
>;

type LiveMeetingInteractionScaffoldingState = {
  sourceSelectorValue: string;
  tabShareIntentValue: string;
};

type LiveMeetingCapabilityStatusDetails = {
  meetingSourceDetail: string | null;
  tabShareIntentDetail: string | null;
  transcriptStreamDetail: string | null;
  speakerSegmentsDetail: string | null;
  humanAnswerOutputDetail: string | null;
};

const LIVE_MEETING_CAPABILITY_STATUS_ORDER = [
  "Meeting Source",
  "Tab Share Intent",
  "Transcript Stream",
  "Speaker Segments",
  "Human Answer Output",
] as const satisfies readonly LiveMeetingCapabilityPlaceholderItem["label"][];

const LIVE_MEETING_OUTPUT_INTERACTION_ORDER = [
  "transcript-stream",
  "speaker-segments",
  "human-answer-output",
] as const satisfies readonly LiveMeetingOutputInteractionKind[];

const LIVE_MEETING_OUTPUT_INTERACTION_COPY_BY_KIND: Record<
  LiveMeetingOutputInteractionKind,
  LiveMeetingOutputInteractionCopy
> = {
  "transcript-stream": {
    label: "Transcript Stream Placeholder",
    helperText:
      "Planned only. No transcription stream, token flow, or live transcript ingestion is running yet.",
    actionLabel: "Stage Transcript Stream",
  },
  "speaker-segments": {
    label: "Speaker Segments Placeholder",
    helperText:
      "Planned only. No speaker separation, diarization, or segment capture is running yet.",
    actionLabel: "Stage Speaker Segments",
  },
  "human-answer-output": {
    label: "Human Answer Output Placeholder",
    helperText:
      "Planned only. No answer drafting, AI generation, or output publishing flow is running yet.",
    actionLabel: "Stage Human Answer Output",
  },
};

const LIVE_MEETING_STAGED_ACTIVATION_ORDER = [
  "readiness",
  "inactive-explanation",
  "cta",
] as const satisfies readonly LiveMeetingStagedActivationItem["kind"][];

const LIVE_MEETING_CAPTURE_READINESS_ORDER = [
  "browser-capability",
  "source-selection",
  "permission-status",
  "capture-status",
] as const satisfies readonly LiveMeetingCaptureReadinessItem["kind"][];

const LIVE_MEETING_PRE_CAPTURE_ACTION_ORDER = [
  "readiness",
  "helper-text",
  "cta",
] as const satisfies readonly LiveMeetingPreCaptureActionItem["kind"][];

function createInitialLiveMeetingPermissionRequestState(): LiveMeetingPermissionRequestState {
  return {
    status: "idle",
    detail: "Permission has not been requested in this browser yet.",
    grantedSessionSnapshot: null,
  };
}

function createInitialLiveMeetingSessionRuntimeState(): LiveMeetingSessionRuntimeState {
  return {
    status: "idle",
    detail:
      "No local browser capture session is running yet. Permission must be granted from an explicit user action before a session can start.",
    metadata: {
      streamId: null,
      videoTrackCount: 0,
      audioTrackCount: 0,
      startedAt: null,
      sourceKind: "display-media",
    },
    observation: {
      hasVideoTrack: false,
      hasAudioTrack: false,
      videoTrackEnabled: null,
      audioTrackEnabled: null,
      videoTrackReadyState: null,
      audioTrackReadyState: null,
    },
    stopReason: "not-applicable",
  };
}

function createInitialLiveMeetingTranscriptSessionState(): LiveMeetingTranscriptSessionState {
  return {
    status: "idle",
    detail: "Transcript execution has not been requested in this browser-local session yet.",
    hasUserTriggeredStart: false,
  };
}

function createInitialLiveMeetingTranscriptRuntimeState(): LiveMeetingTranscriptRuntimeState {
  return {
    status: "idle",
    detail:
      "No local transcript runtime is active yet. Start or restore a session stream to run browser-local transcript capture with OpenAI transcription.",
    events: [],
    chunks: [],
  };
}

function createInitialLiveMeetingAnswerRuntimeState(): LiveMeetingAnswerRuntimeState {
  return {
    status: "idle",
    detail: "Answer preparation has not been requested in this browser-local session yet.",
    hasUserTriggeredPrepare: false,
    draftBodyText: null,
  };
}

function describeLiveMeetingRuntimeVerificationStatus(
  status: LiveMeetingRuntimeVerificationStatus
) {
  switch (status) {
    case "ready-to-test":
      return "Ready To Test";
    case "observed":
      return "Observed";
    case "warning":
      return "Warning";
    case "not-run":
    default:
      return "Not Run";
  }
}

function formatLiveMeetingVerificationObservedAt(observedAt: number | null | undefined) {
  return observedAt ? `Observed ${new Date(observedAt).toLocaleTimeString()}` : null;
}

function createLiveMeetingRuntimeVerificationItem(input: {
  key: LiveMeetingRuntimeVerificationTarget;
  label: string;
  status: LiveMeetingRuntimeVerificationStatus;
  detail: string;
  observedAt?: number | null;
}): LiveMeetingRuntimeVerificationItemViewModel {
  return {
    key: input.key,
    label: input.label,
    status: input.status,
    statusLabel: describeLiveMeetingRuntimeVerificationStatus(input.status),
    detail: input.detail,
    observedAtText: formatLiveMeetingVerificationObservedAt(input.observedAt),
  };
}

type LiveMeetingCapabilityViewModel = LiveMeetingCapabilityStatusDetails & {
  title: string;
  narrativeIntro: string;
  narrativeCategoriesText: string;
  statusBadgeLabel: string;
  captureProgressionSectionTitle: string;
  captureReadiness: LiveMeetingCaptureReadinessViewModel;
  captureProgressionIndicator: LiveMeetingCaptureProgressionIndicatorViewModel;
  permissionReadiness: LiveMeetingPermissionReadinessViewModel;
  explicitActionGate: LiveMeetingExplicitActionGateViewModel;
  preCaptureAction: LiveMeetingPreCaptureActionViewModel;
  captureSessionPlaceholder: LiveMeetingCaptureSessionPlaceholderViewModel;
  stagedActivation: LiveMeetingStagedActivationViewModel;
  interactionSectionTitle: string;
  outputInteractionSectionTitle: string;
  sourceSelector: LiveMeetingSourceSelectorViewModel;
  tabShareIntentPlaceholder: LiveMeetingTabShareIntentPlaceholderViewModel;
  placeholderItems: LiveMeetingCapabilityPlaceholderItem[];
  outputInteractionItems: LiveMeetingOutputInteractionItem[];
  shouldRenderStatusCluster: boolean;
  shouldRenderOutputInteractionCluster: boolean;
};

export const LIVE_MEETING_CAPABILITY_TRACK: LiveMeetingCapabilityTrack = {
  meetingSource: {
    provider: "unknown",
    status: "placeholder-only",
  },
  tabShareIntent: {
    status: "placeholder-only",
    target: "browser-tab",
  },
  transcriptStream: {
    status: "placeholder-only",
    mode: "manual-or-future-live",
  },
  speakerSegments: {
    status: "placeholder-only",
    strategy: "future-speaker-separation",
  },
  humanAnswerOutput: {
    status: "placeholder-only",
    mode: "human-authored",
  },
};

function createLiveMeetingCapabilityPlaceholderItems(
  statusDetails: LiveMeetingCapabilityStatusDetails
): LiveMeetingCapabilityPlaceholderItem[] {
  const detailByLabel: Record<
    LiveMeetingCapabilityPlaceholderItem["label"],
    string | null
  > = {
    "Meeting Source": statusDetails.meetingSourceDetail,
    "Tab Share Intent": statusDetails.tabShareIntentDetail,
    "Transcript Stream": statusDetails.transcriptStreamDetail,
    "Speaker Segments": statusDetails.speakerSegmentsDetail,
    "Human Answer Output": statusDetails.humanAnswerOutputDetail,
  };

  return LIVE_MEETING_CAPABILITY_STATUS_ORDER.flatMap((label) => {
    const detail = detailByLabel[label];

    return detail
      ? [
          {
            label,
            detail,
          },
        ]
      : [];
  });
}

function normalizeLiveMeetingCapabilityPlaceholderDetail(detail: string | null | undefined) {
  const normalizedDetail = detail?.trim();

  if (!normalizedDetail || normalizedDetail.toLowerCase() === "invalid") {
    return null;
  }

  return normalizedDetail;
}

function createLiveMeetingStagedActivationItems(
  stagedActivation: Omit<LiveMeetingStagedActivationViewModel, "items" | "shouldRenderShell">
): LiveMeetingStagedActivationItem[] {
  const textByKind: Record<LiveMeetingStagedActivationItem["kind"], string | null> = {
    readiness: normalizeLiveMeetingCapabilityPlaceholderDetail(
      `${stagedActivation.readinessLabel}: ${stagedActivation.readinessValue}`
    ),
    "inactive-explanation": normalizeLiveMeetingCapabilityPlaceholderDetail(
      stagedActivation.inactiveExplanation
    ),
    cta: normalizeLiveMeetingCapabilityPlaceholderDetail(
      `${stagedActivation.ctaLabel}: ${stagedActivation.ctaHelperText}`
    ),
  };

  return LIVE_MEETING_STAGED_ACTIVATION_ORDER.flatMap((kind) => {
    const text = textByKind[kind];

    return text ? [{ kind, text }] : [];
  });
}

function createLiveMeetingOutputInteractionItems(
  statusDetails: LiveMeetingCapabilityStatusDetails
): LiveMeetingOutputInteractionItem[] {
  const detailByKind: Record<LiveMeetingOutputInteractionKind, string | null> = {
    "transcript-stream": statusDetails.transcriptStreamDetail,
    "speaker-segments": statusDetails.speakerSegmentsDetail,
    "human-answer-output": statusDetails.humanAnswerOutputDetail,
  };

  return LIVE_MEETING_OUTPUT_INTERACTION_ORDER.flatMap((kind) => {
    return createLiveMeetingOutputInteractionItem(kind, detailByKind[kind]);
  });
}

function createLiveMeetingOutputInteractionItem(
  kind: LiveMeetingOutputInteractionKind,
  detail: string | null
): LiveMeetingOutputInteractionItem[] {
  return detail
    ? [
        {
          ...LIVE_MEETING_OUTPUT_INTERACTION_COPY_BY_KIND[kind],
          detail,
          isDisabled: true,
        },
      ]
    : [];
}

function createLiveMeetingCaptureReadinessItems(
  captureReadiness: Omit<LiveMeetingCaptureReadinessViewModel, "items" | "shouldRenderCluster">
): LiveMeetingCaptureReadinessItem[] {
  const valueByKind: Record<LiveMeetingCaptureReadinessItem["kind"], string | null> = {
    "browser-capability": normalizeLiveMeetingCapabilityPlaceholderDetail(
      captureReadiness.capabilityLabel
    ),
    "source-selection": normalizeLiveMeetingCapabilityPlaceholderDetail(
      captureReadiness.sourceSelectionReadiness
    ),
    "permission-status": normalizeLiveMeetingCapabilityPlaceholderDetail(
      captureReadiness.permissionStatus
    ),
    "capture-status": normalizeLiveMeetingCapabilityPlaceholderDetail(
      captureReadiness.captureStatus
    ),
  };
  const labelByKind: Record<LiveMeetingCaptureReadinessItem["kind"], string> = {
    "browser-capability": "Browser Capability",
    "source-selection": "Source Readiness",
    "permission-status": "Permissions",
    "capture-status": "Capture State",
  };

  return LIVE_MEETING_CAPTURE_READINESS_ORDER.flatMap((kind) => {
    const value = valueByKind[kind];

    return value
      ? [
          {
            kind,
            label: labelByKind[kind],
            value,
          },
        ]
      : [];
  });
}

function createLiveMeetingPreCaptureActionItems(
  preCaptureAction: Omit<
    LiveMeetingPreCaptureActionViewModel,
    "items" | "shouldRenderShell"
  >
): LiveMeetingPreCaptureActionItem[] {
  const items: LiveMeetingPreCaptureActionItem[] = [];

  for (const kind of LIVE_MEETING_PRE_CAPTURE_ACTION_ORDER) {
    if (kind === "readiness") {
      const label = normalizeLiveMeetingCapabilityPlaceholderDetail(
        preCaptureAction.readinessLabel
      );
      const value = normalizeLiveMeetingCapabilityPlaceholderDetail(
        preCaptureAction.readinessValue
      );

      if (label && value) {
        items.push({ kind, label, value });
      }

      continue;
    }

    if (kind === "helper-text") {
      const text = normalizeLiveMeetingCapabilityPlaceholderDetail(preCaptureAction.helperText);

      if (text) {
        items.push({ kind, text });
      }

      continue;
    }

    const label = normalizeLiveMeetingCapabilityPlaceholderDetail(preCaptureAction.actionLabel);

    if (label) {
      items.push({
        kind,
        label,
        isDisabled: preCaptureAction.isDisabled,
      });
    }
  }

  return items;
}

function describeLiveMeetingCaptureIntentState(
  captureIntentState: LiveMeetingCaptureIntentState
) {
  switch (captureIntentState) {
    case "source-selected":
      return "Source Selected / Waiting";
    case "blocked-by-permission-later":
      return "Blocked By Permissions Later";
    case "ready-later":
      return "Ready Later";
    case "not-started":
    default:
      return "Not Started";
  }
}

function describeLiveMeetingPermissionReadinessState(
  permissionReadinessState: LiveMeetingPermissionReadinessState
) {
  switch (permissionReadinessState) {
    case "blocked-until-user-action":
      return "Blocked Until User Action";
    case "required-later":
      return "Required Later";
    case "not-requested":
    default:
      return "Not Requested";
  }
}

function describeLiveMeetingPermissionRequestStatus(
  permissionRequestStatus: LiveMeetingPermissionRequestStatus
) {
  switch (permissionRequestStatus) {
    case "requesting":
      return "Requesting";
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "unsupported":
      return "Unsupported";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Not Requested";
  }
}

function describeLiveMeetingExplicitActionGateState(
  explicitActionGateState: LiveMeetingExplicitActionGateState
) {
  switch (explicitActionGateState) {
    case "waiting-for-user":
      return "Waiting For User";
    case "unavailable-until-triggered":
      return "Unavailable Until Triggered";
    case "action-required":
    default:
      return "Action Required";
  }
}

function describeLiveMeetingRuntimeBoundaryTriggerState(
  runtimeBoundaryTriggerState: LiveMeetingRuntimeBoundaryTriggerState
) {
  switch (runtimeBoundaryTriggerState) {
    case "user-triggered-not-requesting":
      return "User Triggered / Not Requesting Yet";
    case "not-yet-triggered":
    default:
      return "Not Yet Triggered";
  }
}

function createLiveMeetingGrantedSessionSnapshot(
  permissionStream: MediaStream
): LiveMeetingGrantedSessionSnapshot {
  return {
    permissionGranted: true,
    streamReceived: true,
    streamStoppedImmediately: true,
    captureRunning: false,
    streamId: permissionStream.id,
    videoTrackCount: permissionStream.getVideoTracks().length,
    audioTrackCount: permissionStream.getAudioTracks().length,
  };
}

function formatLiveMeetingGrantedSessionTrackSummary(
  grantedSessionSnapshot: LiveMeetingGrantedSessionSnapshot
) {
  return [
    `${grantedSessionSnapshot.videoTrackCount} video track${
      grantedSessionSnapshot.videoTrackCount === 1 ? "" : "s"
    }`,
    `${grantedSessionSnapshot.audioTrackCount} audio track${
      grantedSessionSnapshot.audioTrackCount === 1 ? "" : "s"
    }`,
  ].join(", ");
}

function formatLiveMeetingSessionTrackSummary(input: {
  videoTrackCount: number;
  audioTrackCount: number;
}) {
  return [
    `${input.videoTrackCount} video track${input.videoTrackCount === 1 ? "" : "s"}`,
    `${input.audioTrackCount} audio track${input.audioTrackCount === 1 ? "" : "s"}`,
  ].join(", ");
}

function formatLiveMeetingSessionMetadataSummary(
  metadata: LiveMeetingSessionMetadataSnapshot
) {
  if (metadata.streamId === null) {
    return null;
  }

  const summaryParts = [
    `Stream ${metadata.streamId}`,
    formatLiveMeetingSessionTrackSummary(metadata),
    `Source ${metadata.sourceKind}`,
  ];

  if (metadata.startedAt !== null) {
    summaryParts.push(`Started ${new Date(metadata.startedAt).toLocaleTimeString()}`);
  }

  return summaryParts.join(" • ");
}

function createLiveMeetingStreamObservationSnapshot(
  stream: MediaStream
): LiveMeetingStreamObservationSnapshot {
  const videoTrack = stream.getVideoTracks()[0] ?? null;
  const audioTrack = stream.getAudioTracks()[0] ?? null;

  return {
    hasVideoTrack: videoTrack !== null,
    hasAudioTrack: audioTrack !== null,
    videoTrackEnabled: videoTrack ? videoTrack.enabled : null,
    audioTrackEnabled: audioTrack ? audioTrack.enabled : null,
    videoTrackReadyState: videoTrack ? videoTrack.readyState : null,
    audioTrackReadyState: audioTrack ? audioTrack.readyState : null,
  };
}

function formatLiveMeetingStreamObservationSummary(
  observation: LiveMeetingStreamObservationSnapshot
) {
  const observationParts: string[] = [];

  if (observation.hasVideoTrack) {
    observationParts.push(
      `Video track ${observation.videoTrackEnabled ? "enabled" : "disabled"} / ${
        observation.videoTrackReadyState ?? "unknown"
      }`
    );
  } else {
    observationParts.push("Video track absent");
  }

  if (observation.hasAudioTrack) {
    observationParts.push(
      `Audio track ${observation.audioTrackEnabled ? "enabled" : "disabled"} / ${
        observation.audioTrackReadyState ?? "unknown"
      }`
    );
  } else {
    observationParts.push("Audio track absent");
  }

  return observationParts.join(" • ");
}

function describeTranscriptSourceLabel(source: TranscriptSource | null) {
  if (source === "system-audio") {
    return "System Audio";
  }

  if (source === "microphone") {
    return "Microphone";
  }

  return "Saved Local Transcript";
}

function createRestoredTranscriptTypeLabel(record: TranscriptRecord) {
  return record.captureMode === "file-upload"
    ? "Saved Upload Segment"
    : "Saved Runtime Chunk";
}

function mapSavedTranscriptToRuntimeChunks(
  record: TranscriptRecord
): LiveMeetingTranscriptRuntimeChunk[] {
  const typeLabel = createRestoredTranscriptTypeLabel(record);

  return [...record.segments]
    .sort((left, right) => {
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }

      return right.chunkIndex - left.chunkIndex;
    })
    .map((segment) => ({
      id: segment.id,
      timestamp: segment.createdAt,
      text: segment.text,
      sourceLabel: describeTranscriptSourceLabel(segment.source),
      typeLabel,
    }));
}

function mapWorkflowTranscriptSegmentsToRuntimeChunks(input: {
  segments: WorkflowTranscriptSegment[];
  activeTranscriptRecord: TranscriptRecord | null;
}): LiveMeetingTranscriptRuntimeChunk[] {
  const typeLabel =
    input.activeTranscriptRecord?.captureMode === "file-upload"
      ? "Saved Upload Segment"
      : "Local Transcript Segment";

  return [...input.segments]
    .sort((left, right) => {
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }

      return right.chunkIndex - left.chunkIndex;
    })
    .map((segment) => ({
      id: segment.id,
      timestamp: segment.createdAt,
      text: segment.text,
      sourceLabel:
        segment.id === "demo-segment-question"
          ? "Incoming Question"
          : segment.id === "demo-segment-context"
            ? "Response Context"
            : describeTranscriptSourceLabel(segment.source),
      typeLabel:
        segment.id === "demo-segment-question"
          ? "Demo Incoming"
          : segment.id === "demo-segment-context"
            ? "Demo Review"
            : typeLabel,
    }));
}

function createWorkspaceSessionRuntimeStateFromTranscription(input: {
  status: import("@/features/transcription/use-transcription-workflow").TranscriptionStatus;
  transcriptText: string;
  runtimeChunks: LiveMeetingTranscriptRuntimeChunk[];
  activeTranscriptRecord: TranscriptRecord | null;
}): LiveMeetingSessionRuntimeState {
  const hasTranscriptContext = input.transcriptText.trim().length > 0 || input.runtimeChunks.length > 0;
  const isCaptureRunning =
    input.status === "connecting" ||
    input.status === "listening" ||
    input.status === "receiving-transcript" ||
    input.status === "no-speech-yet";

  if (isCaptureRunning || hasTranscriptContext) {
    return {
      status: "active",
      detail: isCaptureRunning
        ? "The browser-local transcript runtime is actively capturing or processing audio in this workspace shell. Live transcription requests run through the secure OpenAI server route."
        : "Saved or staged browser-local transcript context is active in this workspace shell. No answer-generation runtime or hidden orchestration is running.",
      metadata: {
        streamId: input.activeTranscriptRecord?.id ?? "browser-local-transcript-runtime",
        videoTrackCount: 0,
        audioTrackCount: 0,
        startedAt: input.activeTranscriptRecord?.updatedAt ?? null,
        sourceKind: "saved-local-transcript",
      },
      observation: {
        hasVideoTrack: false,
        hasAudioTrack: false,
        videoTrackEnabled: null,
        audioTrackEnabled: null,
        videoTrackReadyState: null,
        audioTrackReadyState: null,
      },
      stopReason: "not-applicable",
    };
  }

  if (input.status === "stopped") {
    return {
      ...createInitialLiveMeetingSessionRuntimeState(),
      status: "stopped",
      detail:
        "The browser-local transcript runtime was stopped explicitly in this workspace shell. No answer-generation or hidden orchestration is active.",
      stopReason: "stopped-by-user",
    };
  }

  return createInitialLiveMeetingSessionRuntimeState();
}

function createWorkspaceTranscriptSessionStateFromTranscription(input: {
  status: import("@/features/transcription/use-transcription-workflow").TranscriptionStatus;
  runtimeChunks: LiveMeetingTranscriptRuntimeChunk[];
  transcriptText: string;
}): LiveMeetingTranscriptSessionState {
  const hasTranscriptContext = input.transcriptText.trim().length > 0 || input.runtimeChunks.length > 0;

  if (
    hasTranscriptContext ||
    input.status === "connecting" ||
    input.status === "listening" ||
    input.status === "receiving-transcript" ||
    input.status === "no-speech-yet"
  ) {
    return {
      status: "requested",
      detail:
        "The shared browser-local transcript runtime is active in this workspace shell through explicit local capture, upload, or saved-transcript open actions.",
      hasUserTriggeredStart: true,
    };
  }

  return createInitialLiveMeetingTranscriptSessionState();
}

function createWorkspaceTranscriptRuntimeStateFromTranscription(input: {
  status: import("@/features/transcription/use-transcription-workflow").TranscriptionStatus;
  transcriptText: string;
  runtimeChunks: LiveMeetingTranscriptRuntimeChunk[];
  activeTranscriptRecord: TranscriptRecord | null;
}): LiveMeetingTranscriptRuntimeState {
  const eventTimestamp =
    input.runtimeChunks[0]?.timestamp ?? input.activeTranscriptRecord?.updatedAt ?? null;

  if (input.runtimeChunks.length > 0) {
    return {
      status: input.status === "stopped" ? "stopped" : "active",
      detail:
        "The workspace transcript lane is backed directly by the shared browser-local transcription runtime with OpenAI transcription. Only saved or captured local transcript content is shown here.",
      events: eventTimestamp
        ? [
            {
              kind: input.status === "stopped" ? "stopped" : "active",
              message:
                input.status === "stopped"
                  ? "The local transcript runtime was stopped after staging browser-local transcript content."
                  : "Browser-local transcript content is flowing through the shared workspace transcript lane.",
              timestamp: eventTimestamp,
            },
          ]
        : [],
      chunks: input.runtimeChunks,
    };
  }

  if (
    input.status === "connecting" ||
    input.status === "listening" ||
    input.status === "receiving-transcript" ||
    input.status === "no-speech-yet"
  ) {
    return {
      status: "requested",
      detail:
        "A browser-local transcript runtime is active in this workspace shell, but no reviewable local chunks are available yet.",
      events: [],
      chunks: [],
    };
  }

  if (input.status === "stopped") {
    return {
      status: "stopped",
      detail:
        "The browser-local transcript runtime stopped in this workspace shell. No local transcript chunks remain active in the review lane.",
      events: [],
      chunks: [],
    };
  }

  return createInitialLiveMeetingTranscriptRuntimeState();
}

function createRestoredLiveMeetingSessionRuntimeState(
  record: TranscriptRecord,
  restoredAt: number
): LiveMeetingSessionRuntimeState {
  return {
    status: "active",
    detail:
      "A saved browser-local transcript was restored into the workspace review lane. No live browser capture session or answer-generation orchestration was started.",
    metadata: {
      streamId: record.id,
      videoTrackCount: 0,
      audioTrackCount: 0,
      startedAt: restoredAt,
      sourceKind: "saved-local-transcript",
    },
    observation: {
      hasVideoTrack: false,
      hasAudioTrack: false,
      videoTrackEnabled: null,
      audioTrackEnabled: null,
      videoTrackReadyState: null,
      audioTrackReadyState: null,
    },
    stopReason: "not-applicable",
  };
}

function createRestoredLiveMeetingTranscriptSessionState(): LiveMeetingTranscriptSessionState {
  return {
    status: "requested",
    detail:
      "Transcript review was restored from saved browser-local transcript data. No transcript execution was started.",
    hasUserTriggeredStart: true,
  };
}

function createRestoredLiveMeetingTranscriptRuntimeState(
  restoredAt: number,
  runtimeChunks: LiveMeetingTranscriptRuntimeChunk[]
): LiveMeetingTranscriptRuntimeState {
  return {
    status: runtimeChunks.length > 0 ? "active" : "requested",
    detail:
      runtimeChunks.length > 0
        ? "Saved browser-local transcript content was restored into the transcript runtime lane using only persisted local chunks. No data was regenerated."
        : "A saved browser-local transcript was restored, but no persisted transcript chunks were available to stage into the runtime lane.",
    events: [
      {
        kind: runtimeChunks.length > 0 ? "active" : "requested",
        message:
          runtimeChunks.length > 0
            ? `Restored ${runtimeChunks.length} saved local transcript chunk${
                runtimeChunks.length === 1 ? "" : "s"
              } into the workspace runtime lane.`
            : "Restored saved local transcript metadata into the workspace runtime lane.",
        timestamp: restoredAt,
      },
    ],
    chunks: runtimeChunks,
  };
}

function createLiveMeetingAudioReadinessSnapshot(
  observation: LiveMeetingStreamObservationSnapshot
): LiveMeetingAudioReadinessSnapshot {
  const isUsableForFutureTranscriptReadiness =
    observation.hasAudioTrack &&
    observation.audioTrackEnabled === true &&
    observation.audioTrackReadyState === "live";

  return {
    hasAudioTrack: observation.hasAudioTrack,
    audioTrackEnabled: observation.audioTrackEnabled,
    audioTrackReadyState: observation.audioTrackReadyState,
    isUsableForFutureTranscriptReadiness,
  };
}

function formatLiveMeetingAudioReadinessSummary(
  audioReadiness: LiveMeetingAudioReadinessSnapshot
) {
  if (!audioReadiness.hasAudioTrack) {
    return "Audio Readiness: No audio track is present, so future transcript readiness is unavailable in this local session.";
  }

  if (audioReadiness.isUsableForFutureTranscriptReadiness) {
    return "Audio Readiness: Audio track is present, enabled, and live, so the session appears locally usable for future transcript readiness. No transcript generation is active.";
  }

  if (audioReadiness.audioTrackReadyState === "ended") {
    return "Audio Readiness: Audio track is present but ended, so future transcript readiness is unavailable in this local session.";
  }

  if (audioReadiness.audioTrackEnabled === false) {
    return "Audio Readiness: Audio track is present but disabled, so future transcript readiness is unavailable in this local session.";
  }

  return "Audio Readiness: Audio track state is limited locally, so future transcript readiness is not currently available in this session.";
}

function createLiveMeetingTranscriptReadinessState(input: {
  sessionRuntimeState: LiveMeetingSessionRuntimeState;
  audioReadiness: LiveMeetingAudioReadinessSnapshot;
}): LiveMeetingTranscriptReadinessState {
  const { sessionRuntimeState, audioReadiness } = input;

  if (sessionRuntimeState.status !== "active") {
    return "blocked-by-no-active-session";
  }

  if (!audioReadiness.hasAudioTrack || audioReadiness.audioTrackReadyState === "ended") {
    return "blocked-by-missing-audio";
  }

  if (audioReadiness.isUsableForFutureTranscriptReadiness) {
    return "ready-later";
  }

  return "not-ready";
}

function formatLiveMeetingTranscriptReadinessSummary(
  transcriptReadinessState: LiveMeetingTranscriptReadinessState
) {
  switch (transcriptReadinessState) {
    case "ready-later":
      return "Transcript Readiness: This active local session appears positioned for future transcript work because usable live audio is present. No transcript generation is active.";
    case "blocked-by-missing-audio":
      return "Transcript Readiness: Future transcript work is blocked because usable audio is not currently present in this local session.";
    case "blocked-by-no-active-session":
      return "Transcript Readiness: Future transcript work is blocked because there is no active local session running.";
    case "not-ready":
    default:
      return "Transcript Readiness: Future transcript work is not ready yet because the current local audio state is limited. No transcript generation is active.";
  }
}

function formatLiveMeetingTranscriptStartHelperText(
  transcriptReadinessState: LiveMeetingTranscriptReadinessState
) {
  switch (transcriptReadinessState) {
    case "ready-later":
      return "Transcript can start from this point. When triggered, the active stream is attached to the live transcription runtime.";
    case "blocked-by-missing-audio":
      return "This disabled control remains blocked because the session does not currently expose usable audio for future transcript work.";
    case "blocked-by-no-active-session":
      return "This disabled control remains blocked because no active local session is running yet.";
    case "not-ready":
    default:
      return "This disabled control remains blocked because the current local session is not yet ready for future transcript work.";
  }
}

function createLiveMeetingTranscriptSessionStateDetails(input: {
  transcriptReadinessState: LiveMeetingTranscriptReadinessState;
  transcriptSessionState: LiveMeetingTranscriptSessionState;
}) {
  const { transcriptReadinessState, transcriptSessionState } = input;

  if (transcriptSessionState.status === "requested") {
    return {
      boundaryText:
        "Transcript Boundary: A local transcript-start request was explicitly triggered and the runtime is connecting to active stream input.",
      startLabel: "Transcript Requested Locally",
      startHelperText:
        "Your click was recorded locally and live transcription start has been requested. No downstream answer generation is running.",
      canStartTranscript: false,
    };
  }

  if (transcriptSessionState.status === "not-implemented") {
    return {
      boundaryText:
        "Transcript Boundary: Transcript start intent was recorded locally, but the runtime did not activate.",
      startLabel: "Transcript Unavailable",
      startHelperText:
        "Transcript readiness may exist, but the runtime is still inactive in this session.",
      canStartTranscript: false,
    };
  }

  if (transcriptSessionState.status === "blocked") {
    return {
      boundaryText: `Transcript Boundary: ${transcriptSessionState.detail}`,
      startLabel: "Start Transcript Placeholder",
      startHelperText: transcriptSessionState.detail,
      canStartTranscript: false,
    };
  }

  return {
    boundaryText:
      transcriptReadinessState === "ready-later"
        ? "Transcript Boundary: Transcript readiness exists locally and an explicit user trigger can start runtime capture."
        : "Transcript Boundary: Transcript execution is not active and remains blocked by current local readiness conditions.",
    startLabel: "Start Transcript Placeholder",
    startHelperText: formatLiveMeetingTranscriptStartHelperText(transcriptReadinessState),
    canStartTranscript: transcriptReadinessState === "ready-later",
  };
}

function describeLiveMeetingTranscriptRuntimeStatus(
  transcriptRuntimeStatus: LiveMeetingTranscriptRuntimeStatus
) {
  switch (transcriptRuntimeStatus) {
    case "requested":
      return "Requested";
    case "active":
      return "Active";
    case "stopped":
      return "Stopped";
    case "unavailable":
      return "Unavailable";
    case "idle":
    default:
      return "Idle";
  }
}

function formatLiveMeetingTranscriptChunkSummary(
  transcriptChunks: LiveMeetingTranscriptRuntimeChunk[]
) {
  if (transcriptChunks.length === 0) {
    return null;
  }

  const latestChunk = transcriptChunks[0];

  return `${transcriptChunks.length} local transcript runtime input chunk${
    transcriptChunks.length === 1 ? "" : "s"
  } staged. Latest ${latestChunk.typeLabel.toLowerCase()} received at ${new Date(
    latestChunk.timestamp
  ).toLocaleTimeString()}.`;
}

function orderLiveMeetingTranscriptRuntimeEvents(
  transcriptEvents: LiveMeetingTranscriptRuntimeEvent[]
) {
  return [...transcriptEvents].sort((left, right) => {
    if (right.timestamp !== left.timestamp) {
      return right.timestamp - left.timestamp;
    }

    return left.message.localeCompare(right.message);
  });
}

function orderLiveMeetingTranscriptRuntimeChunks(
  transcriptChunks: LiveMeetingTranscriptRuntimeChunk[]
) {
  return [...transcriptChunks].sort((left, right) => {
    if (right.timestamp !== left.timestamp) {
      return right.timestamp - left.timestamp;
    }

    return left.id.localeCompare(right.id);
  });
}

function createLiveMeetingTranscriptReviewLines(
  transcriptChunks: LiveMeetingTranscriptRuntimeChunk[]
): LiveMeetingTranscriptReviewLineViewModel[] {
  return transcriptChunks.map((chunk) => ({
    id: chunk.id,
    timestampText: new Date(chunk.timestamp).toLocaleTimeString(),
    text: chunk.text,
    sourceBadgeLabel: chunk.sourceLabel,
    typeBadgeLabel: chunk.typeLabel,
  }));
}

function createLiveMeetingTranscriptIngestionStatus(
  transcriptRuntimeState: LiveMeetingTranscriptRuntimeState
): LiveMeetingTranscriptIngestionStatus {
  if (transcriptRuntimeState.status === "unavailable") {
    return "unavailable";
  }

  if (transcriptRuntimeState.status === "stopped") {
    return "stopped";
  }

  if (transcriptRuntimeState.status === "active") {
    return "ingesting";
  }

  if (transcriptRuntimeState.status === "requested") {
    return transcriptRuntimeState.chunks.length > 0 ? "ingesting" : "empty";
  }

  return "idle";
}

function describeLiveMeetingTranscriptIngestionStatus(
  transcriptIngestionStatus: LiveMeetingTranscriptIngestionStatus
) {
  switch (transcriptIngestionStatus) {
    case "ingesting":
      return "Ingesting Locally";
    case "empty":
      return "Ready For Local Input";
    case "unavailable":
      return "Unavailable";
    case "stopped":
      return "Stopped";
    case "idle":
    default:
      return "Idle";
  }
}

function createLiveMeetingTranscriptReviewStatus(input: {
  transcriptIngestionStatus: LiveMeetingTranscriptIngestionStatus;
  transcriptReviewLines: LiveMeetingTranscriptReviewLineViewModel[];
}): LiveMeetingTranscriptReviewStatus {
  const { transcriptIngestionStatus, transcriptReviewLines } = input;

  if (transcriptIngestionStatus === "unavailable") {
    return "unavailable";
  }

  if (transcriptIngestionStatus === "stopped") {
    return "stopped";
  }

  if (transcriptReviewLines.length > 0) {
    return transcriptIngestionStatus === "ingesting" ? "ingesting" : "ready-to-review";
  }

  return transcriptIngestionStatus === "empty" ? "empty" : "ready-to-review";
}

function describeLiveMeetingTranscriptReviewStatus(
  transcriptReviewStatus: LiveMeetingTranscriptReviewStatus
) {
  switch (transcriptReviewStatus) {
    case "ingesting":
      return "Ingesting";
    case "empty":
      return "Empty";
    case "unavailable":
      return "Unavailable";
    case "stopped":
      return "Stopped";
    case "ready-to-review":
    default:
      return "Ready To Review";
  }
}

function createLiveMeetingAnswerReadinessState(input: {
  sessionRuntimeState: LiveMeetingSessionRuntimeState;
  transcriptReviewStatus: LiveMeetingTranscriptReviewStatus;
  transcriptReviewLines: LiveMeetingTranscriptReviewLineViewModel[];
}): LiveMeetingAnswerReadinessState {
  const { sessionRuntimeState, transcriptReviewStatus, transcriptReviewLines } = input;

  if (sessionRuntimeState.status !== "active") {
    return "blocked-by-no-active-session";
  }

  if (
    transcriptReviewStatus === "unavailable" ||
    transcriptReviewStatus === "empty" ||
    transcriptReviewLines.length === 0
  ) {
    return "blocked-by-no-transcript";
  }

  if (
    transcriptReviewStatus === "ingesting" ||
    transcriptReviewStatus === "ready-to-review"
  ) {
    return "ready-later";
  }

  return "not-ready";
}

function describeLiveMeetingAnswerReadinessState(
  answerReadinessState: LiveMeetingAnswerReadinessState
) {
  switch (answerReadinessState) {
    case "ready-later":
      return "Ready Later";
    case "blocked-by-no-transcript":
      return "Blocked By No Transcript";
    case "blocked-by-no-active-session":
      return "Blocked By No Active Session";
    case "not-ready":
    default:
      return "Not Ready";
  }
}

function describeLiveMeetingAnswerRuntimeStatus(
  answerRuntimeStatus: LiveMeetingAnswerRuntimeStatus
) {
  switch (answerRuntimeStatus) {
    case "blocked":
      return "Blocked";
    case "requested":
      return "Requested";
    case "not-implemented":
      return "Not Implemented";
    case "idle":
    default:
      return "Idle";
  }
}

function createLiveMeetingAnswerRuntimeDetails(input: {
  answerReadinessState: LiveMeetingAnswerReadinessState;
  answerRuntimeState: LiveMeetingAnswerRuntimeState;
}) {
  const { answerReadinessState, answerRuntimeState } = input;
  const runtimeStatusLabel = describeLiveMeetingAnswerRuntimeStatus(
    answerRuntimeState.status
  );

  if (answerRuntimeState.status === "requested") {
    return {
      runtimeStateText: `Answer Runtime: ${runtimeStatusLabel}. User-triggered answer preparation intent is recorded locally.`,
      runtimeHelperText:
        answerReadinessState === "ready-later"
          ? "Answer preparation was explicitly requested from the local transcript/runtime context, but answer execution is not implemented or active in this browser shell."
          : "Answer preparation was explicitly requested locally, but the current browser-local session no longer meets the readiness conditions needed for future answer work.",
    };
  }

  if (answerRuntimeState.status === "blocked") {
    return {
      runtimeStateText: `Answer Runtime: ${runtimeStatusLabel}.`,
      runtimeHelperText: answerRuntimeState.detail,
    };
  }

  if (answerRuntimeState.status === "not-implemented") {
    return {
      runtimeStateText: `Answer Runtime: ${runtimeStatusLabel}.`,
      runtimeHelperText:
        "Answer preparation remains browser-local and not implemented here yet. No answer generation, summarization, or backend work is active.",
    };
  }

  return {
    runtimeStateText: `Answer Runtime: ${runtimeStatusLabel}.`,
    runtimeHelperText:
      answerReadinessState === "ready-later"
        ? "Answer preparation can be triggered explicitly from this browser-local shell, but answer execution is still not implemented."
        : "Answer preparation has not been triggered in this browser-local session yet.",
  };
}

function createLiveMeetingAnswerPreparationContextSnapshot(input: {
  sessionRuntimeState: LiveMeetingSessionRuntimeState;
  transcriptRuntimeDetails: ReturnType<typeof createLiveMeetingTranscriptRuntimeDetails>;
}): LiveMeetingAnswerPreparationContextSnapshot {
  const { sessionRuntimeState, transcriptRuntimeDetails } = input;

  return {
    hasTranscriptChunks: transcriptRuntimeDetails.transcriptReviewLines.length > 0,
    transcriptChunkCount: transcriptRuntimeDetails.transcriptReviewLines.length,
    hasLatestTranscriptRuntimeEvent: transcriptRuntimeDetails.runtimeEventText !== null,
    hasActiveSession: sessionRuntimeState.status === "active",
  };
}

function createLiveMeetingAnswerPreparationState(input: {
  answerReadinessState: LiveMeetingAnswerReadinessState;
  answerRuntimeState: LiveMeetingAnswerRuntimeState;
  contextSnapshot: LiveMeetingAnswerPreparationContextSnapshot;
}): LiveMeetingAnswerPreparationState {
  const { answerReadinessState, answerRuntimeState, contextSnapshot } = input;

  if (answerRuntimeState.status === "requested") {
    return "requested";
  }

  if (!contextSnapshot.hasActiveSession) {
    return "unavailable";
  }

  if (answerReadinessState === "ready-later" && contextSnapshot.hasTranscriptChunks) {
    return "ready-to-prepare";
  }

  return "not-ready";
}

function describeLiveMeetingAnswerPreparationState(
  answerPreparationState: LiveMeetingAnswerPreparationState
) {
  switch (answerPreparationState) {
    case "ready-to-prepare":
      return "Ready To Prepare";
    case "requested":
      return "Requested";
    case "unavailable":
      return "Unavailable";
    case "not-ready":
    default:
      return "Not Ready";
  }
}

function createLiveMeetingAnswerPreparationContextItems(
  contextSnapshot: LiveMeetingAnswerPreparationContextSnapshot
): LiveMeetingAnswerPreparationContextItem[] {
  return [
    {
      label: "Active Session",
      value: contextSnapshot.hasActiveSession ? "Available" : "Unavailable",
    },
    {
      label: "Transcript Chunks",
      value: contextSnapshot.hasTranscriptChunks
        ? `${contextSnapshot.transcriptChunkCount} available`
        : "None available",
    },
    {
      label: "Latest Runtime Event",
      value: contextSnapshot.hasLatestTranscriptRuntimeEvent ? "Present" : "Not present",
    },
    {
      label: "Preparation Context",
      value:
        contextSnapshot.hasActiveSession && contextSnapshot.hasTranscriptChunks
          ? "Sufficient for future answer preparation"
          : "Not yet sufficient",
    },
  ];
}

function createLiveMeetingAnswerDraftContextSnapshot(input: {
  preparationContextSnapshot: LiveMeetingAnswerPreparationContextSnapshot;
  answerPreparationState: LiveMeetingAnswerPreparationState;
}): LiveMeetingAnswerDraftContextSnapshot {
  const { preparationContextSnapshot, answerPreparationState } = input;

  return {
    ...preparationContextSnapshot,
    answerPreparationState,
  };
}

function createLiveMeetingAnswerDraftContent(input: {
  answerDraftStatus: LiveMeetingAnswerDraftStatus;
  answerDraftContextSnapshot: LiveMeetingAnswerDraftContextSnapshot;
  draftBodyText: string | null;
}): LiveMeetingAnswerDraftContent {
  const { answerDraftStatus, answerDraftContextSnapshot, draftBodyText } = input;
  const contextItems: LiveMeetingAnswerPreparationContextItem[] = [
    {
      label: "Preparation State",
      value: describeLiveMeetingAnswerPreparationState(
        answerDraftContextSnapshot.answerPreparationState
      ),
    },
    {
      label: "Transcript Context",
      value: answerDraftContextSnapshot.hasTranscriptChunks
        ? `${answerDraftContextSnapshot.transcriptChunkCount} available`
        : "None available",
    },
    {
      label: "Runtime Event",
      value: answerDraftContextSnapshot.hasLatestTranscriptRuntimeEvent ? "Present" : "Not present",
    },
    {
      label: "Session Status",
      value: answerDraftContextSnapshot.hasActiveSession ? "Available" : "Unavailable",
    },
  ];

  if (answerDraftStatus === "drafted") {
    return {
      title: draftBodyText ? "Response Direction" : "Draft Surface",
      bodyLabel: draftBodyText ? "Local Demo Direction" : "Draft Body",
      bodyText:
        draftBodyText ||
        "Local answer draft placeholder only. This browser-local surface is staged from transcript/runtime context after an explicit user trigger, but no answer text has been generated.",
      bodyEmptyText:
        "No local answer draft body is staged yet. This surface remains browser-local and non-generative.",
      contextItems,
    };
  }

  return {
    title: "Draft Surface",
    bodyLabel: "Draft Body",
    bodyText: null,
    bodyEmptyText:
      "No local answer draft body is staged yet. This surface remains browser-local and non-generative.",
    contextItems,
  };
}

function describeLiveMeetingAnswerDraftStatus(
  answerDraftStatus: LiveMeetingAnswerDraftStatus
) {
  switch (answerDraftStatus) {
    case "preparing":
      return "Preparing";
    case "drafted":
      return "Drafted";
    case "unavailable":
      return "Unavailable";
    case "idle":
    default:
      return "Idle";
  }
}

function createLiveMeetingAnswerDraftReviewStatus(input: {
  answerDraftStatus: LiveMeetingAnswerDraftStatus;
  answerDraftContent: LiveMeetingAnswerDraftContent;
  answerPreparationState: LiveMeetingAnswerPreparationState;
}): LiveMeetingAnswerDraftReviewStatus {
  const { answerDraftStatus, answerDraftContent, answerPreparationState } = input;

  if (answerDraftStatus === "unavailable") {
    return "unavailable";
  }

  if (answerPreparationState === "requested" && answerDraftStatus !== "drafted") {
    return "stopped";
  }

  if (answerDraftStatus === "preparing") {
    return "drafting";
  }

  if (answerDraftStatus === "drafted") {
    return "ready-to-review";
  }

  if (!answerDraftContent.bodyText) {
    return "empty";
  }

  return "ready-to-review";
}

function describeLiveMeetingAnswerDraftReviewStatus(
  answerDraftReviewStatus: LiveMeetingAnswerDraftReviewStatus
) {
  switch (answerDraftReviewStatus) {
    case "drafting":
      return "Drafting";
    case "empty":
      return "Empty";
    case "unavailable":
      return "Unavailable";
    case "stopped":
      return "Stopped";
    case "ready-to-review":
    default:
      return "Ready To Review";
  }
}

function createLiveMeetingAnswerDraftDetails(input: {
  answerRuntimeState: LiveMeetingAnswerRuntimeState;
  answerDraftContextSnapshot: LiveMeetingAnswerDraftContextSnapshot;
}) {
  const { answerRuntimeState, answerDraftContextSnapshot } = input;
  let answerDraftStatus: LiveMeetingAnswerDraftStatus = "idle";

  if (answerRuntimeState.status === "requested") {
    answerDraftStatus = "drafted";
  } else if (answerDraftContextSnapshot.answerPreparationState === "ready-to-prepare") {
    answerDraftStatus = "preparing";
  } else if (answerDraftContextSnapshot.answerPreparationState === "unavailable") {
    answerDraftStatus = "unavailable";
  }

  const answerDraftStatusLabel = describeLiveMeetingAnswerDraftStatus(answerDraftStatus);
  const answerDraftContent = createLiveMeetingAnswerDraftContent({
    answerDraftStatus,
    answerDraftContextSnapshot,
    draftBodyText: answerRuntimeState.draftBodyText,
  });
  const answerDraftReviewStatus = createLiveMeetingAnswerDraftReviewStatus({
    answerDraftStatus,
    answerDraftContent,
    answerPreparationState: answerDraftContextSnapshot.answerPreparationState,
  });
  const answerDraftReviewStateLabel = describeLiveMeetingAnswerDraftReviewStatus(
    answerDraftReviewStatus
  );
  const answerDraftReviewEmptyText =
    answerDraftReviewStatus === "unavailable"
      ? "Answer draft review is unavailable until local answer-preparation context is available in this browser shell."
      : answerDraftReviewStatus === "stopped"
        ? "Answer draft review is not actively staged because the local answer-preparation request no longer maps to a reviewable draft surface."
        : answerDraftReviewStatus === "empty"
          ? "Answer draft review is ready for a local draft surface, but no browser-local draft content is staged yet."
          : answerDraftReviewStatus === "drafting"
            ? "Answer draft review is still preparing from local transcript/runtime context. No answer content is generated yet."
            : "Answer draft review is showing a browser-local draft surface only. No backend or hidden orchestration is active.";

  if (answerDraftStatus === "drafted") {
    return {
      draftStateText: `Answer Draft State: ${answerDraftStatusLabel}.`,
      draftHelperText:
        "A local answer draft surface is staged from available transcript/runtime context. No generated answer content, summarization, or backend work is active.",
      draftReviewStateText: `Answer Draft Review State: ${answerDraftReviewStateLabel}.`,
      draftReviewEmptyText: answerDraftReviewEmptyText,
      draftContextItems: answerDraftContent.contextItems,
      draftSurfaceTitle: answerDraftContent.title,
      draftSurfaceText: answerDraftContent.bodyText,
    };
  }

  if (answerDraftStatus === "preparing") {
    return {
      draftStateText: `Answer Draft State: ${answerDraftStatusLabel}.`,
      draftHelperText:
        "Local answer draft context is available. An explicit local prepare action can stage the draft surface, but no answer text exists yet.",
      draftReviewStateText: `Answer Draft Review State: ${answerDraftReviewStateLabel}.`,
      draftReviewEmptyText: answerDraftReviewEmptyText,
      draftContextItems: answerDraftContent.contextItems,
      draftSurfaceTitle: answerDraftContent.title,
      draftSurfaceText: null,
    };
  }

  if (answerDraftStatus === "unavailable") {
    return {
      draftStateText: `Answer Draft State: ${answerDraftStatusLabel}.`,
      draftHelperText:
        "Local answer draft is unavailable until active-session and transcript/runtime context are available together in this browser shell.",
      draftReviewStateText: `Answer Draft Review State: ${answerDraftReviewStateLabel}.`,
      draftReviewEmptyText: answerDraftReviewEmptyText,
      draftContextItems: answerDraftContent.contextItems,
      draftSurfaceTitle: answerDraftContent.title,
      draftSurfaceText: null,
    };
  }

  return {
    draftStateText: `Answer Draft State: ${answerDraftStatusLabel}.`,
    draftHelperText:
      "No local answer draft surface is staged yet. Use the explicit local answer preparation trigger when the transcript/runtime lane is ready.",
    draftReviewStateText: `Answer Draft Review State: ${answerDraftReviewStateLabel}.`,
    draftReviewEmptyText: answerDraftReviewEmptyText,
    draftContextItems: answerDraftContent.contextItems,
    draftSurfaceTitle: answerDraftContent.title,
    draftSurfaceText: null,
  };
}

function createLiveMeetingTranscriptRuntimeDetails(
  transcriptRuntimeState: LiveMeetingTranscriptRuntimeState
) {
  const runtimeStatusLabel = describeLiveMeetingTranscriptRuntimeStatus(transcriptRuntimeState.status);
  const orderedRuntimeEvents = orderLiveMeetingTranscriptRuntimeEvents(
    transcriptRuntimeState.events
  );
  const orderedTranscriptChunks = orderLiveMeetingTranscriptRuntimeChunks(
    transcriptRuntimeState.chunks
  );
  const lastRuntimeEvent = orderedRuntimeEvents[0] ?? null;
  const transcriptIngestionStatus = createLiveMeetingTranscriptIngestionStatus(
    transcriptRuntimeState
  );
  const transcriptIngestionStateLabel = describeLiveMeetingTranscriptIngestionStatus(
    transcriptIngestionStatus
  );
  const transcriptReviewLines = createLiveMeetingTranscriptReviewLines(orderedTranscriptChunks);
  const transcriptReviewStatus = createLiveMeetingTranscriptReviewStatus({
    transcriptIngestionStatus,
    transcriptReviewLines,
  });
  const transcriptReviewStateLabel = describeLiveMeetingTranscriptReviewStatus(
    transcriptReviewStatus
  );

  return {
    runtimeText: `Transcript Runtime: ${runtimeStatusLabel}. ${transcriptRuntimeState.detail}`,
    runtimeEventText: lastRuntimeEvent
      ? `Last Transcript Event: ${describeLiveMeetingTranscriptRuntimeStatus(
          lastRuntimeEvent.kind
        )} at ${new Date(lastRuntimeEvent.timestamp).toLocaleTimeString()} - ${lastRuntimeEvent.message}`
      : null,
    runtimeInputTitle: "Local Transcript Runtime Input",
    runtimeInputPlaceholder:
      "Stage a browser-local transcript runtime input chunk after the transcript lane has been explicitly requested.",
    runtimeInputActionLabel: "Add Local Transcript Input",
    runtimeInputHelperText:
      transcriptIngestionStatus === "ingesting"
        ? "Local transcript runtime input is being staged manually in this browser only. Answer generation is not active."
        : transcriptIngestionStatus === "empty"
          ? "Transcript runtime was explicitly requested. You can stage local transcript runtime input here without starting transcript generation."
          : transcriptIngestionStatus === "stopped"
            ? "Transcript runtime input is no longer active because the local session stopped. Start a new eligible session before staging more input."
            : transcriptIngestionStatus === "unavailable"
              ? "Local transcript runtime input is unavailable until transcript readiness conditions are met in this browser."
              : "Transcript runtime input is idle until an explicit transcript start request is made in this browser-local session.",
    transcriptIngestionStateText:
      orderedTranscriptChunks.length > 0
        ? `Transcript Ingestion State: ${transcriptIngestionStateLabel}.`
        : `Transcript Ingestion State: ${transcriptIngestionStateLabel}. No local transcript runtime input chunks are staged.`,
    transcriptReviewTitle: "Transcript Review",
    transcriptReviewStateText: `Transcript Review State: ${transcriptReviewStateLabel}.`,
    transcriptReviewEmptyText:
      transcriptReviewStatus === "unavailable"
        ? "Transcript review is unavailable until the local session is ready for transcript runtime input."
        : transcriptReviewStatus === "stopped"
          ? "Transcript review is showing no active input because the local transcript runtime stopped."
          : transcriptReviewStatus === "empty"
            ? "Transcript review is ready for local input, but no transcript runtime chunks have been staged yet."
            : transcriptReviewStatus === "ingesting"
              ? "Transcript review is showing locally ingested transcript runtime chunks only. No summarization or answer generation is active."
              : "Transcript review will appear here after an explicit transcript runtime request and local input.",
    transcriptReviewLines,
    transcriptChunkSummaryText: formatLiveMeetingTranscriptChunkSummary(orderedTranscriptChunks),
    transcriptChunks: orderedTranscriptChunks,
  };
}

function describeLiveMeetingSessionStopReason(
  stopReason: LiveMeetingSessionStopReason
) {
  switch (stopReason) {
    case "stopped-by-user":
      return "Stopped By User";
    case "stopped-on-cleanup":
      return "Stopped On Cleanup";
    case "track-ended":
      return "Track Ended";
    case "failed":
      return "Failed";
    case "not-applicable":
    default:
      return null;
  }
}

function createLiveMeetingSessionRuntimeDetails(input: {
  sessionRuntimeState: LiveMeetingSessionRuntimeState;
  permissionRequestState: LiveMeetingPermissionRequestState;
  transcriptSessionState: LiveMeetingTranscriptSessionState;
  transcriptRuntimeState: LiveMeetingTranscriptRuntimeState;
  answerRuntimeState: LiveMeetingAnswerRuntimeState;
  verificationObservationState: LiveMeetingRuntimeVerificationObservationState;
}): LiveMeetingSessionRuntimeDetails {
  const {
    sessionRuntimeState,
    permissionRequestState,
    transcriptSessionState,
    transcriptRuntimeState,
    answerRuntimeState,
    verificationObservationState,
  } = input;
  const metadataSummary = formatLiveMeetingSessionMetadataSummary(sessionRuntimeState.metadata);
  const observationSummary = formatLiveMeetingStreamObservationSummary(
    sessionRuntimeState.observation
  );
  const audioReadiness = createLiveMeetingAudioReadinessSnapshot(sessionRuntimeState.observation);
  const audioReadinessSummary = formatLiveMeetingAudioReadinessSummary(audioReadiness);
  const transcriptReadinessState = createLiveMeetingTranscriptReadinessState({
    sessionRuntimeState,
    audioReadiness,
  });
  const transcriptReadinessSummary =
    formatLiveMeetingTranscriptReadinessSummary(transcriptReadinessState);
  const transcriptSessionStateDetails = createLiveMeetingTranscriptSessionStateDetails({
    transcriptReadinessState,
    transcriptSessionState,
  });
  const transcriptRuntimeDetails = createLiveMeetingTranscriptRuntimeDetails(
    transcriptRuntimeState
  );
  const stopReasonText = describeLiveMeetingSessionStopReason(sessionRuntimeState.stopReason);
  const answerReadinessState = createLiveMeetingAnswerReadinessState({
    sessionRuntimeState,
    transcriptReviewStatus: createLiveMeetingTranscriptReviewStatus({
      transcriptIngestionStatus: createLiveMeetingTranscriptIngestionStatus(
        transcriptRuntimeState
      ),
      transcriptReviewLines: transcriptRuntimeDetails.transcriptReviewLines,
    }),
    transcriptReviewLines: transcriptRuntimeDetails.transcriptReviewLines,
  });
  const answerReadinessStateLabel = describeLiveMeetingAnswerReadinessState(
    answerReadinessState
  );
  const answerReadinessHelperText =
    answerReadinessState === "ready-later"
      ? "Local session and transcript review context are present for future answer work, but no answer generation or summarization is active in this browser shell."
      : answerReadinessState === "blocked-by-no-transcript"
        ? "Future answer work remains blocked until local transcript runtime input is available in the review lane."
        : answerReadinessState === "blocked-by-no-active-session"
          ? "Future answer work remains blocked until a local capture session is active and transcript runtime input is available."
          : "Future answer work is not ready in the current browser-local session state.";
  const answerRuntimeDetails = createLiveMeetingAnswerRuntimeDetails({
    answerReadinessState,
    answerRuntimeState,
  });
  const answerPreparationContextSnapshot = createLiveMeetingAnswerPreparationContextSnapshot({
    sessionRuntimeState,
    transcriptRuntimeDetails,
  });
  const answerPreparationState = createLiveMeetingAnswerPreparationState({
    answerReadinessState,
    answerRuntimeState,
    contextSnapshot: answerPreparationContextSnapshot,
  });
  const answerPreparationStateLabel = describeLiveMeetingAnswerPreparationState(
    answerPreparationState
  );
  const answerPreparationContextItems = createLiveMeetingAnswerPreparationContextItems(
    answerPreparationContextSnapshot
  );
  const answerDraftContextSnapshot = createLiveMeetingAnswerDraftContextSnapshot({
    preparationContextSnapshot: answerPreparationContextSnapshot,
    answerPreparationState,
  });
  const answerDraftDetails = createLiveMeetingAnswerDraftDetails({
    answerRuntimeState,
    answerDraftContextSnapshot,
  });
  const canIngestTranscriptInput =
    sessionRuntimeState.status === "active" &&
    (transcriptRuntimeState.status === "requested" ||
      transcriptRuntimeState.status === "active");
  const canPrepareAnswer =
    answerReadinessState === "ready-later" && answerRuntimeState.status !== "requested";
  const hasRuntimeArtifacts =
    permissionRequestState.status !== "idle" ||
    sessionRuntimeState.status !== "idle" ||
    transcriptSessionState.status !== "idle" ||
    transcriptRuntimeState.status !== "idle" ||
    transcriptRuntimeState.events.length > 0 ||
    transcriptRuntimeState.chunks.length > 0 ||
    answerRuntimeState.status !== "idle" ||
    answerRuntimeState.hasUserTriggeredPrepare;
  const resetActionLabel = "Reset Local Runtime Lane";
  const resetActionHelperText = hasRuntimeArtifacts
    ? "This explicit reset clears only browser-local live-meeting session, transcript, and answer-draft state so the lane can be reused cleanly."
    : "No browser-local live-meeting runtime state is currently staged. This reset stays available for future explicit cleanup.";
  const verificationTitle = "Local Runtime Verification";
  const verificationStateText =
    sessionRuntimeState.status === "active"
      ? "Verification State: Ready To Test Locally."
      : permissionRequestState.status === "granted"
        ? "Verification State: Ready For Fresh Session Start."
        : hasRuntimeArtifacts
          ? "Verification State: Review Local Runtime State."
          : "Verification State: Awaiting Local Runtime Start.";
  const verificationHelperText =
    sessionRuntimeState.status === "active"
      ? "The browser-local runtime surface is active and testable now: session is running, transcript input can be staged when requested, and answer-preparation surfaces remain local only."
      : permissionRequestState.status === "granted"
        ? "Permission has been verified locally. The next explicit operator step is to start a fresh local capture session and then stage transcript/runtime input if needed."
        : hasRuntimeArtifacts
        ? "Local runtime artifacts are present for review. You can inspect the current lane, reset it explicitly, or continue with another explicit browser-local action."
        : "No browser-local runtime is active yet. Grant permission first, then start a local session, request transcript runtime if needed, and review the staged answer surfaces locally.";
  const verificationItems: LiveMeetingRuntimeVerificationItemViewModel[] = [
    createLiveMeetingRuntimeVerificationItem({
      key: "permission-denied-path",
      label: "Permission Denied Path",
      status:
        permissionRequestState.status === "denied"
          ? "observed"
          : verificationObservationState["permission-denied-path"]
            ? "observed"
            : permissionRequestState.status === "idle"
              ? "ready-to-test"
              : "not-run",
      detail:
        permissionRequestState.status === "denied"
          ? "Permission denial was observed from a real browser permission prompt."
          : "Trigger the explicit permission request and deny or dismiss it to verify this path.",
      observedAt: verificationObservationState["permission-denied-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "permission-granted-but-stopped-path",
      label: "Permission Granted / Stopped Path",
      status:
        permissionRequestState.status === "granted" ||
        verificationObservationState["permission-granted-but-stopped-path"]
          ? "observed"
          : permissionRequestState.status === "idle"
            ? "ready-to-test"
            : "not-run",
      detail:
        permissionRequestState.status === "granted"
          ? "Permission grant was observed, and the returned stream was stopped immediately."
          : "Grant permission from the explicit launch trigger to verify the granted-but-stopped path.",
      observedAt: verificationObservationState["permission-granted-but-stopped-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "session-start-path",
      label: "Session Start Path",
      status:
        sessionRuntimeState.status === "active"
          ? "observed"
          : sessionRuntimeState.status === "failed"
            ? "warning"
            : verificationObservationState["session-start-path"]
              ? "observed"
              : permissionRequestState.status === "granted"
                ? "ready-to-test"
                : "not-run",
      detail:
        sessionRuntimeState.status === "active"
          ? "A real local capture session is currently running."
          : sessionRuntimeState.status === "failed"
            ? sessionRuntimeState.detail
            : "Start a local capture session after permission is granted to verify this path.",
      observedAt: verificationObservationState["session-start-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "session-stop-path",
      label: "Session Stop Path",
      status:
        sessionRuntimeState.status === "stopped" &&
        sessionRuntimeState.stopReason === "stopped-by-user"
          ? "observed"
          : verificationObservationState["session-stop-path"]
            ? "observed"
            : sessionRuntimeState.status === "active"
              ? "ready-to-test"
              : "not-run",
      detail:
        sessionRuntimeState.status === "stopped" &&
        sessionRuntimeState.stopReason === "stopped-by-user"
          ? "Session stop was observed from an explicit local stop action."
          : "Stop an active local session to verify this path.",
      observedAt: verificationObservationState["session-stop-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "session-reset-path",
      label: "Session Reset Path",
      status: verificationObservationState["session-reset-path"]
        ? "observed"
        : hasRuntimeArtifacts
          ? "ready-to-test"
          : "not-run",
      detail: hasRuntimeArtifacts
        ? "Use the explicit local reset to clear the current runtime lane and verify reset behavior."
        : "Reset can be verified after you stage local runtime state.",
      observedAt: verificationObservationState["session-reset-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "session-restart-path",
      label: "Session Restart Path",
      status:
        verificationObservationState["session-restart-path"]
          ? "observed"
          : sessionRuntimeState.status === "stopped" || sessionRuntimeState.status === "granted-but-stopped"
            ? "ready-to-test"
            : "not-run",
      detail:
        verificationObservationState["session-restart-path"]
          ? "A fresh local session start was observed after an earlier stop, reset, or prior session state."
          : "Start another local session after a stop or reset to verify clean restart behavior.",
      observedAt: verificationObservationState["session-restart-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "transcript-ingest-path",
      label: "Transcript Ingest Path",
      status:
        transcriptRuntimeState.chunks.length > 0 ||
        verificationObservationState["transcript-ingest-path"]
          ? "observed"
          : canIngestTranscriptInput
            ? "ready-to-test"
            : "not-run",
      detail:
        transcriptRuntimeState.chunks.length > 0
          ? `${transcriptRuntimeState.chunks.length} local transcript chunk${
              transcriptRuntimeState.chunks.length === 1 ? "" : "s"
            } were observed.`
          : "Request transcript runtime, then add local transcript input to verify ingest behavior.",
      observedAt: verificationObservationState["transcript-ingest-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "transcript-review-path",
      label: "Transcript Review Path",
      status:
        transcriptRuntimeDetails.transcriptReviewLines.length > 0 ||
        verificationObservationState["transcript-review-path"]
          ? "observed"
          : transcriptRuntimeState.chunks.length > 0
            ? "ready-to-test"
            : "not-run",
      detail:
        transcriptRuntimeDetails.transcriptReviewLines.length > 0
          ? "Transcript review is rendering real browser-local runtime chunks."
          : "Stage at least one transcript chunk to verify the review surface.",
      observedAt: verificationObservationState["transcript-review-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "answer-preparation-path",
      label: "Answer Preparation Path",
      status:
        answerRuntimeState.status === "blocked"
          ? "warning"
          : answerRuntimeState.status === "requested" ||
              verificationObservationState["answer-preparation-path"]
            ? "observed"
            : canPrepareAnswer
              ? "ready-to-test"
              : "not-run",
      detail:
        answerRuntimeState.status === "blocked"
          ? answerRuntimeState.detail
          : answerRuntimeState.status === "requested"
            ? "Answer preparation intent was observed from explicit local runtime context."
            : "Use the explicit answer-preparation control after transcript review is available to verify this path.",
      observedAt: verificationObservationState["answer-preparation-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "answer-draft-path",
      label: "Answer Draft Path",
      status:
        answerDraftDetails.draftSurfaceText ||
        verificationObservationState["answer-draft-path"]
          ? "observed"
          : answerRuntimeState.status === "requested"
            ? "ready-to-test"
            : "not-run",
      detail:
        answerDraftDetails.draftSurfaceText
          ? "A local answer draft surface is rendering from explicit browser-local context."
          : "Trigger answer preparation when ready to verify draft staging.",
      observedAt: verificationObservationState["answer-draft-path"],
    }),
    createLiveMeetingRuntimeVerificationItem({
      key: "reset-after-answer-draft-path",
      label: "Reset After Answer Draft Path",
      status: verificationObservationState["reset-after-answer-draft-path"]
        ? "observed"
        : answerRuntimeState.status === "requested"
          ? "ready-to-test"
          : "not-run",
      detail:
        verificationObservationState["reset-after-answer-draft-path"]
          ? "A local reset was observed after an answer draft surface had already been staged."
          : "Stage an answer draft surface, then use the explicit reset to verify cleanup after draft review.",
      observedAt: verificationObservationState["reset-after-answer-draft-path"],
    }),
  ];

  switch (sessionRuntimeState.status) {
    case "granted-but-stopped":
      return {
        progressionSessionValue: "Permission Granted / Stream Stopped / Not Running",
        captureStatusValue: "Permission Granted / Stream Stopped / Not Running",
        captureStatusExplanation:
          "Permission succeeded from an explicit user click, but the returned stream was stopped immediately and no live capture remains active.",
        captureSessionStatusValue: "Permission Granted / Stream Stopped / Not Running",
        captureSessionHelperText:
          metadataSummary
            ? `Permission was granted from an explicit user click. A browser stream was received locally (${formatLiveMeetingSessionTrackSummary(
                sessionRuntimeState.metadata
              )}) and stopped immediately. Capture is not currently running, and no transcription or answer generation is active.`
            : sessionRuntimeState.detail,
        captureSessionVerificationTitle: verificationTitle,
        captureSessionVerificationStateText: verificationStateText,
        captureSessionVerificationHelperText: verificationHelperText,
        captureSessionVerificationItems: verificationItems,
        captureSessionMetadataText: metadataSummary,
        captureSessionObservationText: observationSummary,
        captureSessionAudioReadinessText: audioReadinessSummary,
        captureSessionTranscriptReadinessText: transcriptReadinessSummary,
        captureSessionTranscriptBoundaryText: transcriptSessionStateDetails.boundaryText,
        captureSessionTranscriptRuntimeText: transcriptRuntimeDetails.runtimeText,
        captureSessionTranscriptRuntimeEventText: transcriptRuntimeDetails.runtimeEventText,
        captureSessionTranscriptInputTitle: transcriptRuntimeDetails.runtimeInputTitle,
        captureSessionTranscriptInputPlaceholder:
          transcriptRuntimeDetails.runtimeInputPlaceholder,
        captureSessionTranscriptInputActionLabel:
          transcriptRuntimeDetails.runtimeInputActionLabel,
        captureSessionTranscriptInputHelperText:
          transcriptRuntimeDetails.runtimeInputHelperText,
        canIngestTranscriptInput,
        captureSessionTranscriptIngestionStateText:
          transcriptRuntimeDetails.transcriptIngestionStateText,
        captureSessionTranscriptReviewTitle:
          transcriptRuntimeDetails.transcriptReviewTitle,
        captureSessionTranscriptReviewStateText:
          transcriptRuntimeDetails.transcriptReviewStateText,
        captureSessionTranscriptReviewEmptyText:
          transcriptRuntimeDetails.transcriptReviewEmptyText,
        captureSessionTranscriptReviewLines:
          transcriptRuntimeDetails.transcriptReviewLines,
        captureSessionTranscriptChunkSummaryText:
          transcriptRuntimeDetails.transcriptChunkSummaryText,
        captureSessionTranscriptChunks: transcriptRuntimeDetails.transcriptChunks,
        captureSessionAnswerReadinessTitle: "Answer Preparation Readiness",
        captureSessionAnswerReadinessStateText:
          `Answer Readiness: ${answerReadinessStateLabel}.`,
        captureSessionAnswerReadinessHelperText: answerReadinessHelperText,
        captureSessionAnswerPreparationStateText:
          `Answer Preparation State: ${answerPreparationStateLabel}.`,
        captureSessionAnswerPreparationContextItems: answerPreparationContextItems,
        captureSessionAnswerRuntimeStateText: answerRuntimeDetails.runtimeStateText,
        captureSessionAnswerRuntimeHelperText: answerRuntimeDetails.runtimeHelperText,
        captureSessionAnswerPreparationLabel: "Prepare Answer Placeholder",
        captureSessionAnswerPreparationHelperText:
          "Planned only. This disabled shell marks where future answer preparation could appear without starting answer generation, summarization, or backend work today.",
        canPrepareAnswer,
        captureSessionAnswerDraftTitle: "Local Answer Draft",
        captureSessionAnswerDraftStateText: answerDraftDetails.draftStateText,
        captureSessionAnswerDraftHelperText: answerDraftDetails.draftHelperText,
        captureSessionAnswerDraftReviewStateText:
          answerDraftDetails.draftReviewStateText,
        captureSessionAnswerDraftReviewEmptyText:
          answerDraftDetails.draftReviewEmptyText,
        captureSessionAnswerDraftContextItems: answerDraftDetails.draftContextItems,
        captureSessionAnswerDraftSurfaceTitle: answerDraftDetails.draftSurfaceTitle,
        captureSessionAnswerDraftSurfaceText: answerDraftDetails.draftSurfaceText,
        captureSessionTranscriptStartTitle: "Transcript Start Placeholder",
        captureSessionTranscriptStartLabel: transcriptSessionStateDetails.startLabel,
        captureSessionTranscriptStartHelperText: transcriptSessionStateDetails.startHelperText,
        canStartTranscript: transcriptSessionStateDetails.canStartTranscript,
        captureSessionStopReasonText: null,
        captureSessionActionHelperText:
          "You can explicitly start a fresh local capture session later. Starting will request a new browser display-media stream and keep it active until you stop it.",
        captureSessionResetActionLabel: resetActionLabel,
        captureSessionResetActionHelperText: resetActionHelperText,
        canStartSession: permissionRequestState.status === "granted",
        canStopSession: false,
        canResetRuntime: hasRuntimeArtifacts,
      };
    case "active":
      return {
        progressionSessionValue: "Active / Running Locally",
        captureStatusValue: "Active / Running Locally",
        captureStatusExplanation:
          "A local browser capture session is currently active from an explicit user click. Transcription may run in the transcript lane, and answer generation is not active.",
        captureSessionStatusValue: "Active / Running Locally",
        captureSessionHelperText:
          metadataSummary
            ? `A local browser capture session is active from an explicit user click (${formatLiveMeetingSessionTrackSummary(
                sessionRuntimeState.metadata
              )}, stream ${sessionRuntimeState.metadata.streamId}). Transcription may run in the transcript lane, and answer generation is not active.`
            : sessionRuntimeState.detail,
        captureSessionVerificationTitle: verificationTitle,
        captureSessionVerificationStateText: verificationStateText,
        captureSessionVerificationHelperText: verificationHelperText,
        captureSessionVerificationItems: verificationItems,
        captureSessionMetadataText: metadataSummary,
        captureSessionObservationText: observationSummary,
        captureSessionAudioReadinessText: audioReadinessSummary,
        captureSessionTranscriptReadinessText: transcriptReadinessSummary,
        captureSessionTranscriptBoundaryText: transcriptSessionStateDetails.boundaryText,
        captureSessionTranscriptRuntimeText: transcriptRuntimeDetails.runtimeText,
        captureSessionTranscriptRuntimeEventText: transcriptRuntimeDetails.runtimeEventText,
        captureSessionTranscriptInputTitle: transcriptRuntimeDetails.runtimeInputTitle,
        captureSessionTranscriptInputPlaceholder:
          transcriptRuntimeDetails.runtimeInputPlaceholder,
        captureSessionTranscriptInputActionLabel:
          transcriptRuntimeDetails.runtimeInputActionLabel,
        captureSessionTranscriptInputHelperText:
          transcriptRuntimeDetails.runtimeInputHelperText,
        canIngestTranscriptInput,
        captureSessionTranscriptIngestionStateText:
          transcriptRuntimeDetails.transcriptIngestionStateText,
        captureSessionTranscriptReviewTitle:
          transcriptRuntimeDetails.transcriptReviewTitle,
        captureSessionTranscriptReviewStateText:
          transcriptRuntimeDetails.transcriptReviewStateText,
        captureSessionTranscriptReviewEmptyText:
          transcriptRuntimeDetails.transcriptReviewEmptyText,
        captureSessionTranscriptReviewLines:
          transcriptRuntimeDetails.transcriptReviewLines,
        captureSessionTranscriptChunkSummaryText:
          transcriptRuntimeDetails.transcriptChunkSummaryText,
        captureSessionTranscriptChunks: transcriptRuntimeDetails.transcriptChunks,
        captureSessionAnswerReadinessTitle: "Answer Preparation Readiness",
        captureSessionAnswerReadinessStateText:
          `Answer Readiness: ${answerReadinessStateLabel}.`,
        captureSessionAnswerReadinessHelperText: answerReadinessHelperText,
        captureSessionAnswerPreparationStateText:
          `Answer Preparation State: ${answerPreparationStateLabel}.`,
        captureSessionAnswerPreparationContextItems: answerPreparationContextItems,
        captureSessionAnswerRuntimeStateText: answerRuntimeDetails.runtimeStateText,
        captureSessionAnswerRuntimeHelperText: answerRuntimeDetails.runtimeHelperText,
        captureSessionAnswerPreparationLabel: "Prepare Answer Placeholder",
        captureSessionAnswerPreparationHelperText:
          "Planned only. This disabled shell marks where future answer preparation could appear without starting answer generation, summarization, or backend work today.",
        canPrepareAnswer,
        captureSessionAnswerDraftTitle: "Local Answer Draft",
        captureSessionAnswerDraftStateText: answerDraftDetails.draftStateText,
        captureSessionAnswerDraftHelperText: answerDraftDetails.draftHelperText,
        captureSessionAnswerDraftReviewStateText:
          answerDraftDetails.draftReviewStateText,
        captureSessionAnswerDraftReviewEmptyText:
          answerDraftDetails.draftReviewEmptyText,
        captureSessionAnswerDraftContextItems: answerDraftDetails.draftContextItems,
        captureSessionAnswerDraftSurfaceTitle: answerDraftDetails.draftSurfaceTitle,
        captureSessionAnswerDraftSurfaceText: answerDraftDetails.draftSurfaceText,
        captureSessionTranscriptStartTitle: "Transcript Start Placeholder",
        captureSessionTranscriptStartLabel: transcriptSessionStateDetails.startLabel,
        captureSessionTranscriptStartHelperText: transcriptSessionStateDetails.startHelperText,
        canStartTranscript: transcriptSessionStateDetails.canStartTranscript,
        captureSessionStopReasonText: null,
        captureSessionActionHelperText:
          "Stopping this local session will stop all active tracks immediately in the browser.",
        captureSessionResetActionLabel: resetActionLabel,
        captureSessionResetActionHelperText: resetActionHelperText,
        canStartSession: false,
        canStopSession: true,
        canResetRuntime: hasRuntimeArtifacts,
      };
    case "stopped":
      return {
        progressionSessionValue: "Stopped / Not Running",
        captureStatusValue: "Stopped / Not Running",
        captureStatusExplanation:
          "A local browser capture session was stopped and is no longer running. Answer generation is not active.",
        captureSessionStatusValue: "Stopped / Not Running",
        captureSessionHelperText: sessionRuntimeState.detail,
        captureSessionVerificationTitle: verificationTitle,
        captureSessionVerificationStateText: verificationStateText,
        captureSessionVerificationHelperText: verificationHelperText,
        captureSessionVerificationItems: verificationItems,
        captureSessionMetadataText: metadataSummary,
        captureSessionObservationText: observationSummary,
        captureSessionAudioReadinessText: audioReadinessSummary,
        captureSessionTranscriptReadinessText: transcriptReadinessSummary,
        captureSessionTranscriptBoundaryText: transcriptSessionStateDetails.boundaryText,
        captureSessionTranscriptRuntimeText: transcriptRuntimeDetails.runtimeText,
        captureSessionTranscriptRuntimeEventText: transcriptRuntimeDetails.runtimeEventText,
        captureSessionTranscriptInputTitle: transcriptRuntimeDetails.runtimeInputTitle,
        captureSessionTranscriptInputPlaceholder:
          transcriptRuntimeDetails.runtimeInputPlaceholder,
        captureSessionTranscriptInputActionLabel:
          transcriptRuntimeDetails.runtimeInputActionLabel,
        captureSessionTranscriptInputHelperText:
          transcriptRuntimeDetails.runtimeInputHelperText,
        canIngestTranscriptInput,
        captureSessionTranscriptIngestionStateText:
          transcriptRuntimeDetails.transcriptIngestionStateText,
        captureSessionTranscriptReviewTitle:
          transcriptRuntimeDetails.transcriptReviewTitle,
        captureSessionTranscriptReviewStateText:
          transcriptRuntimeDetails.transcriptReviewStateText,
        captureSessionTranscriptReviewEmptyText:
          transcriptRuntimeDetails.transcriptReviewEmptyText,
        captureSessionTranscriptReviewLines:
          transcriptRuntimeDetails.transcriptReviewLines,
        captureSessionTranscriptChunkSummaryText:
          transcriptRuntimeDetails.transcriptChunkSummaryText,
        captureSessionTranscriptChunks: transcriptRuntimeDetails.transcriptChunks,
        captureSessionAnswerReadinessTitle: "Answer Preparation Readiness",
        captureSessionAnswerReadinessStateText:
          `Answer Readiness: ${answerReadinessStateLabel}.`,
        captureSessionAnswerReadinessHelperText: answerReadinessHelperText,
        captureSessionAnswerPreparationStateText:
          `Answer Preparation State: ${answerPreparationStateLabel}.`,
        captureSessionAnswerPreparationContextItems: answerPreparationContextItems,
        captureSessionAnswerRuntimeStateText: answerRuntimeDetails.runtimeStateText,
        captureSessionAnswerRuntimeHelperText: answerRuntimeDetails.runtimeHelperText,
        captureSessionAnswerPreparationLabel: "Prepare Answer Placeholder",
        captureSessionAnswerPreparationHelperText:
          "Planned only. This disabled shell marks where future answer preparation could appear without starting answer generation, summarization, or backend work today.",
        canPrepareAnswer,
        captureSessionAnswerDraftTitle: "Local Answer Draft",
        captureSessionAnswerDraftStateText: answerDraftDetails.draftStateText,
        captureSessionAnswerDraftHelperText: answerDraftDetails.draftHelperText,
        captureSessionAnswerDraftReviewStateText:
          answerDraftDetails.draftReviewStateText,
        captureSessionAnswerDraftReviewEmptyText:
          answerDraftDetails.draftReviewEmptyText,
        captureSessionAnswerDraftContextItems: answerDraftDetails.draftContextItems,
        captureSessionAnswerDraftSurfaceTitle: answerDraftDetails.draftSurfaceTitle,
        captureSessionAnswerDraftSurfaceText: answerDraftDetails.draftSurfaceText,
        captureSessionTranscriptStartTitle: "Transcript Start Placeholder",
        captureSessionTranscriptStartLabel: transcriptSessionStateDetails.startLabel,
        captureSessionTranscriptStartHelperText: transcriptSessionStateDetails.startHelperText,
        canStartTranscript: transcriptSessionStateDetails.canStartTranscript,
        captureSessionStopReasonText: stopReasonText,
        captureSessionActionHelperText:
          permissionRequestState.status === "granted"
            ? "You can explicitly start another fresh local capture session later if you want to test the runtime boundary again."
            : "Grant permission again from an explicit user action before starting another local capture session.",
        captureSessionResetActionLabel: resetActionLabel,
        captureSessionResetActionHelperText: resetActionHelperText,
        canStartSession: permissionRequestState.status === "granted",
        canStopSession: false,
        canResetRuntime: hasRuntimeArtifacts,
      };
    case "failed":
      return {
        progressionSessionValue: "Session Failed / Not Running",
        captureStatusValue: "Session Failed / Not Running",
        captureStatusExplanation: sessionRuntimeState.detail,
        captureSessionStatusValue: "Session Failed / Not Running",
        captureSessionHelperText: sessionRuntimeState.detail,
        captureSessionVerificationTitle: verificationTitle,
        captureSessionVerificationStateText: verificationStateText,
        captureSessionVerificationHelperText: verificationHelperText,
        captureSessionVerificationItems: verificationItems,
        captureSessionMetadataText: metadataSummary,
        captureSessionObservationText: observationSummary,
        captureSessionAudioReadinessText: audioReadinessSummary,
        captureSessionTranscriptReadinessText: transcriptReadinessSummary,
        captureSessionTranscriptBoundaryText: transcriptSessionStateDetails.boundaryText,
        captureSessionTranscriptRuntimeText: transcriptRuntimeDetails.runtimeText,
        captureSessionTranscriptRuntimeEventText: transcriptRuntimeDetails.runtimeEventText,
        captureSessionTranscriptInputTitle: transcriptRuntimeDetails.runtimeInputTitle,
        captureSessionTranscriptInputPlaceholder:
          transcriptRuntimeDetails.runtimeInputPlaceholder,
        captureSessionTranscriptInputActionLabel:
          transcriptRuntimeDetails.runtimeInputActionLabel,
        captureSessionTranscriptInputHelperText:
          transcriptRuntimeDetails.runtimeInputHelperText,
        canIngestTranscriptInput,
        captureSessionTranscriptIngestionStateText:
          transcriptRuntimeDetails.transcriptIngestionStateText,
        captureSessionTranscriptReviewTitle:
          transcriptRuntimeDetails.transcriptReviewTitle,
        captureSessionTranscriptReviewStateText:
          transcriptRuntimeDetails.transcriptReviewStateText,
        captureSessionTranscriptReviewEmptyText:
          transcriptRuntimeDetails.transcriptReviewEmptyText,
        captureSessionTranscriptReviewLines:
          transcriptRuntimeDetails.transcriptReviewLines,
        captureSessionTranscriptChunkSummaryText:
          transcriptRuntimeDetails.transcriptChunkSummaryText,
        captureSessionTranscriptChunks: transcriptRuntimeDetails.transcriptChunks,
        captureSessionAnswerReadinessTitle: "Answer Preparation Readiness",
        captureSessionAnswerReadinessStateText:
          `Answer Readiness: ${answerReadinessStateLabel}.`,
        captureSessionAnswerReadinessHelperText: answerReadinessHelperText,
        captureSessionAnswerPreparationStateText:
          `Answer Preparation State: ${answerPreparationStateLabel}.`,
        captureSessionAnswerPreparationContextItems: answerPreparationContextItems,
        captureSessionAnswerRuntimeStateText: answerRuntimeDetails.runtimeStateText,
        captureSessionAnswerRuntimeHelperText: answerRuntimeDetails.runtimeHelperText,
        captureSessionAnswerPreparationLabel: "Prepare Answer Placeholder",
        captureSessionAnswerPreparationHelperText:
          "Planned only. This disabled shell marks where future answer preparation could appear without starting answer generation, summarization, or backend work today.",
        canPrepareAnswer,
        captureSessionAnswerDraftTitle: "Local Answer Draft",
        captureSessionAnswerDraftStateText: answerDraftDetails.draftStateText,
        captureSessionAnswerDraftHelperText: answerDraftDetails.draftHelperText,
        captureSessionAnswerDraftReviewStateText:
          answerDraftDetails.draftReviewStateText,
        captureSessionAnswerDraftReviewEmptyText:
          answerDraftDetails.draftReviewEmptyText,
        captureSessionAnswerDraftContextItems: answerDraftDetails.draftContextItems,
        captureSessionAnswerDraftSurfaceTitle: answerDraftDetails.draftSurfaceTitle,
        captureSessionAnswerDraftSurfaceText: answerDraftDetails.draftSurfaceText,
        captureSessionTranscriptStartTitle: "Transcript Start Placeholder",
        captureSessionTranscriptStartLabel: transcriptSessionStateDetails.startLabel,
        captureSessionTranscriptStartHelperText: transcriptSessionStateDetails.startHelperText,
        canStartTranscript: transcriptSessionStateDetails.canStartTranscript,
        captureSessionStopReasonText: stopReasonText,
        captureSessionActionHelperText:
          "No local session is running. You can explicitly try again later without starting transcription or answer generation.",
        captureSessionResetActionLabel: resetActionLabel,
        captureSessionResetActionHelperText: resetActionHelperText,
        canStartSession: permissionRequestState.status === "granted",
        canStopSession: false,
        canResetRuntime: hasRuntimeArtifacts,
      };
    case "idle":
    default:
      return {
        progressionSessionValue: "Not Started",
        captureStatusValue: "Inactive / Not Started",
        captureStatusExplanation:
          "No capture is running, and no permissions are being requested. Future live capture depends on browser support plus explicit user action later.",
        captureSessionStatusValue: "Not started",
        captureSessionHelperText:
          "This is a structural home for a future browser-local capture session. No media streams, transcription, or answer generation exist yet.",
        captureSessionVerificationTitle: verificationTitle,
        captureSessionVerificationStateText: verificationStateText,
        captureSessionVerificationHelperText: verificationHelperText,
        captureSessionVerificationItems: verificationItems,
        captureSessionMetadataText: null,
        captureSessionObservationText: null,
        captureSessionAudioReadinessText: null,
        captureSessionTranscriptReadinessText: transcriptReadinessSummary,
        captureSessionTranscriptBoundaryText: transcriptSessionStateDetails.boundaryText,
        captureSessionTranscriptRuntimeText: transcriptRuntimeDetails.runtimeText,
        captureSessionTranscriptRuntimeEventText: transcriptRuntimeDetails.runtimeEventText,
        captureSessionTranscriptInputTitle: transcriptRuntimeDetails.runtimeInputTitle,
        captureSessionTranscriptInputPlaceholder:
          transcriptRuntimeDetails.runtimeInputPlaceholder,
        captureSessionTranscriptInputActionLabel:
          transcriptRuntimeDetails.runtimeInputActionLabel,
        captureSessionTranscriptInputHelperText:
          transcriptRuntimeDetails.runtimeInputHelperText,
        canIngestTranscriptInput,
        captureSessionTranscriptIngestionStateText:
          transcriptRuntimeDetails.transcriptIngestionStateText,
        captureSessionTranscriptReviewTitle:
          transcriptRuntimeDetails.transcriptReviewTitle,
        captureSessionTranscriptReviewStateText:
          transcriptRuntimeDetails.transcriptReviewStateText,
        captureSessionTranscriptReviewEmptyText:
          transcriptRuntimeDetails.transcriptReviewEmptyText,
        captureSessionTranscriptReviewLines:
          transcriptRuntimeDetails.transcriptReviewLines,
        captureSessionTranscriptChunkSummaryText:
          transcriptRuntimeDetails.transcriptChunkSummaryText,
        captureSessionTranscriptChunks: transcriptRuntimeDetails.transcriptChunks,
        captureSessionAnswerReadinessTitle: "Answer Preparation Readiness",
        captureSessionAnswerReadinessStateText:
          `Answer Readiness: ${answerReadinessStateLabel}.`,
        captureSessionAnswerReadinessHelperText: answerReadinessHelperText,
        captureSessionAnswerPreparationStateText:
          `Answer Preparation State: ${answerPreparationStateLabel}.`,
        captureSessionAnswerPreparationContextItems: answerPreparationContextItems,
        captureSessionAnswerRuntimeStateText: answerRuntimeDetails.runtimeStateText,
        captureSessionAnswerRuntimeHelperText: answerRuntimeDetails.runtimeHelperText,
        captureSessionAnswerPreparationLabel: "Prepare Answer Placeholder",
        captureSessionAnswerPreparationHelperText:
          "Planned only. This disabled shell marks where future answer preparation could appear without starting answer generation, summarization, or backend work today.",
        canPrepareAnswer,
        captureSessionAnswerDraftTitle: "Local Answer Draft",
        captureSessionAnswerDraftStateText: answerDraftDetails.draftStateText,
        captureSessionAnswerDraftHelperText: answerDraftDetails.draftHelperText,
        captureSessionAnswerDraftReviewStateText:
          answerDraftDetails.draftReviewStateText,
        captureSessionAnswerDraftReviewEmptyText:
          answerDraftDetails.draftReviewEmptyText,
        captureSessionAnswerDraftContextItems: answerDraftDetails.draftContextItems,
        captureSessionAnswerDraftSurfaceTitle: answerDraftDetails.draftSurfaceTitle,
        captureSessionAnswerDraftSurfaceText: answerDraftDetails.draftSurfaceText,
        captureSessionTranscriptStartTitle: "Transcript Start Placeholder",
        captureSessionTranscriptStartLabel: transcriptSessionStateDetails.startLabel,
        captureSessionTranscriptStartHelperText: transcriptSessionStateDetails.startHelperText,
        canStartTranscript: transcriptSessionStateDetails.canStartTranscript,
        captureSessionStopReasonText: null,
        captureSessionActionHelperText:
          permissionRequestState.status === "granted"
            ? "Permission has already been granted once. You can explicitly start a fresh local capture session later."
            : "Grant permission first using the explicit launch trigger before starting a local capture session.",
        captureSessionResetActionLabel: resetActionLabel,
        captureSessionResetActionHelperText: resetActionHelperText,
        canStartSession: permissionRequestState.status === "granted",
        canStopSession: false,
        canResetRuntime: hasRuntimeArtifacts,
      };
  }
}

function createLiveMeetingPermissionRuntimeDetails(input: {
  permissionReadinessState: LiveMeetingPermissionReadinessState;
  explicitActionGateState: LiveMeetingExplicitActionGateState;
  runtimeBoundaryTriggerState: LiveMeetingRuntimeBoundaryTriggerState;
  permissionRequestState: LiveMeetingPermissionRequestState;
}): LiveMeetingPermissionRuntimeDetails {
  const {
    permissionReadinessState,
    explicitActionGateState,
    runtimeBoundaryTriggerState,
    permissionRequestState,
  } = input;
  const permissionRequestStatusLabel = describeLiveMeetingPermissionRequestStatus(
    permissionRequestState.status
  );

  if (permissionRequestState.status === "requesting") {
    return {
      permissionValue: permissionRequestStatusLabel,
      runtimeBoundaryExplanation:
        "Permission request is running from an explicit user click. No capture processing, transcription, or answer generation is active.",
      permissionExplanation:
        "Permission request is running only because you explicitly triggered it. No capture session, transcription, or answer flow is active.",
      permissionCtaHelperText:
        "Permissions are not being requested yet. This disabled CTA marks where a future browser permission step could appear after explicit user action.",
      explicitActionValue: "Requesting",
      explicitActionExplanation:
        "Permission request is running because you explicitly triggered it. No capture processing starts automatically.",
      explicitActionCtaHelperText:
        "Permission request is in progress from an explicit user click.",
      progressionActionBoundaryValue: "Requesting",
      progressionLaunchValue: permissionRequestStatusLabel,
      progressionSessionValue: "Permission Request In Progress / Not Running",
      captureStatusValue: "Permission Request In Progress / Not Running",
      captureStatusExplanation:
        "A user-triggered permission request is in progress. No capture continuation, transcription, or answer generation is active.",
      captureSessionStatusValue: "Permission Request In Progress / Not Running",
      captureSessionHelperText:
        "A permission request is in progress from an explicit user click. No media processing, transcription, or answer generation are active.",
    };
  }

  if (permissionRequestState.status === "granted") {
    const grantedSessionSnapshot = permissionRequestState.grantedSessionSnapshot;
    const grantedTrackSummary = grantedSessionSnapshot
      ? formatLiveMeetingGrantedSessionTrackSummary(grantedSessionSnapshot)
      : "browser-derived stream details";

    return {
      permissionValue: permissionRequestStatusLabel,
      runtimeBoundaryExplanation:
        "Browser permission was granted from an explicit user click. The returned stream was closed locally, and no live capture workflow is active.",
      permissionExplanation:
        "Permission was granted from an explicit user click. The returned stream was closed locally, and no live capture session has started.",
      permissionCtaHelperText:
        "Permission request completed and the returned stream was closed locally. No ongoing capture is active.",
      explicitActionValue: "Permission Granted / Capture Not Started",
      explicitActionExplanation:
        "Permission was granted from an explicit user click. The returned stream was closed locally and capture has not started.",
      explicitActionCtaHelperText:
        "Permission request completed successfully. The returned stream was closed locally without starting a live capture workflow.",
      progressionActionBoundaryValue: "Permission Granted / Capture Not Started",
      progressionLaunchValue: permissionRequestStatusLabel,
      progressionSessionValue: "Permission Granted / Stream Stopped / Not Running",
      captureStatusValue: "Permission Granted / Stream Stopped / Not Running",
      captureStatusExplanation:
        "Permission succeeded from an explicit user click, but the returned stream was stopped immediately and no live capture remains active.",
      captureSessionStatusValue: "Permission Granted / Stream Stopped / Not Running",
      captureSessionHelperText:
        `Permission was granted from an explicit user click. A browser stream was received locally (${grantedTrackSummary}) and stopped immediately. Capture is not currently running, and no transcription or answer generation is active.`,
    };
  }

  if (permissionRequestState.status === "denied") {
    return {
      permissionValue: permissionRequestStatusLabel,
      runtimeBoundaryExplanation:
        "Browser permission was denied or dismissed from an explicit user click. No live capture workflow is active.",
      permissionExplanation:
        "Permission was denied or dismissed from an explicit user click. No live capture session has started.",
      permissionCtaHelperText:
        "Permission request completed without approval. No ongoing capture is active.",
      explicitActionValue: "Permission Denied / Capture Not Started",
      explicitActionExplanation:
        "Permission was denied or dismissed from an explicit user click. Capture has not started.",
      explicitActionCtaHelperText:
        "Permission request completed without approval. You can explicitly try again later.",
      progressionActionBoundaryValue: "Permission Denied / Capture Not Started",
      progressionLaunchValue: permissionRequestStatusLabel,
      progressionSessionValue: "Permission Denied / Not Running",
      captureStatusValue: "Permission Denied / Not Running",
      captureStatusExplanation:
        "Permission was denied or dismissed from an explicit user click, so no capture session is running.",
      captureSessionStatusValue: "Permission Denied / Not Running",
      captureSessionHelperText:
        "Permission was denied or dismissed from an explicit user click. No media streams, transcription, or answer generation are active.",
    };
  }

  if (permissionRequestState.status === "unsupported") {
    return {
      permissionValue: permissionRequestStatusLabel,
      runtimeBoundaryExplanation:
        "This browser does not expose the requested permission path for future capture preparation.",
      permissionExplanation:
        "The required permission request API is unavailable in this browser, so no permission request can run here.",
      permissionCtaHelperText: "This browser cannot run the requested permission path here.",
      explicitActionValue: "Unsupported / Capture Not Started",
      explicitActionExplanation:
        "This browser cannot run the explicit permission request path needed for future capture preparation.",
      explicitActionCtaHelperText:
        "This browser does not support the requested permission path.",
      progressionActionBoundaryValue: "Unsupported / Capture Not Started",
      progressionLaunchValue: permissionRequestStatusLabel,
      progressionSessionValue: "Unsupported / Not Running",
      captureStatusValue: "Unsupported / Not Running",
      captureStatusExplanation:
        "This browser does not support the requested permission path, so no capture session can run here.",
      captureSessionStatusValue: "Unsupported / Not Running",
      captureSessionHelperText:
        "This browser does not support the requested permission path. No media streams, transcription, or answer generation are active.",
    };
  }

  if (permissionRequestState.status === "failed") {
    return {
      permissionValue: permissionRequestStatusLabel,
      runtimeBoundaryExplanation: permissionRequestState.detail,
      permissionExplanation: permissionRequestState.detail,
      permissionCtaHelperText: permissionRequestState.detail,
      explicitActionValue: "Request Failed / Capture Not Started",
      explicitActionExplanation: permissionRequestState.detail,
      explicitActionCtaHelperText: permissionRequestState.detail,
      progressionActionBoundaryValue: "Request Failed / Capture Not Started",
      progressionLaunchValue: permissionRequestStatusLabel,
      progressionSessionValue: "Request Failed / Not Running",
      captureStatusValue: "Request Failed / Not Running",
      captureStatusExplanation: permissionRequestState.detail,
      captureSessionStatusValue: "Request Failed / Not Running",
      captureSessionHelperText: `${permissionRequestState.detail} No media streams, transcription, or answer generation are active.`,
    };
  }

  const runtimeBoundaryExplanation =
    runtimeBoundaryTriggerState === "user-triggered-not-requesting"
      ? "User trigger recorded locally. Permissions are still not being requested, and future live capture still waits for later permission/capture implementation."
      : "Future permission and capture progression remains blocked until an explicit user-triggered launch step happens later in this browser.";

  return {
    permissionValue: describeLiveMeetingPermissionReadinessState(permissionReadinessState),
    runtimeBoundaryExplanation,
    permissionExplanation:
      runtimeBoundaryTriggerState === "user-triggered-not-requesting"
        ? "User trigger recorded locally. Permissions are still not being requested yet, and future live capture still waits for later permission/capture implementation."
        : "Permissions are not being requested yet. Future live capture stays blocked until explicit user action later in a supported browser.",
    permissionCtaHelperText:
      "Permissions are not being requested yet. This disabled CTA marks where a future browser permission step could appear after explicit user action.",
    explicitActionValue:
      runtimeBoundaryTriggerState === "user-triggered-not-requesting"
        ? describeLiveMeetingRuntimeBoundaryTriggerState(runtimeBoundaryTriggerState)
        : describeLiveMeetingExplicitActionGateState(explicitActionGateState),
    explicitActionExplanation:
      runtimeBoundaryTriggerState === "user-triggered-not-requesting"
        ? "User trigger recorded locally. This runtime boundary is now staged, but no permissions are being requested and no capture is starting yet."
        : runtimeBoundaryExplanation,
    explicitActionCtaHelperText:
      runtimeBoundaryTriggerState === "user-triggered-not-requesting"
        ? "User trigger recorded locally. This shell stays non-requesting and non-capturing until later permission/capture implementation exists."
        : "This launch trigger responds only by recording a local user action boundary. It does not request permissions or start capture today.",
    progressionActionBoundaryValue:
      runtimeBoundaryTriggerState === "user-triggered-not-requesting"
        ? describeLiveMeetingRuntimeBoundaryTriggerState(runtimeBoundaryTriggerState)
        : describeLiveMeetingExplicitActionGateState(explicitActionGateState),
    progressionLaunchValue:
      runtimeBoundaryTriggerState === "user-triggered-not-requesting"
        ? describeLiveMeetingRuntimeBoundaryTriggerState(runtimeBoundaryTriggerState)
        : "Not Yet Triggered",
    progressionSessionValue: "Not Started",
    captureStatusValue: "Inactive / Not Started",
    captureStatusExplanation:
      "No capture is running, and no permissions are being requested. Future live capture depends on browser support plus explicit user action later.",
    captureSessionStatusValue: "Not started",
    captureSessionHelperText:
      "This is a structural home for a future browser-local capture session. No media streams, transcription, or answer generation exist yet.",
  };
}

function createLiveMeetingCapabilityViewModel(
  capabilityTrack: LiveMeetingCapabilityTrack,
  interactionScaffoldingState: LiveMeetingInteractionScaffoldingState,
  browserMediaCapabilityState: LiveMeetingBrowserMediaCapabilityState,
  runtimeBoundaryTriggerState: LiveMeetingRuntimeBoundaryTriggerState,
  permissionRequestState: LiveMeetingPermissionRequestState,
  sessionRuntimeState: LiveMeetingSessionRuntimeState,
  transcriptSessionState: LiveMeetingTranscriptSessionState,
  transcriptRuntimeState: LiveMeetingTranscriptRuntimeState,
  answerRuntimeState: LiveMeetingAnswerRuntimeState,
  verificationObservationState: LiveMeetingRuntimeVerificationObservationState
): LiveMeetingCapabilityViewModel {
  const statusDetails: LiveMeetingCapabilityStatusDetails = {
    meetingSourceDetail: normalizeLiveMeetingCapabilityPlaceholderDetail(
    `${capabilityTrack.meetingSource.provider} source placeholder`
    ),
    tabShareIntentDetail: normalizeLiveMeetingCapabilityPlaceholderDetail(
    `${capabilityTrack.tabShareIntent.target} placeholder`
    ),
    transcriptStreamDetail: normalizeLiveMeetingCapabilityPlaceholderDetail(
      capabilityTrack.transcriptStream.mode
    ),
    speakerSegmentsDetail: normalizeLiveMeetingCapabilityPlaceholderDetail(
      capabilityTrack.speakerSegments.strategy
    ),
    humanAnswerOutputDetail: normalizeLiveMeetingCapabilityPlaceholderDetail(
      capabilityTrack.humanAnswerOutput.mode
    ),
  };
  const placeholderItems = createLiveMeetingCapabilityPlaceholderItems(statusDetails);
  const outputInteractionItems = createLiveMeetingOutputInteractionItems(statusDetails);
  const captureIntentState: LiveMeetingCaptureIntentState =
    interactionScaffoldingState.sourceSelectorValue &&
    browserMediaCapabilityState.hasMediaDevices &&
    browserMediaCapabilityState.hasDisplayMedia &&
    browserMediaCapabilityState.hasMediaRecorder
      ? "ready-later"
      : interactionScaffoldingState.sourceSelectorValue
      ? "blocked-by-permission-later"
        : "not-started";
  const permissionReadinessState: LiveMeetingPermissionReadinessState =
    captureIntentState === "ready-later"
      ? "required-later"
      : interactionScaffoldingState.sourceSelectorValue
        ? "blocked-until-user-action"
        : "not-requested";
  const explicitActionGateState: LiveMeetingExplicitActionGateState =
    captureIntentState === "ready-later"
      ? "action-required"
      : interactionScaffoldingState.sourceSelectorValue
        ? "waiting-for-user"
        : "unavailable-until-triggered";
  const permissionRuntimeDetails = createLiveMeetingPermissionRuntimeDetails({
    permissionReadinessState,
    explicitActionGateState,
    runtimeBoundaryTriggerState,
    permissionRequestState,
  });
  const sessionRuntimeDetails = createLiveMeetingSessionRuntimeDetails({
    sessionRuntimeState,
    permissionRequestState,
    transcriptSessionState,
    transcriptRuntimeState,
    answerRuntimeState,
    verificationObservationState,
  });
  const progressionSteps: LiveMeetingCaptureProgressionStep[] = [
    {
      label: "Intent",
      value: describeLiveMeetingCaptureIntentState(captureIntentState),
    },
    {
      label: "Permissions",
      value: permissionRuntimeDetails.permissionValue,
    },
    {
      label: "Action Boundary",
      value: permissionRuntimeDetails.progressionActionBoundaryValue,
    },
    {
      label: "Launch",
      value: permissionRuntimeDetails.progressionLaunchValue,
    },
    {
      label: "Session",
      value: sessionRuntimeDetails.progressionSessionValue,
    },
  ];
  const captureProgressionBase = {
    runtimeBoundaryStateLabel: "Trigger State",
    runtimeBoundaryStateValue: describeLiveMeetingRuntimeBoundaryTriggerState(
      runtimeBoundaryTriggerState
    ),
    runtimeBoundaryImplementationValue: "Waiting For Later Permission / Capture Implementation",
    runtimeBoundaryExplanation: permissionRuntimeDetails.runtimeBoundaryExplanation,
    intentLabel: "Capture Intent",
    intentValue: describeLiveMeetingCaptureIntentState(captureIntentState),
    permissionLabel: "Permission Readiness",
    permissionValue: permissionRuntimeDetails.permissionValue,
    permissionExplanation: permissionRuntimeDetails.permissionExplanation,
    permissionCtaTitle: "Permission Step Placeholder",
    permissionCtaLabel: "Permission Request Placeholder",
    permissionCtaHelperText: permissionRuntimeDetails.permissionCtaHelperText,
    explicitActionLabel: "Explicit Action Boundary",
    explicitActionValue: permissionRuntimeDetails.explicitActionValue,
    explicitActionExplanation: permissionRuntimeDetails.explicitActionExplanation,
    explicitActionCtaTitle: "Launch Trigger Placeholder",
    explicitActionCtaLabel: "Launch Capture Placeholder",
    explicitActionCtaHelperText: permissionRuntimeDetails.explicitActionCtaHelperText,
    readinessLabel: "Capture Progression State",
    readinessValue: sessionRuntimeDetails.captureStatusValue,
    inactiveExplanation: sessionRuntimeDetails.captureStatusExplanation,
    ctaTitle: "Pre-Capture Action Placeholder",
    ctaLabel: "Capture Action Placeholder",
    ctaHelperText: sessionRuntimeDetails.captureStatusExplanation,
    sessionTitle: "Local Capture Session Placeholder",
    sessionStatusLabel: "Session State",
    sessionStatusValue: sessionRuntimeDetails.captureSessionStatusValue,
    sessionHelperText:
      "This is a structural home for a future browser-local capture session. No media streams, transcription, or answer generation exist yet.",
    progressionTitle: "Capture Progression Indicator",
    progressionSteps,
    isDisabled: true,
  } as const;
  const captureReadinessBase = {
    title: "Browser Capture Readiness",
    capabilityLabel:
      browserMediaCapabilityState.hasMediaDevices &&
      browserMediaCapabilityState.hasDisplayMedia &&
      browserMediaCapabilityState.hasMediaRecorder
        ? "Browser APIs detected locally"
        : "Browser APIs incomplete or unavailable locally",
    sourceSelectionReadiness: interactionScaffoldingState.sourceSelectorValue
      ? "Placeholder source staged locally"
      : "No placeholder source staged yet",
    permissionStatus: captureProgressionBase.permissionValue,
    captureStatus: captureProgressionBase.readinessValue,
    explanation: captureProgressionBase.inactiveExplanation,
  } satisfies Omit<LiveMeetingCaptureReadinessViewModel, "items" | "shouldRenderCluster">;
  const captureReadinessItems = createLiveMeetingCaptureReadinessItems(captureReadinessBase);
  const stagedActivationBase = {
    readinessLabel: "Live Meeting Readiness",
    readinessValue: "Planned / Inactive / Not Connected",
    inactiveExplanation:
      "This future lane is staged only. No meeting source is connected, and no capture, permissions, transcription, or answer flow is active.",
    ctaLabel: "Activation Path Placeholder",
    ctaHelperText:
      "Planned only. This disabled CTA marks where future browser-local setup steps could appear without starting anything today.",
    isDisabled: true,
  } satisfies Omit<LiveMeetingStagedActivationViewModel, "items" | "shouldRenderShell">;
  const stagedActivationItems = createLiveMeetingStagedActivationItems(stagedActivationBase);
  const preCaptureActionBase = {
    title: captureProgressionBase.ctaTitle,
    readinessLabel: captureProgressionBase.readinessLabel,
    readinessValue: captureProgressionBase.readinessValue,
    helperText: captureProgressionBase.ctaHelperText,
    actionLabel: captureProgressionBase.ctaLabel,
    isDisabled: captureProgressionBase.isDisabled,
  } satisfies Omit<LiveMeetingPreCaptureActionViewModel, "items" | "shouldRenderShell">;
  const preCaptureActionItems = createLiveMeetingPreCaptureActionItems(preCaptureActionBase);
  const preCaptureAction = {
    ...preCaptureActionBase,
    items: preCaptureActionItems,
    shouldRenderShell:
      normalizeLiveMeetingCapabilityPlaceholderDetail(preCaptureActionBase.title) !== null &&
      preCaptureActionItems.length > 0,
  } satisfies LiveMeetingPreCaptureActionViewModel;
  const captureProgressionIndicator = {
    title: captureProgressionBase.progressionTitle,
    intentLabel: captureProgressionBase.intentLabel,
    intentValue: captureProgressionBase.intentValue,
    steps: captureProgressionBase.progressionSteps.filter(
      (step: LiveMeetingCaptureProgressionStep) =>
        normalizeLiveMeetingCapabilityPlaceholderDetail(step.label) !== null &&
        normalizeLiveMeetingCapabilityPlaceholderDetail(step.value) !== null
    ),
    shouldRenderShell:
      normalizeLiveMeetingCapabilityPlaceholderDetail(captureProgressionBase.progressionTitle) !==
        null &&
      captureProgressionBase.progressionSteps.length > 0,
  } satisfies LiveMeetingCaptureProgressionIndicatorViewModel;
  const permissionReadiness = {
    title: captureProgressionBase.permissionCtaTitle,
    stateLabel: captureProgressionBase.permissionLabel,
    stateValue: captureProgressionBase.permissionValue,
    explanation: captureProgressionBase.permissionExplanation,
    ctaLabel: captureProgressionBase.permissionCtaLabel,
    ctaHelperText: captureProgressionBase.permissionCtaHelperText,
    isDisabled: captureProgressionBase.isDisabled,
    shouldRenderShell:
      normalizeLiveMeetingCapabilityPlaceholderDetail(captureProgressionBase.permissionCtaTitle) !==
        null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(captureProgressionBase.permissionLabel) !==
        null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(captureProgressionBase.permissionValue) !==
        null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.permissionExplanation
      ) !== null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(captureProgressionBase.permissionCtaLabel) !==
        null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.permissionCtaHelperText
      ) !== null,
  } satisfies LiveMeetingPermissionReadinessViewModel;
  const explicitActionGate = {
    title: captureProgressionBase.explicitActionCtaTitle,
    stateLabel: captureProgressionBase.explicitActionLabel,
    stateValue: captureProgressionBase.explicitActionValue,
    explanation: captureProgressionBase.explicitActionExplanation,
    ctaLabel: captureProgressionBase.explicitActionCtaLabel,
    ctaHelperText: captureProgressionBase.explicitActionCtaHelperText,
    isDisabled:
      permissionRequestState.status === "requesting" || sessionRuntimeState.status === "active",
    shouldRenderShell:
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.explicitActionCtaTitle
      ) !== null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.explicitActionLabel
      ) !== null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.explicitActionValue
      ) !== null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.explicitActionExplanation
      ) !== null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.explicitActionCtaLabel
      ) !== null &&
      normalizeLiveMeetingCapabilityPlaceholderDetail(
        captureProgressionBase.explicitActionCtaHelperText
      ) !== null,
  } satisfies LiveMeetingExplicitActionGateViewModel;

  return {
    ...statusDetails,
    title: "Live Meeting Capability Placeholder",
    narrativeIntro:
      "Planned only. No live capture, tab sharing, transcription, speaker separation, or answer generation is active in this browser-local shell yet.",
    narrativeCategoriesText:
      "This section surfaces future meeting source, tab-share intent, transcript stream, speaker segments, and human-answer output categories only.",
    statusBadgeLabel: "Not active yet",
    captureProgressionSectionTitle: "Future Capture Progression",
    captureReadiness: {
      ...captureReadinessBase,
      items: captureReadinessItems,
      shouldRenderCluster: captureReadinessItems.length > 0,
    },
    captureProgressionIndicator,
    permissionReadiness,
    explicitActionGate,
    preCaptureAction,
    captureSessionPlaceholder: {
      title: captureProgressionBase.sessionTitle,
      statusLabel: captureProgressionBase.sessionStatusLabel,
      statusValue: captureProgressionBase.sessionStatusValue,
      helperText: sessionRuntimeDetails.captureSessionHelperText,
      verificationTitle: sessionRuntimeDetails.captureSessionVerificationTitle,
      verificationStateText: sessionRuntimeDetails.captureSessionVerificationStateText,
      verificationHelperText: sessionRuntimeDetails.captureSessionVerificationHelperText,
      verificationItems: sessionRuntimeDetails.captureSessionVerificationItems,
      metadataText: sessionRuntimeDetails.captureSessionMetadataText,
      observationText: sessionRuntimeDetails.captureSessionObservationText,
      audioReadinessText: sessionRuntimeDetails.captureSessionAudioReadinessText,
      transcriptReadinessText: sessionRuntimeDetails.captureSessionTranscriptReadinessText,
      transcriptBoundaryText: sessionRuntimeDetails.captureSessionTranscriptBoundaryText,
      transcriptRuntimeText: sessionRuntimeDetails.captureSessionTranscriptRuntimeText,
      transcriptRuntimeEventText:
        sessionRuntimeDetails.captureSessionTranscriptRuntimeEventText,
      transcriptInputTitle: sessionRuntimeDetails.captureSessionTranscriptInputTitle,
      transcriptInputPlaceholder:
        sessionRuntimeDetails.captureSessionTranscriptInputPlaceholder,
      transcriptInputActionLabel:
        sessionRuntimeDetails.captureSessionTranscriptInputActionLabel,
      transcriptInputHelperText:
        sessionRuntimeDetails.captureSessionTranscriptInputHelperText,
      canIngestTranscriptInput: sessionRuntimeDetails.canIngestTranscriptInput,
      transcriptIngestionStateText:
        sessionRuntimeDetails.captureSessionTranscriptIngestionStateText,
      transcriptReviewTitle: sessionRuntimeDetails.captureSessionTranscriptReviewTitle,
      transcriptReviewStateText:
        sessionRuntimeDetails.captureSessionTranscriptReviewStateText,
      transcriptReviewEmptyText:
        sessionRuntimeDetails.captureSessionTranscriptReviewEmptyText,
      transcriptReviewLines: sessionRuntimeDetails.captureSessionTranscriptReviewLines,
      transcriptChunkSummaryText:
        sessionRuntimeDetails.captureSessionTranscriptChunkSummaryText,
      transcriptChunks: sessionRuntimeDetails.captureSessionTranscriptChunks,
      answerReadinessTitle:
        sessionRuntimeDetails.captureSessionAnswerReadinessTitle,
      answerReadinessStateText:
        sessionRuntimeDetails.captureSessionAnswerReadinessStateText,
      answerReadinessHelperText:
        sessionRuntimeDetails.captureSessionAnswerReadinessHelperText,
      answerPreparationStateText:
        sessionRuntimeDetails.captureSessionAnswerPreparationStateText,
      answerPreparationContextItems:
        sessionRuntimeDetails.captureSessionAnswerPreparationContextItems,
      answerRuntimeStateText:
        sessionRuntimeDetails.captureSessionAnswerRuntimeStateText,
      answerRuntimeHelperText:
        sessionRuntimeDetails.captureSessionAnswerRuntimeHelperText,
      answerPreparationLabel:
        sessionRuntimeDetails.captureSessionAnswerPreparationLabel,
      answerPreparationHelperText:
        sessionRuntimeDetails.captureSessionAnswerPreparationHelperText,
      canPrepareAnswer: sessionRuntimeDetails.canPrepareAnswer,
      answerDraftTitle: sessionRuntimeDetails.captureSessionAnswerDraftTitle,
      answerDraftStateText: sessionRuntimeDetails.captureSessionAnswerDraftStateText,
      answerDraftHelperText: sessionRuntimeDetails.captureSessionAnswerDraftHelperText,
      answerDraftReviewStateText:
        sessionRuntimeDetails.captureSessionAnswerDraftReviewStateText,
      answerDraftReviewEmptyText:
        sessionRuntimeDetails.captureSessionAnswerDraftReviewEmptyText,
      answerDraftContextItems:
        sessionRuntimeDetails.captureSessionAnswerDraftContextItems,
      answerDraftSurfaceTitle:
        sessionRuntimeDetails.captureSessionAnswerDraftSurfaceTitle,
      answerDraftSurfaceText:
        sessionRuntimeDetails.captureSessionAnswerDraftSurfaceText,
      transcriptStartTitle: sessionRuntimeDetails.captureSessionTranscriptStartTitle,
      transcriptStartLabel: sessionRuntimeDetails.captureSessionTranscriptStartLabel,
      transcriptStartHelperText: sessionRuntimeDetails.captureSessionTranscriptStartHelperText,
      canStartTranscript: sessionRuntimeDetails.canStartTranscript,
      stopReasonText: sessionRuntimeDetails.captureSessionStopReasonText,
      actionHelperText: sessionRuntimeDetails.captureSessionActionHelperText,
      startActionLabel: "Start Local Capture Session",
      stopActionLabel: "Stop Local Capture Session",
      resetActionLabel: sessionRuntimeDetails.captureSessionResetActionLabel,
      resetActionHelperText:
        sessionRuntimeDetails.captureSessionResetActionHelperText,
      canStartSession: sessionRuntimeDetails.canStartSession,
      canStopSession: sessionRuntimeDetails.canStopSession,
      canResetRuntime: sessionRuntimeDetails.canResetRuntime,
    },
    stagedActivation: {
      ...stagedActivationBase,
      items: stagedActivationItems,
      shouldRenderShell: stagedActivationItems.length > 0,
    },
    interactionSectionTitle: "Future Interaction Placeholders",
    outputInteractionSectionTitle: "Future Output Interaction Placeholders",
    sourceSelector: {
      label: "Meeting Source Selector Placeholder",
      helperText:
        "Planned only. No meeting source integration, capture, or permission flow is running yet.",
      selectedValue: interactionScaffoldingState.sourceSelectorValue,
      options: [
        { label: "Zoom", value: "zoom" },
        { label: "Microsoft Teams", value: "teams" },
        { label: "Google Meet", value: "google-meet" },
        { label: "Browser Tab / Other", value: "browser-tab-other" },
      ],
      isDisabled: true,
    },
    tabShareIntentPlaceholder: {
      label: "Tab Share Intent Placeholder",
      helperText:
        "Planned only. No browser-tab permission request, media capture, or tab-share integration is running yet.",
      actionLabel: "Prepare Browser Tab Intent",
      stagedIntentValue: interactionScaffoldingState.tabShareIntentValue,
      isDisabled: true,
    },
    placeholderItems,
    outputInteractionItems,
    shouldRenderStatusCluster: placeholderItems.length > 0,
    shouldRenderOutputInteractionCluster: outputInteractionItems.length > 0,
  };
}

function renderLiveMeetingCapabilityStatusCluster(
  placeholderItems: LiveMeetingCapabilityPlaceholderItem[]
) {
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {placeholderItems.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl border border-cyan-200 bg-white px-4 py-3"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
              {item.label}
            </p>
            <span className="rounded-full bg-cyan-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-800">
              Placeholder
            </span>
          </div>
          <p className="mt-2 text-sm font-medium text-cyan-950">{item.detail}</p>
        </div>
      ))}
    </div>
  );
}

function renderLiveMeetingStagedActivationShell(
  stagedActivation: LiveMeetingStagedActivationViewModel
) {
  const shouldRenderStagedActivationShell = stagedActivation.shouldRenderShell;

  if (!shouldRenderStagedActivationShell) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
            {stagedActivation.readinessLabel}
          </p>
          <p className="mt-2 text-sm font-medium text-cyan-950">
            {stagedActivation.readinessValue}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {stagedActivation.inactiveExplanation}
          </p>
        </div>
        <button
          type="button"
          disabled={stagedActivation.isDisabled}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {stagedActivation.ctaLabel}
        </button>
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{stagedActivation.ctaHelperText}</p>
    </div>
  );
}

function renderLiveMeetingCaptureReadinessShell(
  captureReadiness: LiveMeetingCaptureReadinessViewModel
) {
  const shouldRenderCaptureReadinessCluster = captureReadiness.shouldRenderCluster;

  if (!shouldRenderCaptureReadinessCluster) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {captureReadiness.title}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {captureReadiness.items.map((item) => (
          <div
            key={item.kind}
            className="rounded-2xl border border-cyan-200 bg-cyan-50 px-3 py-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
              {item.label}
            </p>
            <p className="mt-2 text-sm font-medium text-cyan-950">{item.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{captureReadiness.explanation}</p>
    </div>
  );
}

function renderLiveMeetingPreCaptureActionShell(
  preCaptureAction: LiveMeetingPreCaptureActionViewModel
) {
  const shouldRenderPreCaptureActionShell = preCaptureAction.shouldRenderShell;

  if (!shouldRenderPreCaptureActionShell) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {preCaptureAction.title}
      </p>
      {renderLiveMeetingPreCaptureActionContent(preCaptureAction.items)}
    </div>
  );
}

function renderLiveMeetingPreCaptureActionContent(
  preCaptureActionItems: LiveMeetingPreCaptureActionItem[]
) {
  return preCaptureActionItems.map((item) => {
    if (item.kind === "readiness") {
      return (
        <p key={item.kind} className="mt-2 text-sm font-medium text-cyan-950">
          {item.label}: {item.value}
        </p>
      );
    }

    if (item.kind === "helper-text") {
      return (
        <p key={item.kind} className="mt-3 text-xs leading-6 text-cyan-800">
          {item.text}
        </p>
      );
    }

    return (
      <button
        key={item.kind}
        type="button"
        disabled={item.isDisabled}
        className="mt-3 rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
      >
        {item.label}
      </button>
    );
  });
}

function renderLiveMeetingCaptureProgressionIndicatorShell(
  captureProgressionIndicator: LiveMeetingCaptureProgressionIndicatorViewModel
) {
  const shouldRenderCaptureProgressionIndicatorShell =
    captureProgressionIndicator.shouldRenderShell;

  if (!shouldRenderCaptureProgressionIndicatorShell) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {captureProgressionIndicator.title}
      </p>
      <p className="mt-2 text-sm font-medium text-cyan-950">
        {captureProgressionIndicator.intentLabel}: {captureProgressionIndicator.intentValue}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {captureProgressionIndicator.steps.map((step) => (
          <div key={step.label} className="rounded-2xl border border-cyan-200 bg-cyan-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
              {step.label}
            </p>
            <p className="mt-2 text-sm font-medium text-cyan-950">{step.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderLiveMeetingPermissionReadinessShell(
  permissionReadiness: LiveMeetingPermissionReadinessViewModel
) {
  const shouldRenderPermissionReadinessShell = permissionReadiness.shouldRenderShell;

  if (!shouldRenderPermissionReadinessShell) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
            {permissionReadiness.title}
          </p>
          <p className="mt-2 text-sm font-medium text-cyan-950">
            {permissionReadiness.stateLabel}: {permissionReadiness.stateValue}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {permissionReadiness.explanation}
          </p>
        </div>
        <button
          type="button"
          disabled={permissionReadiness.isDisabled}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {permissionReadiness.ctaLabel}
        </button>
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{permissionReadiness.ctaHelperText}</p>
    </div>
  );
}

function renderLiveMeetingExplicitActionGateShell(
  explicitActionGate: LiveMeetingExplicitActionGateViewModel,
  onTriggerLaunchBoundary: () => void
) {
  const shouldRenderExplicitActionGateShell = explicitActionGate.shouldRenderShell;

  if (!shouldRenderExplicitActionGateShell) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      {renderLiveMeetingExplicitActionGateContent(
        explicitActionGate,
        onTriggerLaunchBoundary
      )}
    </div>
  );
}

function renderLiveMeetingExplicitActionGateContent(
  explicitActionGate: LiveMeetingExplicitActionGateViewModel,
  onTriggerLaunchBoundary: () => void
) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
            {explicitActionGate.title}
          </p>
          <p className="mt-2 text-sm font-medium text-cyan-950">
            {explicitActionGate.stateLabel}: {explicitActionGate.stateValue}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {explicitActionGate.explanation}
          </p>
        </div>
        <button
          type="button"
          onClick={onTriggerLaunchBoundary}
          disabled={explicitActionGate.isDisabled}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {explicitActionGate.ctaLabel}
        </button>
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{explicitActionGate.ctaHelperText}</p>
    </>
  );
}

function renderLiveMeetingCaptureSessionPlaceholderShell(
  captureSessionPlaceholder: LiveMeetingCaptureSessionPlaceholderViewModel,
  transcriptInputDraft: string,
  onChangeTranscriptInputDraft: (value: string) => void,
  onIngestTranscriptInput: () => void,
  onTriggerAnswerPreparation: () => void,
  onStartSession: () => void,
  onStopSession: () => void,
  onTriggerTranscriptStart: () => void,
  onResetRuntime: () => void
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {captureSessionPlaceholder.title}
      </p>
      <p className="mt-3 text-sm font-medium text-cyan-950">
        {captureSessionPlaceholder.statusLabel}: {captureSessionPlaceholder.statusValue}
      </p>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.helperText}
      </p>
      {renderLiveMeetingRuntimeVerificationShell(captureSessionPlaceholder)}
      {captureSessionPlaceholder.metadataText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          Session Metadata: {captureSessionPlaceholder.metadataText}
        </p>
      ) : null}
      {captureSessionPlaceholder.observationText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          Track Observation: {captureSessionPlaceholder.observationText}
        </p>
      ) : null}
      {captureSessionPlaceholder.audioReadinessText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          {captureSessionPlaceholder.audioReadinessText}
        </p>
      ) : null}
      {captureSessionPlaceholder.transcriptReadinessText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          {captureSessionPlaceholder.transcriptReadinessText}
        </p>
      ) : null}
      {captureSessionPlaceholder.transcriptBoundaryText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          {captureSessionPlaceholder.transcriptBoundaryText}
        </p>
      ) : null}
      {captureSessionPlaceholder.transcriptRuntimeText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          {captureSessionPlaceholder.transcriptRuntimeText}
        </p>
      ) : null}
      <div className="mt-4 rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
          {captureSessionPlaceholder.transcriptInputTitle}
        </p>
        <textarea
          className="mt-3 min-h-24 w-full rounded-2xl border border-cyan-200 bg-white px-4 py-3 text-sm text-cyan-950 placeholder:text-cyan-500 disabled:cursor-not-allowed"
          value={transcriptInputDraft}
          onChange={(event) => onChangeTranscriptInputDraft(event.target.value)}
          placeholder={captureSessionPlaceholder.transcriptInputPlaceholder}
          disabled={!captureSessionPlaceholder.canIngestTranscriptInput}
        />
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onIngestTranscriptInput}
            disabled={!captureSessionPlaceholder.canIngestTranscriptInput}
            className="rounded-full border border-cyan-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
          >
            {captureSessionPlaceholder.transcriptInputActionLabel}
          </button>
        </div>
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          {captureSessionPlaceholder.transcriptInputHelperText}
        </p>
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          {captureSessionPlaceholder.transcriptIngestionStateText}
        </p>
      {captureSessionPlaceholder.transcriptChunkSummaryText ? (
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {captureSessionPlaceholder.transcriptChunkSummaryText}
          </p>
        ) : null}
        {renderLiveMeetingTranscriptReviewShell(captureSessionPlaceholder)}
      </div>
      {renderLiveMeetingAnswerPreparationShell(
        captureSessionPlaceholder,
        onTriggerAnswerPreparation
      )}
      {renderLiveMeetingAnswerDraftShell(captureSessionPlaceholder)}
      {captureSessionPlaceholder.stopReasonText ? (
        <p className="mt-3 text-xs leading-6 text-cyan-800">
          Ended Reason: {captureSessionPlaceholder.stopReasonText}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onStartSession}
          disabled={!captureSessionPlaceholder.canStartSession}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {captureSessionPlaceholder.startActionLabel}
        </button>
        <button
          type="button"
          onClick={onStopSession}
          disabled={!captureSessionPlaceholder.canStopSession}
          className="rounded-full border border-cyan-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {captureSessionPlaceholder.stopActionLabel}
        </button>
        <button
          type="button"
          onClick={onTriggerTranscriptStart}
          disabled={!captureSessionPlaceholder.canStartTranscript}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {captureSessionPlaceholder.transcriptStartLabel}
        </button>
        <button
          type="button"
          onClick={onResetRuntime}
          disabled={!captureSessionPlaceholder.canResetRuntime}
          className="rounded-full border border-cyan-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {captureSessionPlaceholder.resetActionLabel}
        </button>
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.actionHelperText}
      </p>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.transcriptStartTitle}:{" "}
        {captureSessionPlaceholder.transcriptStartHelperText}
      </p>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.resetActionHelperText}
      </p>
    </div>
  );
}

function renderLiveMeetingRuntimeVerificationShell(
  captureSessionPlaceholder: LiveMeetingCaptureSessionPlaceholderViewModel
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {captureSessionPlaceholder.verificationTitle}
      </p>
      <p className="mt-2 text-sm font-medium text-cyan-950">
        {captureSessionPlaceholder.verificationStateText}
      </p>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.verificationHelperText}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {captureSessionPlaceholder.verificationItems.map((item) => (
          <div
            key={item.key}
            className="rounded-2xl border border-cyan-200 bg-white px-3 py-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
              {item.label}
            </p>
            <p className="mt-2 text-sm font-medium text-cyan-950">{item.statusLabel}</p>
            <p className="mt-2 text-xs leading-6 text-cyan-800">{item.detail}</p>
            {item.observedAtText ? (
              <p className="mt-2 text-[11px] font-medium text-cyan-700">{item.observedAtText}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderLiveMeetingTranscriptReviewShell(
  captureSessionPlaceholder: LiveMeetingCaptureSessionPlaceholderViewModel
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
          {captureSessionPlaceholder.transcriptReviewTitle}
        </p>
        {captureSessionPlaceholder.transcriptChunkSummaryText ? (
          <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-800">
            {captureSessionPlaceholder.transcriptChunks.length} chunk
            {captureSessionPlaceholder.transcriptChunks.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.transcriptReviewStateText}
      </p>
      {captureSessionPlaceholder.transcriptRuntimeEventText ? (
        renderLiveMeetingTranscriptReviewRuntimeEvent(
          captureSessionPlaceholder.transcriptRuntimeEventText
        )
      ) : null}
      {captureSessionPlaceholder.transcriptReviewLines.length > 0 ? (
        <div className="mt-3 space-y-3">
          {captureSessionPlaceholder.transcriptReviewLines.map((line) =>
            renderLiveMeetingTranscriptReviewRow(line)
          )}
        </div>
      ) : (
        renderLiveMeetingTranscriptReviewEmptyState(
          captureSessionPlaceholder.transcriptReviewEmptyText
        )
      )}
    </div>
  );
}

function renderLiveMeetingTranscriptReviewRuntimeEvent(runtimeEventText: string) {
  return (
    <div className="mt-3 rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        Latest Runtime Event
      </p>
      <p className="mt-2 text-xs leading-6 text-cyan-800">{runtimeEventText}</p>
    </div>
  );
}

function renderLiveMeetingTranscriptReviewRow(
  line: LiveMeetingTranscriptReviewLineViewModel
) {
  return (
    <div
      key={line.id}
      className="rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-cyan-200 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-800">
          {line.typeBadgeLabel}
        </span>
        <span className="rounded-full border border-cyan-200 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-800">
          {line.sourceBadgeLabel}
        </span>
        <span className="text-[11px] font-medium text-cyan-800">{line.timestampText}</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-cyan-950">
        {line.text}
      </p>
    </div>
  );
}

function renderLiveMeetingTranscriptReviewEmptyState(emptyText: string) {
  return <p className="mt-3 text-xs leading-6 text-cyan-800">{emptyText}</p>;
}

function renderLiveMeetingAnswerPreparationShell(
  captureSessionPlaceholder: LiveMeetingCaptureSessionPlaceholderViewModel,
  onTriggerAnswerPreparation: () => void
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
            {captureSessionPlaceholder.answerReadinessTitle}
          </p>
          <p className="mt-2 text-sm font-medium text-cyan-950">
            {captureSessionPlaceholder.answerReadinessStateText}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {captureSessionPlaceholder.answerReadinessHelperText}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {captureSessionPlaceholder.answerPreparationStateText}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {captureSessionPlaceholder.answerRuntimeStateText}
          </p>
          <p className="mt-3 text-xs leading-6 text-cyan-800">
            {captureSessionPlaceholder.answerRuntimeHelperText}
          </p>
        </div>
        <button
          type="button"
          onClick={onTriggerAnswerPreparation}
          disabled={!captureSessionPlaceholder.canPrepareAnswer}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
        >
          {captureSessionPlaceholder.answerPreparationLabel}
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {captureSessionPlaceholder.answerPreparationContextItems.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-cyan-200 bg-cyan-50 px-3 py-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
              {item.label}
            </p>
            <p className="mt-2 text-sm font-medium text-cyan-950">{item.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.answerPreparationHelperText}
      </p>
    </div>
  );
}

function renderLiveMeetingAnswerDraftShell(
  captureSessionPlaceholder: LiveMeetingCaptureSessionPlaceholderViewModel
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {captureSessionPlaceholder.answerDraftTitle}
      </p>
      <p className="mt-2 text-sm font-medium text-cyan-950">
        {captureSessionPlaceholder.answerDraftStateText}
      </p>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.answerDraftHelperText}
      </p>
      <p className="mt-3 text-xs leading-6 text-cyan-800">
        {captureSessionPlaceholder.answerDraftReviewStateText}
      </p>
      {renderLiveMeetingAnswerDraftContextGrid(
        captureSessionPlaceholder.answerDraftContextItems
      )}
      {renderLiveMeetingAnswerDraftSurface(
        captureSessionPlaceholder.answerDraftSurfaceTitle,
        captureSessionPlaceholder.answerDraftSurfaceText,
        captureSessionPlaceholder.answerDraftReviewEmptyText
      )}
    </div>
  );
}

function renderLiveMeetingAnswerDraftContextGrid(
  answerDraftContextItems: LiveMeetingAnswerPreparationContextItem[]
) {
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      {answerDraftContextItems.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl border border-cyan-200 bg-cyan-50 px-3 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
            {item.label}
          </p>
          <p className="mt-2 text-sm font-medium text-cyan-950">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function renderLiveMeetingAnswerDraftSurface(
  title: string,
  bodyText: string | null,
  emptyText: string
) {
  return (
    <div className="mt-3 rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {title}
      </p>
      {bodyText ? (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-cyan-950">
          {bodyText}
        </p>
      ) : (
        renderLiveMeetingAnswerDraftEmptyState(emptyText)
      )}
    </div>
  );
}

function renderLiveMeetingAnswerDraftEmptyState(emptyText: string) {
  return <p className="mt-3 text-xs leading-6 text-cyan-800">{emptyText}</p>;
}

function renderLiveMeetingSourceSelectorPlaceholder(
  sourceSelector: LiveMeetingSourceSelectorViewModel
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <label className="block">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
          {sourceSelector.label}
        </p>
        <select
          className="mt-3 w-full rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-950"
          value={sourceSelector.selectedValue}
          disabled={sourceSelector.isDisabled}
          aria-label={sourceSelector.label}
          onChange={() => {
            // Placeholder-only selector with no side effects.
          }}
        >
          {sourceSelector.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{sourceSelector.helperText}</p>
    </div>
  );
}

function renderLiveMeetingTabShareIntentPlaceholder(
  tabShareIntentPlaceholder: LiveMeetingTabShareIntentPlaceholderViewModel
) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {tabShareIntentPlaceholder.label}
      </p>
      <p className="mt-3 text-sm font-medium text-cyan-950">
        {tabShareIntentPlaceholder.stagedIntentValue}
      </p>
      <button
        type="button"
        disabled={tabShareIntentPlaceholder.isDisabled}
        className="mt-3 rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
      >
        {tabShareIntentPlaceholder.actionLabel}
      </button>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{tabShareIntentPlaceholder.helperText}</p>
    </div>
  );
}

function renderLiveMeetingOutputInteractionCluster(
  outputInteractionItems: LiveMeetingOutputInteractionItem[]
) {
  return (
    <div className="mt-4">
      <div className="grid gap-3 lg:grid-cols-3">
        {outputInteractionItems.map((item) => renderLiveMeetingOutputInteractionRow(item))}
      </div>
    </div>
  );
}

function renderLiveMeetingOutputInteractionRow(item: LiveMeetingOutputInteractionItem) {
  return (
    <div key={item.label} className="rounded-2xl border border-cyan-200 bg-white px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
        {item.label}
      </p>
      <p className="mt-3 text-sm font-medium text-cyan-950">{item.detail}</p>
      <button
        type="button"
        disabled={item.isDisabled}
        className="mt-3 rounded-full border border-cyan-200 bg-cyan-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800 disabled:cursor-not-allowed disabled:opacity-100"
      >
        {item.actionLabel}
      </button>
      <p className="mt-3 text-xs leading-6 text-cyan-800">{item.helperText}</p>
    </div>
  );
}

function renderLiveMeetingCapabilityPlaceholderShell(
  liveMeetingCapabilityViewModel: LiveMeetingCapabilityViewModel,
  transcriptInputDraft: string,
  onChangeTranscriptInputDraft: (value: string) => void,
  onIngestTranscriptInput: () => void,
  onTriggerAnswerPreparation: () => void,
  onTriggerLaunchBoundary: () => void,
  onStartSession: () => void,
  onStopSession: () => void,
  onTriggerTranscriptStart: () => void,
  onResetRuntime: () => void
) {
  const shouldRenderSourceSelectorPlaceholder = true;
  const shouldRenderTabShareIntentPlaceholder = true;
  const shouldRenderStatusCluster = liveMeetingCapabilityViewModel.shouldRenderStatusCluster;
  const shouldRenderOutputInteractionCluster =
    liveMeetingCapabilityViewModel.shouldRenderOutputInteractionCluster;

  return (
    <div className="mt-5 rounded-3xl border border-cyan-200 bg-cyan-50 px-5 py-4 text-sm text-cyan-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{liveMeetingCapabilityViewModel.title}</p>
          <p className="mt-2 leading-7">{liveMeetingCapabilityViewModel.narrativeIntro}</p>
          <p className="mt-2 leading-7">
            {liveMeetingCapabilityViewModel.narrativeCategoriesText}
          </p>
        </div>
        <span className="rounded-full border border-cyan-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800">
          {liveMeetingCapabilityViewModel.statusBadgeLabel}
        </span>
      </div>
      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
          {liveMeetingCapabilityViewModel.captureProgressionSectionTitle}
        </p>
        {renderLiveMeetingCaptureReadinessShell(liveMeetingCapabilityViewModel.captureReadiness)}
        {renderLiveMeetingCaptureProgressionIndicatorShell(
          liveMeetingCapabilityViewModel.captureProgressionIndicator
        )}
        {renderLiveMeetingPermissionReadinessShell(
          liveMeetingCapabilityViewModel.permissionReadiness
        )}
        {renderLiveMeetingExplicitActionGateShell(
          liveMeetingCapabilityViewModel.explicitActionGate,
          onTriggerLaunchBoundary
        )}
        {renderLiveMeetingPreCaptureActionShell(liveMeetingCapabilityViewModel.preCaptureAction)}
        {renderLiveMeetingCaptureSessionPlaceholderShell(
          liveMeetingCapabilityViewModel.captureSessionPlaceholder,
          transcriptInputDraft,
          onChangeTranscriptInputDraft,
          onIngestTranscriptInput,
          onTriggerAnswerPreparation,
          onStartSession,
          onStopSession,
          onTriggerTranscriptStart,
          onResetRuntime
        )}
        {renderLiveMeetingStagedActivationShell(liveMeetingCapabilityViewModel.stagedActivation)}
      </div>
      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
          {liveMeetingCapabilityViewModel.interactionSectionTitle}
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {shouldRenderSourceSelectorPlaceholder
            ? renderLiveMeetingSourceSelectorPlaceholder(
                liveMeetingCapabilityViewModel.sourceSelector
              )
            : null}
          {shouldRenderTabShareIntentPlaceholder
            ? renderLiveMeetingTabShareIntentPlaceholder(
                liveMeetingCapabilityViewModel.tabShareIntentPlaceholder
              )
            : null}
        </div>
      </div>
      {shouldRenderStatusCluster
        ? renderLiveMeetingCapabilityStatusCluster(liveMeetingCapabilityViewModel.placeholderItems)
        : null}
      {shouldRenderOutputInteractionCluster ? (
        <div className="mt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
            {liveMeetingCapabilityViewModel.outputInteractionSectionTitle}
          </p>
          {renderLiveMeetingOutputInteractionCluster(
            liveMeetingCapabilityViewModel.outputInteractionItems
          )}
        </div>
      ) : null}
    </div>
  );
}

type DecisionSnapshotSelection = {
  candidateId: string;
  timestamp: number;
};

type DecisionTimelineReplayabilityFilter = "all" | "replayable-only";

// Replay banner local view-model and render helpers.
const REPLAY_BANNER_EXIT_LABEL = "Exit Replay To Live View";

type ReplayBannerStatusField = {
  label: string;
  value: string;
};

type ReplayBannerViewModel = {
  snapshotTimeLabel: string | null;
  narrativeSnapshotTimestampText: string;
  statusFields: ReplayBannerStatusField[];
  shouldRenderStatusCluster: boolean;
};

function formatReplayBannerSnapshotTimeLabel(snapshotTimestamp: number | null | undefined) {
  if (!snapshotTimestamp) {
    return null;
  }

  const formattedTimestamp = new Date(snapshotTimestamp).toLocaleString();
  return formattedTimestamp === "Invalid Date" ? null : formattedTimestamp;
}

function formatReplayBannerCompareTargetLabel(activeCompareTargetId: string | null) {
  return activeCompareTargetId ? "Present" : null;
}

function formatReplayBannerFocusedLabel(focusedCandidateIds: string[]) {
  return focusedCandidateIds.length > 0 ? String(focusedCandidateIds.length) : null;
}

function createReplayBannerStatusItems(
  replayMode: ReplayModeState | null,
  snapshotTimeLabel: string | null
): ReplayBannerStatusField[] {
  if (!replayMode) {
    return [];
  }

  const focusedLabel = formatReplayBannerFocusedLabel(replayMode.replayContext.focusedCandidateIds);
  const compareTargetLabel = formatReplayBannerCompareTargetLabel(
    replayMode.replayContext.activeCompareTargetId
  );

  return [
    replayMode.candidateId
      ? {
          label: "Snapshot Candidate",
          value: replayMode.candidateId,
        }
      : null,
    snapshotTimeLabel
      ? {
          label: "Snapshot Time",
          value: snapshotTimeLabel,
        }
      : null,
    focusedLabel
      ? {
          label: "Focused",
          value: focusedLabel,
        }
      : null,
    compareTargetLabel
      ? {
          label: "Compare Target",
          value: compareTargetLabel,
        }
      : null,
  ].filter((item): item is ReplayBannerStatusField => item !== null);
}

function createReplayBannerViewModel(replayMode: ReplayModeState | null): ReplayBannerViewModel {
  const snapshotTimeLabel = formatReplayBannerSnapshotTimeLabel(replayMode?.snapshotTimestamp);
  const statusFields = createReplayBannerStatusItems(replayMode, snapshotTimeLabel);

  return {
    snapshotTimeLabel,
    narrativeSnapshotTimestampText: snapshotTimeLabel
      ? ` captured at ${snapshotTimeLabel}`
      : "",
    statusFields,
    shouldRenderStatusCluster: statusFields.length > 0,
  };
}

function renderReplayBannerStatusCluster(statusFields: ReplayBannerStatusField[]) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {statusFields.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl border border-amber-200 bg-white px-3 py-2"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
            {item.label}
          </p>
          <p className="mt-1 text-sm font-semibold text-amber-950">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function renderReplayBannerExitButton(onExitReplayMode: () => void) {
  return (
    <button
      type="button"
      onClick={onExitReplayMode}
      className="rounded-full border border-amber-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-900 transition hover:border-amber-500"
    >
      {REPLAY_BANNER_EXIT_LABEL}
    </button>
  );
}

function renderReplayBannerShell(
  replayBannerViewModel: ReplayBannerViewModel,
  onExitReplayMode: () => void
) {
  return (
    <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Historical Context Replay</p>
          {replayBannerViewModel.shouldRenderStatusCluster
            ? renderReplayBannerStatusCluster(replayBannerViewModel.statusFields)
            : null}
          <p className="mt-2 leading-7">
            Historical replay is active for the replayed decision snapshot
            {replayBannerViewModel.narrativeSnapshotTimestampText}. This is an inspect-only
            historical view. Live local workspace content is not being changed while replay is
            active, including notes, refs, and baseline history.
          </p>
          <p className="mt-2 leading-7">
            Live-changing actions stay locked while this historical replay is active.{" "}
            {REPLAY_BANNER_EXIT_LABEL} returns you to the saved live local view.
          </p>
        </div>
        {renderReplayBannerExitButton(onExitReplayMode)}
      </div>
    </div>
  );
}

function renderReplayBannerSection(
  replayBannerViewModel: ReplayBannerViewModel,
  shouldRenderReplayBanner: boolean,
  onExitReplayMode: () => void
) {
  return shouldRenderReplayBanner
    ? renderReplayBannerShell(replayBannerViewModel, onExitReplayMode)
    : null;
}

function describeBaselineHistorySortMode(sortMode: BaselineHistorySortMode) {
  switch (sortMode) {
    case "oldest-first":
      return "oldest-first";
    case "note-present-first":
      return "note-present-first";
    case "current-first":
      return "current-first";
    case "newest-first":
    default:
      return "newest-first";
  }
}

function sortBaselineHistoryEntries<
  TEntry extends {
    id: string;
    capturedAt: number;
    note: string;
  },
>(
  entries: TEntry[],
  sortMode: BaselineHistorySortMode,
  currentCapturedAt: number | null
) {
  return [...entries].sort((left, right) => {
    const leftIsCurrent = currentCapturedAt === left.capturedAt;
    const rightIsCurrent = currentCapturedAt === right.capturedAt;

    switch (sortMode) {
      case "oldest-first":
        return left.capturedAt - right.capturedAt;
      case "note-present-first":
        if (Boolean(left.note.trim()) !== Boolean(right.note.trim())) {
          return left.note.trim() ? -1 : 1;
        }
        return right.capturedAt - left.capturedAt;
      case "current-first":
        if (leftIsCurrent !== rightIsCurrent) {
          return leftIsCurrent ? -1 : 1;
        }
        return right.capturedAt - left.capturedAt;
      case "newest-first":
      default:
        return right.capturedAt - left.capturedAt;
    }
  });
}

function partitionBaselineHistoryByFocus<
  TEntry extends {
    id: string;
  },
>(entries: TEntry[], focusedEntryIds: string[]) {
  const focusedEntryIdSet = new Set(focusedEntryIds);

  return {
    quickFocusEntries: entries.filter((entry) => focusedEntryIdSet.has(entry.id)),
    remainingEntries: entries.filter((entry) => !focusedEntryIdSet.has(entry.id)),
  };
}

const WORKSPACE_DEMO_QUESTION =
  "What would you automate first if you inherited this workflow?";

const WORKSPACE_DEMO_ANSWER_DIRECTION = [
  "Lead with the highest-leverage repetitive handoff first, usually intake triage or status routing, because that is where manual effort and operational risk compound fastest.",
  "Explain that the first automation choice should reduce repetitive work while improving reliability and observability, so failures become measurable instead of hidden in inboxes or spreadsheets.",
  "Close by saying you would instrument the workflow early, watch exceptions, and expand from the first stable win once the team trusts the automation path.",
].join("\n\n");

const WORKSPACE_DEMO_TRANSCRIPTION_SCENARIO: LocalTranscriptionScenario = {
  transcript: [
    `Incoming recruiter question: ${WORKSPACE_DEMO_QUESTION}`,
    "Local review context: The workflow has repetitive spreadsheet updates, manual status follow-ups, and no clear exception visibility when handoffs fail.",
  ].join("\n"),
  latestSegment:
    "Local review context: The workflow has repetitive spreadsheet updates, manual status follow-ups, and no clear exception visibility when handoffs fail.",
  segments: [
    {
      id: "demo-segment-question",
      chunkIndex: 0,
      text: `Incoming recruiter question: ${WORKSPACE_DEMO_QUESTION}`,
      source: "microphone",
      createdAt: 1711710000000,
    },
    {
      id: "demo-segment-context",
      chunkIndex: 1,
      text:
        "Local review context: The workflow has repetitive spreadsheet updates, manual status follow-ups, and no clear exception visibility when handoffs fail.",
      source: "microphone",
      createdAt: 1711710060000,
    },
  ],
  selectedFileName: "local-demo-recruiter-call.txt",
  feedback:
    "Loaded deterministic browser-local demo state for a recruiter-style live call. No backend, cloud memory, or hidden orchestration was used.",
};

type SessionWorkspaceShellProps = {
  demoMode?: boolean;
};

export function SessionWorkspaceShell({
  demoMode = false,
}: SessionWorkspaceShellProps = {}) {
  const initialWorkspaceState = useMemo(
    () => ({
      mode: "consultation" as SessionMode,
      goal: "Prepare a working copilot session without activating backend orchestration yet.",
      selectedPromptRefs: [PROMPT_REFERENCE_CANDIDATES[0]],
      selectedTranscriptRefs: [TRANSCRIPT_REFERENCE_CANDIDATES[0]],
      executionStatus: "idle" as SessionExecutionStatus,
      draftUserTurn: "",
      stagedTurns: [],
      assistantPlaceholder: null,
      draftNote: "",
      draftNoteType: "freeform" as SessionNoteRecord["type"],
      stagedNotes: [],
    }),
    []
  );
  const [sessionContextId] = useState(() => createStableId("session-context"));
  const [sessionExecutionId] = useState(() => createStableId("session-execution"));
  const [handoffCopyState, setHandoffCopyState] = useState<"idle" | "copied">("idle");
  const [exportCopyState, setExportCopyState] = useState<"idle" | "copied">("idle");
  const [importValue, setImportValue] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [comparisonTemplateId, setComparisonTemplateId] = useState<string | null>(null);
  const [comparisonBaselineHistoryId, setComparisonBaselineHistoryId] = useState<string | null>(
    null
  );
  const [activeCompareTargetId, setActiveCompareTargetId] = useState<string | null>(null);
  const [decisionSnapshots, setDecisionSnapshots] = useState<DecisionSnapshot[]>([]);
  const [selectedDecisionSnapshot, setSelectedDecisionSnapshot] =
    useState<DecisionSnapshotSelection | null>(null);
  const [decisionTimelineCandidateQuery, setDecisionTimelineCandidateQuery] = useState("");
  const [decisionTimelineReplayabilityFilter, setDecisionTimelineReplayabilityFilter] =
    useState<DecisionTimelineReplayabilityFilter>("all");
  const [replayMode, setReplayMode] = useState<ReplayModeState | null>(null);
  const [liveMeetingSourceSelectorValue] = useState("zoom");
  const [liveMeetingTabShareIntentValue] = useState("browser-tab");
  const [liveMeetingRuntimeBoundaryTriggerState, setLiveMeetingRuntimeBoundaryTriggerState] =
    useState<LiveMeetingRuntimeBoundaryTriggerState>("not-yet-triggered");
  const [liveMeetingPermissionRequestState, setLiveMeetingPermissionRequestState] =
    useState<LiveMeetingPermissionRequestState>(createInitialLiveMeetingPermissionRequestState);
  const [liveMeetingSessionRuntimeState, setLiveMeetingSessionRuntimeState] =
    useState<LiveMeetingSessionRuntimeState>(createInitialLiveMeetingSessionRuntimeState);
  const [liveMeetingTranscriptSessionState, setLiveMeetingTranscriptSessionState] =
    useState<LiveMeetingTranscriptSessionState>(createInitialLiveMeetingTranscriptSessionState);
  const [liveMeetingTranscriptRuntimeState, setLiveMeetingTranscriptRuntimeState] =
    useState<LiveMeetingTranscriptRuntimeState>(createInitialLiveMeetingTranscriptRuntimeState);
  const [liveMeetingAnswerRuntimeState, setLiveMeetingAnswerRuntimeState] =
    useState<LiveMeetingAnswerRuntimeState>(createInitialLiveMeetingAnswerRuntimeState);
  const [liveMeetingRuntimeVerificationObservationState, setLiveMeetingRuntimeVerificationObservationState] =
    useState<LiveMeetingRuntimeVerificationObservationState>({});
  const [liveMeetingTranscriptInputDraft, setLiveMeetingTranscriptInputDraft] = useState("");
  const [liveMeetingBrowserMediaCapability, setLiveMeetingBrowserMediaCapability] =
    useState<LiveMeetingBrowserMediaCapabilityState>({
      hasMediaDevices: false,
      hasDisplayMedia: false,
      hasUserMedia: false,
      hasMediaRecorder: false,
    });
  const workspaceTranscriptionWorkflow = useTranscriptionWorkflow({
    repositoryMode: "local-only",
  });
  const liveMeetingActiveSessionStreamRef = useRef<MediaStream | null>(null);
  const lastAppliedTranscriptRecoveryRef = useRef<number | null>(null);
  const demoStateAppliedRef = useRef(false);

  function resetLiveMeetingDerivedRuntimeLane() {
    setLiveMeetingTranscriptSessionState(createInitialLiveMeetingTranscriptSessionState());
    setLiveMeetingTranscriptRuntimeState(createInitialLiveMeetingTranscriptRuntimeState());
    setLiveMeetingAnswerRuntimeState(createInitialLiveMeetingAnswerRuntimeState());
    setLiveMeetingTranscriptInputDraft("");
  }

  const recordLiveMeetingVerificationObservation = useCallback(
    (
    target: LiveMeetingRuntimeVerificationTarget,
    observedAt = Date.now()
    ) => {
      setLiveMeetingRuntimeVerificationObservationState((current) => ({
        ...current,
        [target]: observedAt,
      }));
    },
    []
  );

  function handleResetLiveMeetingRuntimeLane() {
    const resetObservedAt = Date.now();
    const shouldRecordResetAfterAnswerDraft = liveMeetingAnswerRuntimeState.status === "requested";
    liveMeetingActiveSessionStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveMeetingActiveSessionStreamRef.current = null;
    clearTranscriptWorkspaceRecoveryIntent();
    setLiveMeetingRuntimeBoundaryTriggerState("not-yet-triggered");
    setLiveMeetingPermissionRequestState(createInitialLiveMeetingPermissionRequestState());
    setLiveMeetingSessionRuntimeState(createInitialLiveMeetingSessionRuntimeState());
    resetLiveMeetingDerivedRuntimeLane();
    recordLiveMeetingVerificationObservation("session-reset-path", resetObservedAt);

    if (shouldRecordResetAfterAnswerDraft) {
      recordLiveMeetingVerificationObservation(
        "reset-after-answer-draft-path",
        resetObservedAt
      );
    }
  }

  const restoreSavedTranscriptIntoWorkspace = useCallback(
    (record: TranscriptRecord, openedAt: number) => {
      const restoredAt = Math.max(openedAt, Date.now());
      const runtimeChunks = mapSavedTranscriptToRuntimeChunks(record);

      setLiveMeetingRuntimeBoundaryTriggerState("user-triggered-not-requesting");
      setLiveMeetingPermissionRequestState(createInitialLiveMeetingPermissionRequestState());
      setLiveMeetingSessionRuntimeState(
        createRestoredLiveMeetingSessionRuntimeState(record, restoredAt)
      );
      setLiveMeetingTranscriptSessionState(createRestoredLiveMeetingTranscriptSessionState());
      setLiveMeetingTranscriptRuntimeState(
        createRestoredLiveMeetingTranscriptRuntimeState(restoredAt, runtimeChunks)
      );
      setLiveMeetingAnswerRuntimeState(createInitialLiveMeetingAnswerRuntimeState());
      setLiveMeetingTranscriptInputDraft("");
      recordLiveMeetingVerificationObservation("transcript-ingest-path", restoredAt);
      recordLiveMeetingVerificationObservation("transcript-review-path", restoredAt);
      lastAppliedTranscriptRecoveryRef.current = openedAt;
    },
    [recordLiveMeetingVerificationObservation]
  );
  const [baselineHistoryQuery, setBaselineHistoryQuery] = useState("");
  const [baselineHistorySortMode, setBaselineHistorySortMode] =
    useState<BaselineHistorySortMode>("newest-first");
  const [focusedBaselineHistoryIds, setFocusedBaselineHistoryIds] = useState<string[]>([]);
  const [reviewMode, setReviewMode] = useState(false);
  const [baselineNoteDraft, setBaselineNoteDraft] = useState("");
  const [recoveryStatus, setRecoveryStatus] = useState<{
    tone: "idle" | "success" | "warning";
    message: string;
  }>({
    tone: "idle",
    message: "Resetting the local shell will stay browser-local and can be rolled back once if you capture a recovery snapshot first.",
  });
  const [templateStatus, setTemplateStatus] = useState<{
    tone: "idle" | "success" | "error";
    message: string;
  }>({
    tone: "idle",
    message: "Save a reusable browser-local workspace template or load one you already staged here.",
  });
  const [importState, setImportState] = useState<{
    tone: "idle" | "success" | "error";
    message: string;
  }>({
    tone: "idle",
    message: "Paste a previously exported local session payload to restore this browser-only shell.",
  });
  const [ignoredPromptRecommendations, setIgnoredPromptRecommendations] = useState<
    Partial<Record<SessionMode, string[]>>
  >({});
  const [ignoredTranscriptRecommendations, setIgnoredTranscriptRecommendations] = useState<
    Partial<Record<SessionMode, string[]>>
  >({});
  const {
    templates,
    saveTemplate,
    renameTemplate,
    deleteTemplate,
  } = useSessionWorkspaceTemplates();
  const { entries: activityEntries, logActivity, clearActivityLog } =
    useSessionWorkspaceActivityLog();
  const {
    baseline: changeBaseline,
    captureBaseline,
    updateBaselineNote,
    clearBaselineNote,
    history: baselineHistory,
    deleteHistoryEntry,
    clearHistory,
  } =
    useSessionWorkspaceChangeBaseline();
  const {
    isReviewed,
    markReviewed,
    clearReviewed,
    clearAllReviewed,
    reviewedAreas,
  } = useSessionWorkspaceReviewedState(changeBaseline?.capturedAt ?? null);
  const {
    state: {
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
    },
    isHydrated,
    recoverySnapshot,
    setGoal,
    setExecutionStatus,
    setDraftUserTurn,
    setDraftNote,
    setDraftNoteType,
    addPromptRef,
    removePromptRef,
    addTranscriptRef,
    removeTranscriptRef,
    stageTurn,
    clearTurns,
    setAssistantPlaceholder,
    stageNote,
    toggleNoteStatus,
    removeNote,
    clearNotes,
    applyPreset,
    resetState,
    replaceState,
    captureRecoverySnapshot,
    restoreRecoverySnapshot,
    clearRecoverySnapshot,
  } = useSessionWorkspaceState({
    initialState: initialWorkspaceState,
  });
  const workspaceTranscriptRuntimeChunks = useMemo(
    () =>
      mapWorkflowTranscriptSegmentsToRuntimeChunks({
        segments: workspaceTranscriptionWorkflow.segments,
        activeTranscriptRecord: workspaceTranscriptionWorkflow.activeTranscriptRecord,
      }),
    [
      workspaceTranscriptionWorkflow.activeTranscriptRecord,
      workspaceTranscriptionWorkflow.segments,
    ]
  );
  const workspaceSessionRuntimeState = useMemo(
    () =>
      createWorkspaceSessionRuntimeStateFromTranscription({
        status: workspaceTranscriptionWorkflow.status,
        transcriptText: workspaceTranscriptionWorkflow.transcript,
        runtimeChunks: workspaceTranscriptRuntimeChunks,
        activeTranscriptRecord: workspaceTranscriptionWorkflow.activeTranscriptRecord,
      }),
    [
      workspaceTranscriptRuntimeChunks,
      workspaceTranscriptionWorkflow.activeTranscriptRecord,
      workspaceTranscriptionWorkflow.status,
      workspaceTranscriptionWorkflow.transcript,
    ]
  );
  const workspaceTranscriptSessionState = useMemo(
    () =>
      createWorkspaceTranscriptSessionStateFromTranscription({
        status: workspaceTranscriptionWorkflow.status,
        runtimeChunks: workspaceTranscriptRuntimeChunks,
        transcriptText: workspaceTranscriptionWorkflow.transcript,
      }),
    [
      workspaceTranscriptRuntimeChunks,
      workspaceTranscriptionWorkflow.status,
      workspaceTranscriptionWorkflow.transcript,
    ]
  );
  const workspaceTranscriptRuntimeState = useMemo(
    () =>
      createWorkspaceTranscriptRuntimeStateFromTranscription({
        status: workspaceTranscriptionWorkflow.status,
        transcriptText: workspaceTranscriptionWorkflow.transcript,
        runtimeChunks: workspaceTranscriptRuntimeChunks,
        activeTranscriptRecord: workspaceTranscriptionWorkflow.activeTranscriptRecord,
      }),
    [
      workspaceTranscriptRuntimeChunks,
      workspaceTranscriptionWorkflow.activeTranscriptRecord,
      workspaceTranscriptionWorkflow.status,
      workspaceTranscriptionWorkflow.transcript,
    ]
  );

  useEffect(() => {
    setBaselineNoteDraft(changeBaseline?.note ?? "");
  }, [changeBaseline?.capturedAt, changeBaseline?.note]);

  useEffect(() => {
    if (!isHydrated) return;

    writeReadyStatePreferences({
      roleMode: mode,
      layout: "Launch-ready",
      accentMode: "Accent-robust English",
    });
  }, [isHydrated, mode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaDevices = navigator.mediaDevices;

    setLiveMeetingBrowserMediaCapability({
      hasMediaDevices: Boolean(mediaDevices),
      hasDisplayMedia: typeof mediaDevices?.getDisplayMedia === "function",
      hasUserMedia: typeof mediaDevices?.getUserMedia === "function",
      hasMediaRecorder: typeof MediaRecorder !== "undefined",
    });
  }, []);

  const workspaceTranscriptIsRecording = workspaceTranscriptionWorkflow.isRecording;
  const startWorkspaceTranscriptCapture = workspaceTranscriptionWorkflow.startCapture;
  const stopWorkspaceTranscriptCapture = workspaceTranscriptionWorkflow.stopCapture;
  const workspaceTranscriptCanUseTranscript = workspaceTranscriptionWorkflow.canUseTranscript;

  useEffect(() => {
    const activeStream = liveMeetingActiveSessionStreamRef.current;
    const hasActiveLiveSession =
      liveMeetingSessionRuntimeState.status === "active" &&
      liveMeetingSessionRuntimeState.metadata.audioTrackCount > 0 &&
      Boolean(activeStream);

    if (hasActiveLiveSession && !workspaceTranscriptIsRecording) {
      void startWorkspaceTranscriptCapture({
        existingStream: activeStream ?? undefined,
        source: "system-audio",
      });
      return;
    }

    if (!hasActiveLiveSession && workspaceTranscriptIsRecording) {
      stopWorkspaceTranscriptCapture();
    }
  }, [
    liveMeetingSessionRuntimeState.metadata.audioTrackCount,
    liveMeetingSessionRuntimeState.status,
    startWorkspaceTranscriptCapture,
    stopWorkspaceTranscriptCapture,
    workspaceTranscriptIsRecording,
  ]);

  useEffect(() => {
    if (workspaceTranscriptCanUseTranscript) {
      return;
    }

    setLiveMeetingAnswerRuntimeState(createInitialLiveMeetingAnswerRuntimeState());
  }, [workspaceTranscriptCanUseTranscript]);

  useEffect(() => {
    if (!demoMode || demoStateAppliedRef.current) {
      return;
    }

    demoStateAppliedRef.current = true;
    replaceState({
      mode: "meeting-copilot",
      goal:
        "Run a browser-local recruiter-style live call demo that shows incoming question review and concise response direction without backend orchestration.",
      selectedPromptRefs: [
        PROMPT_REFERENCE_CANDIDATES[3],
        PROMPT_REFERENCE_CANDIDATES[4],
      ],
      selectedTranscriptRefs: [
        {
          transcriptId: "local-demo-recruiter-call",
          title: "Local Demo Recruiter Call",
          status: "completed",
          excerptText: WORKSPACE_DEMO_QUESTION,
          excerptSegmentIds: WORKSPACE_DEMO_TRANSCRIPTION_SCENARIO.segments.map(
            (segment) => segment.id
          ),
          snapshotVersion: 1,
        },
      ],
      executionStatus: "ready",
      draftUserTurn: "",
      stagedTurns: [],
      assistantPlaceholder: null,
      draftNote:
        "Demo mode is browser-local only. Incoming side shows the recruiter question. Response side shows concise answer direction only.",
      draftNoteType: "decision",
      stagedNotes: [
        {
          id: "demo-note-live-call",
          type: "decision",
          content:
            "Demo framing: lead with the highest-leverage automation first, then explain reliability, observability, and repetitive manual work.",
          status: "open",
          createdAt: 1711710120000,
        },
      ],
    });
    workspaceTranscriptionWorkflow.loadLocalScenario(WORKSPACE_DEMO_TRANSCRIPTION_SCENARIO);
    setLiveMeetingAnswerRuntimeState({
      status: "requested",
      detail:
        "A deterministic browser-local demo answer direction was staged from the local review context. No generated answer content, backend execution, or hidden orchestration was used.",
      hasUserTriggeredPrepare: true,
      draftBodyText: WORKSPACE_DEMO_ANSWER_DIRECTION,
    });
    setRecoveryStatus({
      tone: "success",
      message:
        "Browser-local demo mode loaded. This recruiter-style scenario is deterministic and does not use backend calls, cloud memory, or streaming.",
    });
    recordLiveMeetingVerificationObservation("transcript-review-path", 1711710060000);
    recordLiveMeetingVerificationObservation("answer-preparation-path", 1711710120000);
    recordLiveMeetingVerificationObservation("answer-draft-path", 1711710120000);
  }, [
    demoMode,
    recordLiveMeetingVerificationObservation,
    replaceState,
    workspaceTranscriptionWorkflow,
  ]);

  useEffect(() => {
    const recoveryIntent = readTranscriptWorkspaceRecoveryIntent();
    if (!recoveryIntent) {
      return;
    }

    if (lastAppliedTranscriptRecoveryRef.current === recoveryIntent.openedAt) {
      return;
    }

    const savedTranscript = getLocalStoredTranscriptById(recoveryIntent.transcriptId);
    if (!savedTranscript) {
      return;
    }

    restoreSavedTranscriptIntoWorkspace(savedTranscript, recoveryIntent.openedAt);
  }, [restoreSavedTranscriptIntoWorkspace]);

  useEffect(() => {
    return () => {
      const activeSessionStream = liveMeetingActiveSessionStreamRef.current;

      if (!activeSessionStream) {
        return;
      }

      const videoTrackCount = activeSessionStream.getVideoTracks().length;
      const audioTrackCount = activeSessionStream.getAudioTracks().length;
      const streamId = activeSessionStream.id;
      activeSessionStream.getTracks().forEach((track) => track.stop());
      liveMeetingActiveSessionStreamRef.current = null;
      setLiveMeetingSessionRuntimeState((current) =>
        current.status === "active"
          ? {
              status: "stopped",
              detail: `The local browser capture session was stopped during cleanup (${formatLiveMeetingSessionTrackSummary(
                {
                  videoTrackCount,
                  audioTrackCount,
                }
              )}, stream ${streamId}). Transcription may run in the transcript lane, and answer generation is not active.`,
              metadata: {
                streamId,
                videoTrackCount,
                audioTrackCount,
                startedAt: current.metadata.startedAt,
                sourceKind: "display-media",
              },
              observation: {
                hasVideoTrack: videoTrackCount > 0,
                hasAudioTrack: audioTrackCount > 0,
                videoTrackEnabled: videoTrackCount > 0 ? false : null,
                audioTrackEnabled: audioTrackCount > 0 ? false : null,
                videoTrackReadyState: videoTrackCount > 0 ? "ended" : null,
                audioTrackReadyState: audioTrackCount > 0 ? "ended" : null,
              },
              stopReason: "stopped-on-cleanup",
            }
          : current
      );
      setLiveMeetingTranscriptRuntimeState((current) =>
        current.status === "active" || current.status === "requested"
          ? {
              ...current,
              status: "stopped",
              detail:
                "Local transcript runtime input stopped because the capture session ended during browser cleanup.",
              events: (
                [
                  {
                    kind: "stopped",
                    message:
                      "Local transcript runtime input stopped because the capture session ended during browser cleanup.",
                    timestamp: Date.now(),
                  } satisfies LiveMeetingTranscriptRuntimeEvent,
                  ...current.events,
                ] satisfies LiveMeetingTranscriptRuntimeEvent[]
              ).slice(0, 5),
            }
          : current
      );
    };
  }, []);

  const validBaselineHistoryIds = useMemo(
    () => new Set(baselineHistory.map((entry) => entry.id)),
    [baselineHistory]
  );

  useEffect(() => {
    setFocusedBaselineHistoryIds((current) =>
      current.filter((entryId) => validBaselineHistoryIds.has(entryId))
    );
    setComparisonBaselineHistoryId((current) =>
      current && validBaselineHistoryIds.has(current) ? current : null
    );
    setActiveCompareTargetId((current) =>
      current && validBaselineHistoryIds.has(current) ? current : null
    );
    setDecisionSnapshots((current) =>
      current.filter((snapshot) => validBaselineHistoryIds.has(snapshot.candidateId))
    );
    setSelectedDecisionSnapshot((current) =>
      current && validBaselineHistoryIds.has(current.candidateId) ? current : null
    );
    setReplayMode((current) =>
      current
        ? {
            ...current,
            liveContext: normalizeReplayLiveContext(current.liveContext, validBaselineHistoryIds),
            replayContext: normalizeReplayComparisonContext(
              current.replayContext,
              validBaselineHistoryIds
            ),
          }
        : null
    );
  }, [validBaselineHistoryIds]);

  function handleStageDraftTurn() {
    if (isReplayMode) return;
    const normalizedDraft = draftUserTurn.trim();
    if (!normalizedDraft) return;

    const nextTurn: SessionTurnRecord = {
      id: createStableId("turn"),
      sessionExecutionId,
      role: "user",
      content: normalizedDraft,
      promptRefs: selectedPromptRefs,
      transcriptRefs: selectedTranscriptRefs,
      createdAt: Date.now(),
    };

    stageTurn(nextTurn);
    setExecutionStatus("ready");
    setAssistantPlaceholder({
      sessionExecutionId,
      turnId: nextTurn.id,
      status: "ready",
      answer:
        "Assistant execution is not connected yet. This placeholder shows where a backend response envelope will attach later.",
      answerMode: "general",
      suggestedFollowups: [
        "Connect backend session execution runtime",
        "Stream answer tokens into the workspace shell",
      ],
      source: "local",
    } satisfies SessionAnswerResponse);
  }

  function handleStageNote() {
    if (isReplayMode) return;
    const normalizedNote = draftNote.trim();
    if (!normalizedNote) return;

    stageNote({
      id: createStableId("note"),
      type: draftNoteType,
      content: normalizedNote,
      status: "open",
      createdAt: Date.now(),
    });
  }

  async function handleTriggerLiveMeetingLaunchBoundary() {
    setLiveMeetingRuntimeBoundaryTriggerState("user-triggered-not-requesting");

    if (typeof window === "undefined") {
      return;
    }

    const mediaDevices = navigator.mediaDevices;

    if (typeof mediaDevices?.getDisplayMedia !== "function") {
      setLiveMeetingPermissionRequestState({
        status: "unsupported",
        detail: "Display-capture permission requests are unavailable in this browser.",
        grantedSessionSnapshot: null,
      });
      return;
    }

    setLiveMeetingPermissionRequestState({
      status: "requesting",
      detail: "Permission request is running from an explicit user click.",
      grantedSessionSnapshot: null,
    });

    try {
      const permissionStream = await mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const grantedSessionSnapshot = createLiveMeetingGrantedSessionSnapshot(permissionStream);

      permissionStream.getTracks().forEach((track) => track.stop());

      setLiveMeetingPermissionRequestState({
        status: "granted",
        detail:
          "Display-capture permission was granted from an explicit user click, and the returned stream was closed locally.",
        grantedSessionSnapshot,
      });
      recordLiveMeetingVerificationObservation(
        "permission-granted-but-stopped-path"
      );
      setLiveMeetingSessionRuntimeState({
        status: "granted-but-stopped",
        detail:
          "Permission was granted from an explicit user click, a browser stream was received, and the stream was stopped immediately. No local capture session is currently running.",
        metadata: {
          streamId: grantedSessionSnapshot.streamId,
          videoTrackCount: grantedSessionSnapshot.videoTrackCount,
          audioTrackCount: grantedSessionSnapshot.audioTrackCount,
          startedAt: null,
          sourceKind: "display-media",
        },
        observation: {
          hasVideoTrack: grantedSessionSnapshot.videoTrackCount > 0,
          hasAudioTrack: grantedSessionSnapshot.audioTrackCount > 0,
          videoTrackEnabled: grantedSessionSnapshot.videoTrackCount > 0 ? false : null,
          audioTrackEnabled: grantedSessionSnapshot.audioTrackCount > 0 ? false : null,
          videoTrackReadyState: grantedSessionSnapshot.videoTrackCount > 0 ? "ended" : null,
          audioTrackReadyState: grantedSessionSnapshot.audioTrackCount > 0 ? "ended" : null,
        },
        stopReason: "not-applicable",
      });
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : "UnknownError";

      if (errorName === "NotAllowedError" || errorName === "AbortError") {
        setLiveMeetingPermissionRequestState({
          status: "denied",
          detail:
            "Display-capture permission was denied or dismissed from an explicit user click.",
          grantedSessionSnapshot: null,
        });
        recordLiveMeetingVerificationObservation("permission-denied-path");
        return;
      }

      setLiveMeetingPermissionRequestState({
        status: "failed",
        detail: `Display-capture permission request failed locally with ${errorName}.`,
        grantedSessionSnapshot: null,
      });
    }
  }

  async function handleStartLiveMeetingCaptureSession() {
    if (
      typeof window === "undefined" ||
      liveMeetingPermissionRequestState.status !== "granted" ||
      liveMeetingSessionRuntimeState.status === "active"
    ) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;

    if (typeof mediaDevices?.getDisplayMedia !== "function") {
      setLiveMeetingSessionRuntimeState({
        status: "failed",
        detail:
          "This browser does not support starting a local display-capture session from an explicit user click.",
        metadata: {
          streamId: null,
          videoTrackCount: 0,
          audioTrackCount: 0,
          startedAt: null,
          sourceKind: "display-media",
        },
        observation: {
          hasVideoTrack: false,
          hasAudioTrack: false,
          videoTrackEnabled: null,
          audioTrackEnabled: null,
          videoTrackReadyState: null,
          audioTrackReadyState: null,
        },
        stopReason: "failed",
      });
      return;
    }

    try {
      const isRestartPath =
        liveMeetingSessionRuntimeState.status === "stopped" ||
        liveMeetingSessionRuntimeState.status === "granted-but-stopped" ||
        liveMeetingSessionRuntimeState.status === "failed" ||
        Boolean(liveMeetingRuntimeVerificationObservationState["session-reset-path"]);
      const activeSessionStream = await mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      liveMeetingActiveSessionStreamRef.current?.getTracks().forEach((track) => track.stop());
      liveMeetingActiveSessionStreamRef.current = activeSessionStream;
      resetLiveMeetingDerivedRuntimeLane();

      const videoTrackCount = activeSessionStream.getVideoTracks().length;
      const audioTrackCount = activeSessionStream.getAudioTracks().length;
      const observationSnapshot = createLiveMeetingStreamObservationSnapshot(activeSessionStream);
      const activeSessionDetail = `A local browser capture session is active from an explicit user click (${formatLiveMeetingSessionTrackSummary(
        {
          videoTrackCount,
          audioTrackCount,
        }
      )}, stream ${activeSessionStream.id}). Transcription may run in the transcript lane, and answer generation is not active.`;

      setLiveMeetingSessionRuntimeState({
        status: "active",
        detail: activeSessionDetail,
        metadata: {
          streamId: activeSessionStream.id,
          videoTrackCount,
          audioTrackCount,
          startedAt: Date.now(),
          sourceKind: "display-media",
        },
        observation: observationSnapshot,
        stopReason: "not-applicable",
      });
      recordLiveMeetingVerificationObservation("session-start-path");

      if (isRestartPath) {
        recordLiveMeetingVerificationObservation("session-restart-path");
      }

      activeSessionStream.getTracks().forEach((track) => {
        track.addEventListener(
          "ended",
          () => {
            setLiveMeetingSessionRuntimeState((current) =>
              current.status === "active"
                ? {
                    status: "stopped",
                    detail:
                      "The local browser capture session ended and is no longer running. Answer generation is not active.",
                    metadata: current.metadata,
                    observation: {
                      ...current.observation,
                      videoTrackReadyState: current.observation.hasVideoTrack ? "ended" : null,
                      audioTrackReadyState: current.observation.hasAudioTrack ? "ended" : null,
                    },
                    stopReason: "track-ended",
                  }
                : current
            );
            setLiveMeetingTranscriptRuntimeState((current) =>
              current.status === "active" || current.status === "requested"
                ? {
                    ...current,
                    status: "stopped",
                    detail:
                      "Local transcript runtime input stopped because the active browser capture session ended.",
                    events: (
                      [
                        {
                          kind: "stopped",
                          message:
                            "Local transcript runtime input stopped because the active browser capture session ended.",
                          timestamp: Date.now(),
                        } satisfies LiveMeetingTranscriptRuntimeEvent,
                        ...current.events,
                      ] satisfies LiveMeetingTranscriptRuntimeEvent[]
                    ).slice(0, 5),
                  }
                : current
            );
            liveMeetingActiveSessionStreamRef.current = null;
          },
          { once: true }
        );
      });
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : "UnknownError";

      setLiveMeetingSessionRuntimeState({
        status: "failed",
        detail: `Local capture session start failed from an explicit user click with ${errorName}. Answer generation is not active.`,
        metadata: {
          streamId: null,
          videoTrackCount: 0,
          audioTrackCount: 0,
          startedAt: null,
          sourceKind: "display-media",
        },
        observation: {
          hasVideoTrack: false,
          hasAudioTrack: false,
          videoTrackEnabled: null,
          audioTrackEnabled: null,
          videoTrackReadyState: null,
          audioTrackReadyState: null,
        },
        stopReason: "failed",
      });
    }
  }

  function handleStopLiveMeetingCaptureSession() {
    const activeSessionStream = liveMeetingActiveSessionStreamRef.current;

    if (!activeSessionStream) {
      return;
    }

    const videoTrackCount = activeSessionStream.getVideoTracks().length;
    const audioTrackCount = activeSessionStream.getAudioTracks().length;
    const streamId = activeSessionStream.id;

    activeSessionStream.getTracks().forEach((track) => track.stop());
    liveMeetingActiveSessionStreamRef.current = null;

    setLiveMeetingSessionRuntimeState({
      status: "stopped",
      detail: `The local browser capture session was stopped from an explicit user click (${formatLiveMeetingSessionTrackSummary(
        {
          videoTrackCount,
          audioTrackCount,
        }
      )}, stream ${streamId}). Answer generation is not active.`,
      metadata: {
        streamId,
        videoTrackCount,
        audioTrackCount,
        startedAt: liveMeetingSessionRuntimeState.metadata.startedAt,
        sourceKind: "display-media",
      },
      observation: {
        hasVideoTrack: videoTrackCount > 0,
        hasAudioTrack: audioTrackCount > 0,
        videoTrackEnabled: videoTrackCount > 0 ? false : null,
        audioTrackEnabled: audioTrackCount > 0 ? false : null,
        videoTrackReadyState: videoTrackCount > 0 ? "ended" : null,
        audioTrackReadyState: audioTrackCount > 0 ? "ended" : null,
      },
      stopReason: "stopped-by-user",
    });
    recordLiveMeetingVerificationObservation("session-stop-path");
    setLiveMeetingTranscriptRuntimeState((current) =>
      current.status === "active" || current.status === "requested"
        ? {
            ...current,
            status: "stopped",
            detail:
              "Local transcript runtime input stopped because the capture session was stopped explicitly.",
            events: (
              [
                {
                  kind: "stopped",
                  message:
                    "Local transcript runtime input stopped because the capture session was stopped explicitly.",
                  timestamp: Date.now(),
                } satisfies LiveMeetingTranscriptRuntimeEvent,
                ...current.events,
              ] satisfies LiveMeetingTranscriptRuntimeEvent[]
            ).slice(0, 5),
          }
        : current
    );
  }

  function handleTriggerLiveMeetingTranscriptStartBoundary() {
    const audioReadiness = createLiveMeetingAudioReadinessSnapshot(
      liveMeetingSessionRuntimeState.observation
    );
    const transcriptReadinessState = createLiveMeetingTranscriptReadinessState({
      sessionRuntimeState: liveMeetingSessionRuntimeState,
      audioReadiness,
    });
    const requestedAt = Date.now();

    if (transcriptReadinessState !== "ready-later") {
      setLiveMeetingTranscriptSessionState({
        status: "blocked",
        detail: formatLiveMeetingTranscriptStartHelperText(transcriptReadinessState),
        hasUserTriggeredStart: false,
      });
      setLiveMeetingTranscriptRuntimeState((current) => ({
        status: "unavailable",
        detail:
          "Transcript start was triggered locally, but the current browser-local session is not ready for transcript runtime.",
        events: (
          [
            {
              kind: "unavailable",
              message: formatLiveMeetingTranscriptStartHelperText(transcriptReadinessState),
              timestamp: requestedAt,
            } satisfies LiveMeetingTranscriptRuntimeEvent,
            ...current.events,
          ] satisfies LiveMeetingTranscriptRuntimeEvent[]
        ).slice(0, 5),
        chunks: current.chunks,
      }));
      return;
    }

    setLiveMeetingTranscriptSessionState({
      status: "requested",
      detail:
        "Transcript start was explicitly requested locally. The transcription engine will attach to the active browser stream.",
      hasUserTriggeredStart: true,
    });
    setLiveMeetingTranscriptRuntimeState((current) => ({
      status: "requested",
      detail:
        "A local transcript runtime was explicitly requested and is connecting to the active stream.",
      events: (
        [
          {
            kind: "requested",
            message:
              "Transcript start was explicitly requested locally. Transcription connection is being initialized.",
            timestamp: requestedAt,
          } satisfies LiveMeetingTranscriptRuntimeEvent,
          ...current.events,
        ] satisfies LiveMeetingTranscriptRuntimeEvent[]
      ).slice(0, 5),
      chunks: current.chunks,
    }));

    const activeStream = liveMeetingActiveSessionStreamRef.current;
    if (!activeStream || workspaceTranscriptIsRecording) {
      return;
    }

    void startWorkspaceTranscriptCapture({
      existingStream: activeStream,
      source: "system-audio",
    });
  }

  function handleIngestLiveMeetingTranscriptInput() {
    const normalizedTranscriptInput = liveMeetingTranscriptInputDraft.trim();

    if (
      !normalizedTranscriptInput ||
      liveMeetingSessionRuntimeState.status !== "active" ||
      (liveMeetingTranscriptRuntimeState.status !== "requested" &&
        liveMeetingTranscriptRuntimeState.status !== "active")
    ) {
      return;
    }

    const ingestedAt = Date.now();

    setLiveMeetingTranscriptRuntimeState((current) => {
      const nextChunk: LiveMeetingTranscriptRuntimeChunk = {
        id: `transcript-chunk-${ingestedAt}-${current.chunks.length + 1}`,
        timestamp: ingestedAt,
        text: normalizedTranscriptInput,
        sourceLabel: "Browser-Local Manual Input",
        typeLabel: "Transcript Runtime Chunk",
      };

      return {
        status: "active",
        detail:
          "Local transcript runtime input is active in this browser shell through manually staged runtime chunks only. Answer generation is not active.",
        events: (
          [
            {
              kind: "active",
              message:
                "A local transcript runtime chunk was staged manually from the browser-local transcript input adapter.",
              timestamp: ingestedAt,
            } satisfies LiveMeetingTranscriptRuntimeEvent,
            ...current.events,
          ] satisfies LiveMeetingTranscriptRuntimeEvent[]
        ).slice(0, 5),
        chunks: [nextChunk, ...current.chunks].slice(0, 8),
      };
    });
    recordLiveMeetingVerificationObservation("transcript-ingest-path", ingestedAt);
    recordLiveMeetingVerificationObservation("transcript-review-path", ingestedAt);
    setLiveMeetingTranscriptInputDraft("");
  }

  function handleTriggerLiveMeetingAnswerPreparationBoundary() {
    const transcriptIngestionStatus = createLiveMeetingTranscriptIngestionStatus(
      liveMeetingTranscriptRuntimeState
    );
    const transcriptReviewLines = createLiveMeetingTranscriptReviewLines(
      orderLiveMeetingTranscriptRuntimeChunks(liveMeetingTranscriptRuntimeState.chunks)
    );
    const transcriptReviewStatus = createLiveMeetingTranscriptReviewStatus({
      transcriptIngestionStatus,
      transcriptReviewLines,
    });
    const answerReadinessState = createLiveMeetingAnswerReadinessState({
      sessionRuntimeState: liveMeetingSessionRuntimeState,
      transcriptReviewStatus,
      transcriptReviewLines,
    });

    if (answerReadinessState !== "ready-later") {
      setLiveMeetingAnswerRuntimeState({
        status: "blocked",
        detail:
          answerReadinessState === "blocked-by-no-transcript"
            ? "Answer preparation is blocked until local transcript runtime input is available in the transcript review lane."
            : answerReadinessState === "blocked-by-no-active-session"
              ? "Answer preparation is blocked until a local capture session is active with transcript runtime context available."
              : "Answer preparation is not ready in the current browser-local session state.",
        hasUserTriggeredPrepare: false,
        draftBodyText: null,
      });
      recordLiveMeetingVerificationObservation("answer-preparation-path");
      return;
    }

    setLiveMeetingAnswerRuntimeState({
      status: "requested",
      detail:
        "Answer preparation was explicitly requested locally from the available transcript/runtime context, but answer execution is not implemented or active in this browser shell.",
      hasUserTriggeredPrepare: true,
      draftBodyText: null,
    });
    recordLiveMeetingVerificationObservation("answer-preparation-path");
    recordLiveMeetingVerificationObservation("answer-draft-path");
  }

  function handleTriggerWorkspaceTranscriptAnswerPreparationBoundary() {
    const transcriptIngestionStatus = createLiveMeetingTranscriptIngestionStatus(
      workspaceTranscriptRuntimeState
    );
    const transcriptReviewLines = createLiveMeetingTranscriptReviewLines(
      orderLiveMeetingTranscriptRuntimeChunks(workspaceTranscriptRuntimeState.chunks)
    );
    const transcriptReviewStatus = createLiveMeetingTranscriptReviewStatus({
      transcriptIngestionStatus,
      transcriptReviewLines,
    });
    const answerReadinessState = createLiveMeetingAnswerReadinessState({
      sessionRuntimeState: workspaceSessionRuntimeState,
      transcriptReviewStatus,
      transcriptReviewLines,
    });

    if (answerReadinessState !== "ready-later") {
      setLiveMeetingAnswerRuntimeState({
        status: "blocked",
        detail:
          answerReadinessState === "blocked-by-no-transcript"
            ? "Answer preparation is blocked until browser-local transcript runtime input is available in the workspace review lane."
            : answerReadinessState === "blocked-by-no-active-session"
              ? "Answer preparation is blocked until browser-local transcript runtime context is available in this workspace shell."
              : "Answer preparation is not ready in the current browser-local workspace state.",
        hasUserTriggeredPrepare: false,
        draftBodyText: null,
      });
      recordLiveMeetingVerificationObservation("answer-preparation-path");
      return;
    }

    setLiveMeetingAnswerRuntimeState({
      status: "requested",
      detail:
        "Answer preparation was explicitly requested locally from the shared browser-local transcript runtime, but no answer generation or backend orchestration is active.",
      hasUserTriggeredPrepare: true,
      draftBodyText: null,
    });
    recordLiveMeetingVerificationObservation("answer-preparation-path");
    recordLiveMeetingVerificationObservation("answer-draft-path");
  }

  const sessionContextState = useMemo<SessionContextRecord>(
    () => ({
      id: sessionContextId,
      title: `${mode.replace("-", " ")} workspace session`,
      mode,
      status: "draft",
      goal,
      promptRefs: selectedPromptRefs,
      transcriptRefs: selectedTranscriptRefs,
      attachments: [
        ...selectedPromptRefs.map((ref) => ({ type: "prompt", ref }) as const),
        ...selectedTranscriptRefs.map((ref) => ({ type: "transcript", ref }) as const),
      ],
      recentTurnCount: 0,
      noteCount: 0,
      currentRoute: "/dashboard",
      activePane: "workspace",
      createdAt: 0,
      updatedAt: 0,
      ownerScope: "local-user",
      ownerId: null,
      version: 1,
    }),
    [goal, mode, selectedPromptRefs, selectedTranscriptRefs, sessionContextId]
  );

  const contextPayloadPreview = useMemo(
    () =>
      createSessionContextCreatePayload({
        title: sessionContextState.title,
        mode,
        goal,
        promptRefs: selectedPromptRefs,
        transcriptRefs: selectedTranscriptRefs,
        currentRoute: "/dashboard",
        activePane: "workspace",
      }),
    [goal, mode, selectedPromptRefs, selectedTranscriptRefs, sessionContextState.title]
  );

  const executionState = useMemo<CreateOrResumeSessionResponse>(
    () => ({
      sessionExecutionId,
      sessionContextId,
      mode,
      status: executionStatus,
      turnCount: 0,
      promptRefs: selectedPromptRefs,
      transcriptRefs: selectedTranscriptRefs,
      source: "local",
    }),
    [executionStatus, mode, selectedPromptRefs, selectedTranscriptRefs, sessionContextId, sessionExecutionId]
  );

  const executionRequestPreview = useMemo(
    () =>
      createOrResumeSessionPayload({
        sessionContextId,
        mode,
        title: sessionContextState.title,
        goal,
        promptRefs: selectedPromptRefs,
        transcriptRefs: selectedTranscriptRefs,
        currentRoute: "/dashboard",
      }),
    [goal, mode, selectedPromptRefs, selectedTranscriptRefs, sessionContextId, sessionContextState.title]
  );

  const answerRequestPreview = useMemo(
    () =>
      createRequestSessionAnswerPayload({
        sessionExecutionId,
        sessionContextId,
        message: "No answer request is being executed yet. This is a contract preview only.",
        promptRefs: selectedPromptRefs,
        transcriptRefs: selectedTranscriptRefs,
      }),
    [selectedPromptRefs, selectedTranscriptRefs, sessionContextId, sessionExecutionId]
  );

  const appendTurnPreview = useMemo(
    () =>
      createAppendSessionTurnPayload({
        sessionExecutionId,
        sessionContextId,
        role: "user",
        content: draftUserTurn || "Draft turn will appear here once staged locally.",
        promptRefs: selectedPromptRefs,
        transcriptRefs: selectedTranscriptRefs,
      }),
    [
      draftUserTurn,
      selectedPromptRefs,
      selectedTranscriptRefs,
      sessionContextId,
      sessionExecutionId,
    ]
  );

  const currentWorkspaceState = useMemo(
    () => ({
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
    }),
    [
      assistantPlaceholder,
      draftNote,
      draftNoteType,
      draftUserTurn,
      executionStatus,
      goal,
      mode,
      selectedPromptRefs,
      selectedTranscriptRefs,
      stagedNotes,
      stagedTurns,
    ]
  );

  const comparisonTemplate = useMemo(
    () => templates.find((template) => template.id === comparisonTemplateId) ?? null,
    [comparisonTemplateId, templates]
  );
  const filteredBaselineHistory = useMemo(() => {
    const normalizedQuery = baselineHistoryQuery.trim().toLowerCase();
    if (!normalizedQuery) return baselineHistory;

    return baselineHistory.filter((entry) => {
      const isCurrent = changeBaseline?.capturedAt === entry.capturedAt;
      const haystack = [
        entry.note,
        entry.reason,
        new Date(entry.capturedAt).toLocaleString(),
        isCurrent ? "current" : "previous",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [baselineHistory, baselineHistoryQuery, changeBaseline?.capturedAt]);
  const sortedBaselineHistory = useMemo(() => {
    return sortBaselineHistoryEntries(
      filteredBaselineHistory,
      baselineHistorySortMode,
      changeBaseline?.capturedAt ?? null
    );
  }, [baselineHistorySortMode, changeBaseline?.capturedAt, filteredBaselineHistory]);
  const liveComparisonContext = useMemo<ReplayComparisonContext>(
    () => ({
      focusedCandidateIds: focusedBaselineHistoryIds,
      activeCompareTargetId,
    }),
    [activeCompareTargetId, focusedBaselineHistoryIds]
  );
  const activeComparisonContext = replayMode?.replayContext ?? liveComparisonContext;
  const displayedFocusedBaselineHistoryIds = activeComparisonContext.focusedCandidateIds;
  const { quickFocusEntries, remainingEntries: remainingBaselineHistoryEntries } = useMemo(
    () => partitionBaselineHistoryByFocus(sortedBaselineHistory, displayedFocusedBaselineHistoryIds),
    [displayedFocusedBaselineHistoryIds, sortedBaselineHistory]
  );
  const hiddenFocusedEntryCount = useMemo(() => {
    const filteredEntryIdSet = new Set(sortedBaselineHistory.map((entry) => entry.id));

    return displayedFocusedBaselineHistoryIds.filter((entryId) => !filteredEntryIdSet.has(entryId)).length;
  }, [displayedFocusedBaselineHistoryIds, sortedBaselineHistory]);
  const isQuickFocusFull = displayedFocusedBaselineHistoryIds.length >= 2;
  const effectiveActiveCompareTargetId = useMemo(() => {
    const compareTargetId = activeComparisonContext.activeCompareTargetId;

    if (quickFocusEntries.length === 0) {
      return null;
    }

    if (compareTargetId && quickFocusEntries.some((entry) => entry.id === compareTargetId)) {
      return compareTargetId;
    }

    return quickFocusEntries[0]?.id ?? null;
  }, [activeComparisonContext, quickFocusEntries]);
  const isReplayMode = replayMode !== null;
  const shouldRenderReplayBanner = isReplayMode;
  const replayModeLockMessage =
    "Replay mode is historical and inspect-only. Exit Replay To Live View to return to the saved live local workspace.";
  const replayBannerViewModel = useMemo(
    () => createReplayBannerViewModel(replayMode),
    [replayMode]
  );
  const liveMeetingCapabilityViewModel = useMemo(
    () =>
      createLiveMeetingCapabilityViewModel(LIVE_MEETING_CAPABILITY_TRACK, {
        sourceSelectorValue: liveMeetingSourceSelectorValue,
        tabShareIntentValue: liveMeetingTabShareIntentValue,
      },
      liveMeetingBrowserMediaCapability,
      liveMeetingRuntimeBoundaryTriggerState,
      liveMeetingPermissionRequestState,
      liveMeetingSessionRuntimeState,
      liveMeetingTranscriptSessionState,
      liveMeetingTranscriptRuntimeState,
      liveMeetingAnswerRuntimeState,
      liveMeetingRuntimeVerificationObservationState),
    [
      liveMeetingAnswerRuntimeState,
      liveMeetingBrowserMediaCapability,
      liveMeetingPermissionRequestState,
      liveMeetingRuntimeBoundaryTriggerState,
      liveMeetingRuntimeVerificationObservationState,
      liveMeetingSessionRuntimeState,
      liveMeetingTranscriptSessionState,
      liveMeetingTranscriptRuntimeState,
      liveMeetingSourceSelectorValue,
      liveMeetingTabShareIntentValue,
    ]
  );
  const workspaceTranscriptCapabilityViewModel = useMemo(
    () =>
      createLiveMeetingCapabilityViewModel(
        LIVE_MEETING_CAPABILITY_TRACK,
        {
          sourceSelectorValue: liveMeetingSourceSelectorValue,
          tabShareIntentValue: liveMeetingTabShareIntentValue,
        },
        liveMeetingBrowserMediaCapability,
        workspaceTranscriptionWorkflow.canUseTranscript ||
          workspaceTranscriptionWorkflow.status === "connecting" ||
          workspaceTranscriptionWorkflow.status === "listening" ||
          workspaceTranscriptionWorkflow.status === "receiving-transcript" ||
          workspaceTranscriptionWorkflow.status === "no-speech-yet"
          ? "user-triggered-not-requesting"
          : "not-yet-triggered",
        createInitialLiveMeetingPermissionRequestState(),
        workspaceSessionRuntimeState,
        workspaceTranscriptSessionState,
        workspaceTranscriptRuntimeState,
        liveMeetingAnswerRuntimeState,
        liveMeetingRuntimeVerificationObservationState
      ),
    [
      liveMeetingAnswerRuntimeState,
      liveMeetingBrowserMediaCapability,
      liveMeetingRuntimeVerificationObservationState,
      liveMeetingSourceSelectorValue,
      liveMeetingTabShareIntentValue,
      workspaceSessionRuntimeState,
      workspaceTranscriptRuntimeState,
      workspaceTranscriptSessionState,
      workspaceTranscriptionWorkflow.canUseTranscript,
      workspaceTranscriptionWorkflow.status,
    ]
  );
  const shouldRenderLiveMeetingCapabilityPlaceholder = true;
  const shouldRenderLiveSessionTranscriptRuntime =
    shouldRenderLiveMeetingCapabilityPlaceholder &&
    mode !== "meeting-copilot" &&
    (liveMeetingSessionRuntimeState.status === "active" ||
      workspaceTranscriptionWorkflow.status !== "idle");
  const workspaceTranscriptCaptureSessionPlaceholder =
    workspaceTranscriptCapabilityViewModel.captureSessionPlaceholder;
  const resolvedCompareTargetId = isReplayMode
    ? effectiveActiveCompareTargetId
    : effectiveActiveCompareTargetId ?? comparisonBaselineHistoryId;
  const comparisonBaselineHistoryEntry = useMemo(
    () => baselineHistory.find((entry) => entry.id === resolvedCompareTargetId) ?? null,
    [baselineHistory, resolvedCompareTargetId]
  );
  const comparisonBaselineNoteDiff = useMemo(
    () =>
      comparisonBaselineHistoryEntry
        ? createBaselineNoteDiff(baselineNoteDraft, comparisonBaselineHistoryEntry.note)
        : [],
    [baselineNoteDraft, comparisonBaselineHistoryEntry]
  );
  const recentDecisionSnapshot = useMemo(
    () => decisionSnapshots[0] ?? null,
    [decisionSnapshots]
  );
  const recentDecisionEntry = useMemo(
    () =>
      recentDecisionSnapshot
        ? baselineHistory.find((entry) => entry.id === recentDecisionSnapshot.candidateId) ?? null
        : null,
    [baselineHistory, recentDecisionSnapshot]
  );
  const selectedDecisionSnapshotDetail = useMemo(
    () =>
      selectedDecisionSnapshot
        ? decisionSnapshots.find(
            (snapshot) =>
              snapshot.candidateId === selectedDecisionSnapshot.candidateId &&
              snapshot.timestamp === selectedDecisionSnapshot.timestamp
          ) ?? null
        : null,
    [decisionSnapshots, selectedDecisionSnapshot]
  );
  const filteredDecisionSnapshots = useMemo(() => {
    const normalizedCandidateQuery = decisionTimelineCandidateQuery.trim().toLowerCase();

    return decisionSnapshots.filter((snapshot) => {
      const matchesCandidateQuery = normalizedCandidateQuery
        ? snapshot.candidateId.toLowerCase().includes(normalizedCandidateQuery)
        : true;
      const isReplayable =
        validBaselineHistoryIds.has(snapshot.candidateId) ||
        snapshot.comparisonContext.focusedCandidateIds.some((entryId) =>
          validBaselineHistoryIds.has(entryId)
        );

      if (!matchesCandidateQuery) {
        return false;
      }

      if (decisionTimelineReplayabilityFilter === "replayable-only" && !isReplayable) {
        return false;
      }

      return true;
    });
  }, [
    decisionSnapshots,
    decisionTimelineCandidateQuery,
    decisionTimelineReplayabilityFilter,
    validBaselineHistoryIds,
  ]);
  const hasActiveDecisionTimelineFilters =
    decisionTimelineCandidateQuery.trim().length > 0 ||
    decisionTimelineReplayabilityFilter !== "all";

  useEffect(() => {
    if (!selectedDecisionSnapshot) return;

    const isSelectedSnapshotVisible = filteredDecisionSnapshots.some(
      (snapshot) =>
        snapshot.candidateId === selectedDecisionSnapshot.candidateId &&
        snapshot.timestamp === selectedDecisionSnapshot.timestamp
    );

    if (!isSelectedSnapshotVisible) {
      setSelectedDecisionSnapshot(null);
    }
  }, [filteredDecisionSnapshots, selectedDecisionSnapshot]);

  function handleCloseDecisionSnapshotDetails() {
    setSelectedDecisionSnapshot(null);
  }

  function handleToggleFocusedBaselineHistoryEntry(entryId: string) {
    const updateFocusedIds = (current: string[]) => {
      if (current.includes(entryId)) {
        return current.filter((currentEntryId) => currentEntryId !== entryId);
      }

      if (current.length >= 2) {
        return current;
      }

      return [...current, entryId];
    };

    if (isReplayMode) {
      setReplayMode((current) =>
        current
          ? {
              ...current,
              replayContext: {
                ...current.replayContext,
                focusedCandidateIds: updateFocusedIds(current.replayContext.focusedCandidateIds),
              },
            }
          : current
      );
      return;
    }

    setFocusedBaselineHistoryIds(updateFocusedIds);
  }

  useEffect(() => {
    if (quickFocusEntries.length === 0) {
      if (isReplayMode) {
        setReplayMode((current) =>
          current
            ? {
                ...current,
                replayContext: {
                  ...current.replayContext,
                  activeCompareTargetId: null,
                },
              }
            : current
        );
      } else {
        setActiveCompareTargetId(null);
      }
      return;
    }

    if (quickFocusEntries.length === 1) {
      if (effectiveActiveCompareTargetId !== quickFocusEntries[0].id) {
        if (isReplayMode) {
          setReplayMode((current) =>
            current
              ? {
                  ...current,
                  replayContext: {
                    ...current.replayContext,
                    activeCompareTargetId: quickFocusEntries[0].id,
                  },
                }
              : current
          );
        } else {
          setActiveCompareTargetId(quickFocusEntries[0].id);
        }
      }
      return;
    }

    if (effectiveActiveCompareTargetId && quickFocusEntries.some((entry) => entry.id === effectiveActiveCompareTargetId)) {
      return;
    }

    if (isReplayMode) {
      setReplayMode((current) =>
        current
          ? {
              ...current,
              replayContext: {
                ...current.replayContext,
                activeCompareTargetId: quickFocusEntries[0].id,
              },
            }
          : current
      );
      return;
    }

    setActiveCompareTargetId(quickFocusEntries[0].id);
  }, [effectiveActiveCompareTargetId, isReplayMode, quickFocusEntries]);

  function promoteToCompareTarget(candidateId: string) {
    if (isReplayMode) {
      setReplayMode((current) =>
        current
          ? {
              ...current,
              replayContext: {
                ...current.replayContext,
                activeCompareTargetId: candidateId,
              },
            }
          : current
      );
      return;
    }

    setActiveCompareTargetId(candidateId);
  }

  function commitDecisionSnapshot(candidateId: string) {
    if (isReplayMode) return;
    setDecisionSnapshots((current) => [
      {
        candidateId,
        timestamp: Date.now(),
        comparisonContext: {
          focusedCandidateIds: quickFocusEntries.map((entry) => entry.id),
          activeCompareTargetId: effectiveActiveCompareTargetId,
        },
      },
      ...current,
    ]);
  }

  function restoreDecisionSnapshotContext(snapshot: DecisionSnapshot) {
    const capturedLiveContext = normalizeReplayLiveContext(
      {
        focusedCandidateIds: focusedBaselineHistoryIds,
        activeCompareTargetId,
        comparisonBaselineHistoryId,
      },
      validBaselineHistoryIds
    );
    const normalizedReplayContext = normalizeReplayComparisonContext(
      snapshot.comparisonContext,
      validBaselineHistoryIds
    );

    setReplayMode((current) => ({
      snapshotTimestamp: snapshot.timestamp,
      candidateId: snapshot.candidateId,
      liveContext: current?.liveContext ?? capturedLiveContext,
      replayContext: normalizedReplayContext,
    }));
  }

  function handleReplayDecisionSnapshot(
    snapshot: DecisionSnapshot,
    options?: {
      closeDetails?: boolean;
    }
  ) {
    if (options?.closeDetails) {
      handleCloseDecisionSnapshotDetails();
    }

    restoreDecisionSnapshotContext(snapshot);
  }

  function handleExitReplayMode() {
    if (!replayMode) return;

    const restoredLiveContext = normalizeReplayLiveContext(
      replayMode.liveContext,
      validBaselineHistoryIds
    );

    setFocusedBaselineHistoryIds(restoredLiveContext.focusedCandidateIds);
    setActiveCompareTargetId(restoredLiveContext.activeCompareTargetId);
    setComparisonBaselineHistoryId(restoredLiveContext.comparisonBaselineHistoryId);
    setReplayMode(null);
  }

  const templateComparisonRows = useMemo(() => {
    if (!comparisonTemplate) return [];

    const currentPromptIds = selectedPromptRefs.map((ref) => ref.promptId).sort();
    const templatePromptIds = comparisonTemplate.state.selectedPromptRefs
      .map((ref) => ref.promptId)
      .sort();
    const currentTranscriptIds = selectedTranscriptRefs.map((ref) => ref.transcriptId).sort();
    const templateTranscriptIds = comparisonTemplate.state.selectedTranscriptRefs
      .map((ref) => ref.transcriptId)
      .sort();
    const currentNoteBlueprint = stagedNotes.map((note) => `${note.type}:${note.content}`).sort();
    const templateNoteBlueprint = comparisonTemplate.state.stagedNotes
      .map((note) => `${note.type}:${note.content}`)
      .sort();

    return [
      {
        label: "Session mode",
        status:
          mode === comparisonTemplate.state.mode ? ("same" as const) : ("different" as const),
        currentValue: mode,
        templateValue: comparisonTemplate.state.mode,
      },
      {
        label: "Goal text",
        status:
          goal.trim() === comparisonTemplate.state.goal.trim()
            ? ("same" as const)
            : ("different" as const),
        currentValue: goal.trim() || "No goal set",
        templateValue: comparisonTemplate.state.goal.trim() || "No goal set",
      },
      {
        label: "Prompt references",
        status:
          JSON.stringify(currentPromptIds) === JSON.stringify(templatePromptIds)
            ? ("same" as const)
            : ("different" as const),
        currentValue:
          selectedPromptRefs.length > 0
            ? selectedPromptRefs.map((ref) => ref.title).join(", ")
            : "No prompt refs attached",
        templateValue:
          comparisonTemplate.state.selectedPromptRefs.length > 0
            ? comparisonTemplate.state.selectedPromptRefs.map((ref) => ref.title).join(", ")
            : "No prompt refs attached",
      },
      {
        label: "Transcript references",
        status:
          JSON.stringify(currentTranscriptIds) === JSON.stringify(templateTranscriptIds)
            ? ("same" as const)
            : ("different" as const),
        currentValue:
          selectedTranscriptRefs.length > 0
            ? selectedTranscriptRefs.map((ref) => ref.title).join(", ")
            : "No transcript refs attached",
        templateValue:
          comparisonTemplate.state.selectedTranscriptRefs.length > 0
            ? comparisonTemplate.state.selectedTranscriptRefs.map((ref) => ref.title).join(", ")
            : "No transcript refs attached",
      },
      {
        label: "Note scaffolding",
        status:
          JSON.stringify(currentNoteBlueprint) === JSON.stringify(templateNoteBlueprint)
            ? ("same" as const)
            : ("different" as const),
        currentValue:
          stagedNotes.length > 0
            ? `${stagedNotes.length} local note scaffold${stagedNotes.length === 1 ? "" : "s"}`
            : "No local note scaffolding",
        templateValue:
          comparisonTemplate.state.stagedNotes.length > 0
            ? `${comparisonTemplate.state.stagedNotes.length} template note scaffold${
                comparisonTemplate.state.stagedNotes.length === 1 ? "" : "s"
              }`
            : "No template note scaffolding",
      },
      {
        label: "Passive execution framing",
        status:
          executionStatus === comparisonTemplate.state.executionStatus
            ? ("same" as const)
            : ("different" as const),
        currentValue: executionStatus,
        templateValue: comparisonTemplate.state.executionStatus,
      },
    ];
  }, [
    comparisonTemplate,
    executionStatus,
    goal,
    mode,
    selectedPromptRefs,
    selectedTranscriptRefs,
    stagedNotes,
  ]);

  const activePreset = SESSION_WORKSPACE_PRESETS[mode];
  const activeRecommendationConfig = MODE_REFERENCE_RECOMMENDATIONS[mode];
  const readinessChecklist = createReadinessChecklist({
    mode,
    goal,
    promptCount: selectedPromptRefs.length,
    transcriptCount: selectedTranscriptRefs.length,
    noteCount: stagedNotes.length,
    turnCount: stagedTurns.length,
    executionStatus,
  });
  const promptGapHint =
    selectedPromptRefs.length === 0
      ? `No prompt is attached yet. For ${mode}, start with ${activeRecommendationConfig.promptIds.length > 0 ? "the recommended prompt references below" : "a manual prompt attachment"}.`
      : null;
  const transcriptGapHint =
    selectedTranscriptRefs.length === 0
      ? `No transcript is attached yet. For ${mode}, start with ${activeRecommendationConfig.transcriptIds.length > 0 ? "the recommended transcript references below" : "a manual transcript attachment"}.`
      : null;

  const recommendedPromptRefs = useMemo(() => {
    const ignoredIds = new Set(ignoredPromptRecommendations[mode] ?? []);
    const attachedIds = new Set(selectedPromptRefs.map((ref) => ref.promptId));

    return PROMPT_REFERENCE_CANDIDATES.filter(
      (ref) =>
        activeRecommendationConfig.promptIds.includes(ref.promptId) &&
        !ignoredIds.has(ref.promptId) &&
        !attachedIds.has(ref.promptId)
    );
  }, [activeRecommendationConfig.promptIds, ignoredPromptRecommendations, mode, selectedPromptRefs]);

  const recommendedTranscriptRefs = useMemo(() => {
    const ignoredIds = new Set(ignoredTranscriptRecommendations[mode] ?? []);
    const attachedIds = new Set(selectedTranscriptRefs.map((ref) => ref.transcriptId));

    return TRANSCRIPT_REFERENCE_CANDIDATES.filter(
      (ref) =>
        activeRecommendationConfig.transcriptIds.includes(ref.transcriptId) &&
        !ignoredIds.has(ref.transcriptId) &&
        !attachedIds.has(ref.transcriptId)
    );
  }, [
    activeRecommendationConfig.transcriptIds,
    ignoredTranscriptRecommendations,
    mode,
    selectedTranscriptRefs,
  ]);

  function ignorePromptRecommendation(promptId: string) {
    setIgnoredPromptRecommendations((current) => ({
      ...current,
      [mode]: [...(current[mode] ?? []), promptId],
    }));
  }

  function ignoreTranscriptRecommendation(transcriptId: string) {
    setIgnoredTranscriptRecommendations((current) => ({
      ...current,
      [mode]: [...(current[mode] ?? []), transcriptId],
    }));
  }

  const handoffSummary = useMemo(() => {
    const promptLines =
      selectedPromptRefs.length > 0
        ? selectedPromptRefs.map(
            (ref) => `- ${ref.title} (${ref.category}, ${ref.visibility})`
          )
        : ["- None attached yet"];
    const transcriptLines =
      selectedTranscriptRefs.length > 0
        ? selectedTranscriptRefs.map(
            (ref) => `- ${ref.title} (${ref.status})`
          )
        : ["- None attached yet"];
    const noteLines =
      stagedNotes.length > 0
        ? stagedNotes.slice(0, 5).map((note) => `- [${note.type}] ${note.content}`)
        : ["- No local notes staged yet"];
    const turnSummary =
      stagedTurns.length > 0
        ? `${stagedTurns.length} staged turn${stagedTurns.length === 1 ? "" : "s"}`
        : "No staged turns yet";

    return [
      "Cloud Nexus Pilot Local Session Handoff",
      `Mode: ${mode}`,
      `Goal: ${goal.trim() || "No goal set yet"}`,
      `Readiness: ${readinessChecklist.summary}`,
      `Passive execution status: ${executionStatus}`,
      `Turn summary: ${turnSummary}`,
      "",
      "Attached prompt references:",
      ...promptLines,
      "",
      "Attached transcript references:",
      ...transcriptLines,
      "",
      "Local note summary:",
      ...noteLines,
      "",
      "Truthfulness note:",
      "- This brief is assembled locally from browser state only.",
      "- No backend orchestration, AI summarization, or cloud session-memory runtime is active.",
    ].join("\n");
  }, [
    executionStatus,
    goal,
    mode,
    readinessChecklist.summary,
    selectedPromptRefs,
    selectedTranscriptRefs,
    stagedNotes,
    stagedTurns.length,
  ]);

  const changeBadges = useMemo(() => {
    if (!changeBaseline) {
      return {
        summary: "No local reset or template-load baseline is captured yet.",
        items: [
          { key: "mode", label: "Mode", changed: false, reviewed: false, detail: "No baseline captured yet." },
          { key: "goal", label: "Goal", changed: false, reviewed: false, detail: "No baseline captured yet." },
          { key: "prompts", label: "Prompt refs", changed: false, reviewed: false, detail: "No baseline captured yet." },
          { key: "transcripts", label: "Transcript refs", changed: false, reviewed: false, detail: "No baseline captured yet." },
          { key: "notes", label: "Notes", changed: false, reviewed: false, detail: "No baseline captured yet." },
          { key: "turns", label: "Turns", changed: false, reviewed: false, detail: "No baseline captured yet." },
        ],
      };
    }

    const promptsChanged = !compareStringLists(
      selectedPromptRefs.map((ref) => ref.promptId),
      changeBaseline.state.selectedPromptRefs.map((ref) => ref.promptId)
    );
    const transcriptsChanged = !compareStringLists(
      selectedTranscriptRefs.map((ref) => ref.transcriptId),
      changeBaseline.state.selectedTranscriptRefs.map((ref) => ref.transcriptId)
    );
    const notesChanged = !compareStringLists(
      stagedNotes.map((note) => `${note.type}:${note.content}:${note.status}`),
      changeBaseline.state.stagedNotes.map((note) => `${note.type}:${note.content}:${note.status}`)
    );
    const turnsChanged = !compareStringLists(
      stagedTurns.map((turn) => `${turn.role}:${turn.content}`),
      changeBaseline.state.stagedTurns.map((turn) => `${turn.role}:${turn.content}`)
    );

    return {
      summary: `Comparing against ${changeBaseline.reason} from ${new Date(
        changeBaseline.capturedAt
      ).toLocaleString()}.`,
      items: [
        {
          key: "mode",
          label: "Mode",
          changed: mode !== changeBaseline.state.mode,
          reviewed: isReviewed("mode"),
          detail:
            mode !== changeBaseline.state.mode
              ? `Changed from ${changeBaseline.state.mode} to ${mode}.`
              : `Still matches ${changeBaseline.state.mode}.`,
        },
        {
          key: "goal",
          label: "Goal",
          changed: goal.trim() !== changeBaseline.state.goal.trim(),
          reviewed: isReviewed("goal"),
          detail:
            goal.trim() !== changeBaseline.state.goal.trim()
              ? "Goal text changed since the last baseline."
              : "Goal text still matches the baseline.",
        },
        {
          key: "prompts",
          label: "Prompt refs",
          changed: promptsChanged,
          reviewed: isReviewed("prompts"),
          detail: promptsChanged
            ? "Prompt attachments changed and may need review."
            : "Prompt attachments still match the baseline.",
        },
        {
          key: "transcripts",
          label: "Transcript refs",
          changed: transcriptsChanged,
          reviewed: isReviewed("transcripts"),
          detail: transcriptsChanged
            ? "Transcript attachments changed and may need review."
            : "Transcript attachments still match the baseline.",
        },
        {
          key: "notes",
          label: "Notes",
          changed: notesChanged,
          reviewed: isReviewed("notes"),
          detail: notesChanged
            ? "Note scaffolding changed since the last baseline."
            : "Note scaffolding still matches the baseline.",
        },
        {
          key: "turns",
          label: "Turns",
          changed: turnsChanged,
          reviewed: isReviewed("turns"),
          detail: turnsChanged
            ? "Turn history changed since the last baseline."
            : "Turn history still matches the baseline.",
        },
      ],
    };
  }, [
    changeBaseline,
    goal,
    mode,
    isReviewed,
    selectedPromptRefs,
    selectedTranscriptRefs,
    stagedNotes,
    stagedTurns,
  ]);

  function renderChangeBadge(areaKey: string) {
    const item = changeBadges.items.find((badge) => badge.key === areaKey);
    if (!item) return null;

    const badgeClass = item.changed
      ? item.reviewed
        ? "bg-sky-100 text-sky-800"
        : "bg-amber-100 text-amber-800"
      : "bg-emerald-100 text-emerald-800";

    const badgeText = item.changed ? (item.reviewed ? "reviewed" : "changed") : "same";

    return (
      <span
        className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${badgeClass}`}
        title={item.detail}
      >
        {badgeText}
      </span>
    );
  }

  function renderReviewAction(areaKey: SessionWorkspaceReviewableArea) {
    const item = changeBadges.items.find((badge) => badge.key === areaKey);
    if (!item || !item.changed) return null;

    return item.reviewed ? (
      <button
        type="button"
        onClick={() => clearReviewed(areaKey)}
        disabled={isReplayMode}
        className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
      >
        Clear Review
      </button>
    ) : (
      <button
        type="button"
        onClick={() => markReviewed(areaKey)}
        disabled={isReplayMode}
        className="rounded-full border border-sky-300 bg-white px-3 py-1 text-xs font-semibold text-sky-800 transition hover:border-sky-500"
      >
        Mark Reviewed
      </button>
    );
  }

  function shouldShowReviewSection(areaKey: string) {
    const item = changeBadges.items.find((badge) => badge.key === areaKey);
    if (!reviewMode) return true;
    return item?.changed ?? false;
  }

  const workspaceExportJson = useMemo(
    () =>
      serializeSessionWorkspaceExport({
        state: {
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
        },
        readinessSummary: readinessChecklist.summary,
      }),
    [
      assistantPlaceholder,
      draftNote,
      draftNoteType,
      draftUserTurn,
      executionStatus,
      goal,
      mode,
      readinessChecklist.summary,
      selectedPromptRefs,
      selectedTranscriptRefs,
      stagedNotes,
      stagedTurns,
    ]
  );

  async function handleCopyHandoffSummary() {
    try {
      await navigator.clipboard.writeText(handoffSummary);
      setHandoffCopyState("copied");
      window.setTimeout(() => setHandoffCopyState("idle"), 2000);
    } catch {
      setHandoffCopyState("idle");
    }
  }

  async function handleCopyWorkspaceExport() {
    try {
      await navigator.clipboard.writeText(workspaceExportJson);
      logActivity({
        type: "export-triggered",
        message: `Copied local workspace export for ${mode}.`,
      });
      setExportCopyState("copied");
      setImportState({
        tone: "success",
        message: "Local session export copied. You can paste it into another browser session later.",
      });
      window.setTimeout(() => setExportCopyState("idle"), 2000);
    } catch {
      setExportCopyState("idle");
      setImportState({
        tone: "error",
        message: "Clipboard copy failed. You can still select and copy the export payload manually.",
      });
    }
  }

  function handleImportWorkspaceState() {
    if (isReplayMode) return;
    const result = parseSessionWorkspaceImport(importValue, initialWorkspaceState);

    if (!result.ok) {
      setImportState({ tone: "error", message: result.error });
      return;
    }

    replaceState(result.data);
    logActivity({
      type: "import-applied",
      message: `Applied a local workspace import into the ${result.data.mode} shell.`,
    });
    setImportState({
      tone: "success",
      message:
        "Local session state restored from import. This only updates browser-local shell scaffolding.",
    });
  }

  function handleSaveTemplate() {
    if (isReplayMode) return;
    const nextTemplateName = templateName || `${mode} local template`;
    saveTemplate({
      name: nextTemplateName,
      state: {
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
      },
    });
    logActivity({
      type: "template-saved",
      message: `Saved "${nextTemplateName}" as a local session template.`,
    });
    setTemplateName("");
    setTemplateStatus({
      tone: "success",
      message: "Local template saved. It stays in this browser only and does not create cloud memory.",
    });
  }

  function handleLoadTemplate(template: SessionWorkspaceTemplate) {
    if (isReplayMode) return;
    const nextState = applySessionWorkspaceTemplate({
      template,
      currentState: currentWorkspaceState,
    });
    replaceState(nextState);
    captureBaseline({
      reason: `Loaded template ${template.name}`,
      state: nextState,
    });
    logActivity({
      type: "template-loaded",
      message: `Loaded "${template.name}" into the local workspace shell.`,
    });
    setTemplateStatus({
      tone: "success",
      message: `Loaded "${template.name}" into the local shell. Turns and assistant placeholders were reset intentionally.`,
    });
  }

  function handleRenameTemplate(template: SessionWorkspaceTemplate) {
    if (isReplayMode) return;
    const nextName = window.prompt("Rename local session template", template.name);
    if (!nextName) return;
    renameTemplate(template.id, nextName);
    logActivity({
      type: "template-renamed",
      message: `Renamed local template "${template.name}" to "${nextName.trim()}".`,
    });
    setTemplateStatus({
      tone: "success",
      message: `Renamed template to "${nextName.trim()}".`,
    });
  }

  function handleDeleteTemplate(template: SessionWorkspaceTemplate) {
    if (isReplayMode) return;
    deleteTemplate(template.id);
    logActivity({
      type: "template-deleted",
      message: `Deleted local template "${template.name}".`,
    });
    if (comparisonTemplateId === template.id) {
      setComparisonTemplateId(null);
    }
    setTemplateStatus({
      tone: "success",
      message: `Deleted "${template.name}" from the local template library.`,
    });
  }

  function handleConfirmedReset() {
    if (isReplayMode) return;
    const shouldReset = window.confirm(
      "Reset the current local workspace shell? This clears the current browser-local session state, but you can restore the most recent recovery snapshot if one exists."
    );
    if (!shouldReset) return;

    captureRecoverySnapshot("Full local workspace reset");
    resetState();
    workspaceTranscriptionWorkflow.clearTranscript();
    clearTranscriptWorkspaceRecoveryIntent();
    captureBaseline({
      reason: "Local reset",
      state: initialWorkspaceState,
    });
    logActivity({
      type: "reset-performed",
      message: "Reset the current local workspace shell.",
    });
    setRecoveryStatus({
      tone: "warning",
      message:
        "Local workspace reset applied. You can restore the most recent recovery snapshot from this browser if needed.",
    });
  }

  function handleConfirmedClearTurns() {
    if (isReplayMode) return;
    const shouldClear = window.confirm(
      "Clear all staged local turns and assistant placeholders? This affects browser-local shell state only."
    );
    if (!shouldClear) return;

    captureRecoverySnapshot("Cleared local turns");
    clearTurns();
    logActivity({
      type: "turns-cleared",
      message: "Cleared staged local turns and passive assistant placeholders.",
    });
    setRecoveryStatus({
      tone: "warning",
      message: "Local turns were cleared. The latest recovery snapshot can restore them if needed.",
    });
  }

  function handleConfirmedClearNotes() {
    if (isReplayMode) return;
    const shouldClear = window.confirm(
      "Clear all staged local notes? This only affects this browser-local shell."
    );
    if (!shouldClear) return;

    captureRecoverySnapshot("Cleared local notes");
    clearNotes();
    logActivity({
      type: "notes-cleared",
      message: "Cleared staged local notes from the workspace shell.",
    });
    setRecoveryStatus({
      tone: "warning",
      message: "Local notes were cleared. The latest recovery snapshot can restore them if needed.",
    });
  }

  function handleRestoreRecoverySnapshot() {
    if (isReplayMode) return;
    const restored = restoreRecoverySnapshot();
    if (!restored) {
      setRecoveryStatus({
        tone: "warning",
        message: "No recoverable local snapshot is available right now.",
      });
      return;
    }

    setRecoveryStatus({
      tone: "success",
      message: "Recovered the most recent local workspace snapshot successfully.",
    });
    logActivity({
      type: "restore-performed",
      message: "Restored the most recent recoverable local workspace snapshot.",
    });
  }

  function handleModeChange(nextMode: SessionMode) {
    if (isReplayMode) return;
    applyPreset(nextMode);
    logActivity({
      type: "mode-changed",
      message: `Switched the local workspace mode to ${nextMode}.`,
    });
  }

  function handleRefreshBaseline() {
    if (isReplayMode) return;
    captureBaseline({
      reason: "Accepted current local state as baseline",
      note: baselineNoteDraft,
      state: currentWorkspaceState,
    });
    clearAllReviewed();
    setComparisonBaselineHistoryId(null);
  }

  function handleSaveBaselineNote() {
    if (isReplayMode) return;
    updateBaselineNote(baselineNoteDraft);
  }

  function handleClearBaselineNote() {
    if (isReplayMode) return;
    setBaselineNoteDraft("");
    clearBaselineNote();
  }

  function handleRestoreBaselineNoteFromHistory(note: string) {
    if (isReplayMode) return;
    setBaselineNoteDraft(note);
    updateBaselineNote(note);
    setComparisonBaselineHistoryId(null);
  }

  const demoIncomingQuestionText = demoMode
    ? workspaceTranscriptionWorkflow.segments.find(
        (segment) => segment.id === "demo-segment-question"
      )?.text ?? `Incoming recruiter question: ${WORKSPACE_DEMO_QUESTION}`
    : null;
  const demoAnswerDirectionText = demoMode
    ? liveMeetingAnswerRuntimeState.draftBodyText ?? WORKSPACE_DEMO_ANSWER_DIRECTION
    : null;

  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
      <section className="panel p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="pill">Session Workspace</span>
            <h2 className="mt-4 text-3xl font-semibold leading-[1.15] tracking-[-0.02em] text-slate-950">
              {demoMode
                ? "See the recruiter-call demo in one local workspace."
                : "Live Call Cockpit: review readiness, start capture, and respond clearly."}
            </h2>
            <p className="mt-4 max-w-2xl text-sm font-normal leading-7 text-slate-600">
              {demoMode
                ? "This demo stays browser-local and deterministic. The incoming question, transcript review, and answer direction below are all staged locally with no backend orchestration."
                : "Start with the launch and transcript lanes, then use advanced workspace controls only if needed. No fake runtime behavior is introduced."}
            </p>
            {!demoMode ? (
              <p className="mt-3 text-sm leading-7 text-slate-500">
                Local selections and notes persist in this browser for quick resume.
              </p>
            ) : null}
          </div>
          <div className="rounded-3xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
            Cockpit status:{" "}
            <span className="font-semibold">
              {demoMode ? "Demo loaded locally" : "Passive only"}
            </span>
          </div>
        </div>

        {demoMode && demoIncomingQuestionText && demoAnswerDirectionText ? (
          <div className="mt-6 rounded-[2rem] border-2 border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white">
                Demo scenario • recruiter call
              </span>
              <p className="text-xs text-slate-500">
                Browser-local only. No fake streaming or backend answer generation.
              </p>
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
              The goal is to make the incoming question obvious and the response direction easy to
              scan in under five seconds.
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
                  Incoming Question
                </p>
                <p className="mt-4 whitespace-pre-wrap text-2xl font-semibold leading-9 text-amber-950">
                  {demoIncomingQuestionText}
                </p>
              </div>
              <div className="rounded-3xl border border-blue-200 bg-blue-50 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                  Answer Direction
                </p>
                <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-blue-950">
                  {demoAnswerDirectionText}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {(shouldShowReviewSection("mode") || shouldShowReviewSection("goal")) ? (
          <div className="mt-8 grid gap-5 md:grid-cols-[220px_1fr]">
            {shouldShowReviewSection("mode") ? (
              <label className="text-sm font-medium text-slate-700">
                <div className="flex flex-wrap items-center gap-2">
                  <span>Session Mode</span>
                  {renderChangeBadge("mode")}
                  {renderReviewAction("mode")}
                </div>
                <select
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                  value={mode}
                  disabled={isReplayMode}
                  onChange={(event) => handleModeChange(event.target.value as SessionMode)}
                >
                  {SESSION_MODE_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {shouldShowReviewSection("goal") ? (
              <label className="text-sm font-medium text-slate-700">
                <div className="flex flex-wrap items-center gap-2">
                  <span>Current Goal</span>
                  {renderChangeBadge("goal")}
                  {renderReviewAction("goal")}
                </div>
                <textarea
                  className="mt-2 min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-7"
                  value={goal}
                  disabled={isReplayMode}
                  onChange={(event) => setGoal(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : reviewMode ? (
          <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
            No mode or goal changes need review right now.
          </div>
        ) : null}

        {demoMode ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-700">
                {isHydrated ? "saved locally" : "loading local shell"}
              </span>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-700">
                preset {mode}
              </span>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-700">
                readiness {readinessChecklist.summary}
              </span>
            </div>
            <p className="mt-3 leading-7">
              This local-only demo keeps the validated runtime visible and softens the extra shell
              scaffolding so the recruiter-call scenario reads faster.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
              Local shell state:{" "}
              <span className="font-semibold text-slate-900">
                {isHydrated ? "saved in this browser" : "loading local workspace state"}
              </span>
              <p className="mt-2 leading-7">
                This is a local-only convenience layer for the dashboard shell. It does not claim
                backend memory, cloud sync, or cross-device session continuity.
              </p>
              <p className="mt-2 leading-7">
                Switching modes reapplies local presets for goal text, starter notes, and passive
                execution readiness. Prompt and transcript references remain attached by reference.
              </p>
            </div>

            <div className="mt-5 rounded-3xl border border-sky-200 bg-sky-50 px-5 py-4 text-sm text-sky-900">
              <p className="font-semibold">Active preset: {mode}</p>
              <p className="mt-2 leading-7">{activePreset.goal}</p>
              <p className="mt-2 leading-7">
                Starter note scaffolds: {activePreset.starterNotes.length} items. Passive
                execution status: <span className="font-semibold">{activePreset.executionStatus}</span>.
              </p>
              <p className="mt-2 leading-7">{activeRecommendationConfig.hint}</p>
            </div>

            <div className="mt-5 rounded-3xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-900">
              <p className="font-semibold">Local readiness: {readinessChecklist.summary}</p>
              <p className="mt-2 leading-7">
                This checklist is local and rule-based only. It shows whether the current shell has the
                basics attached for a future runtime session, without claiming backend readiness.
              </p>
            </div>
          </>
        )}

        {mode === "meeting-copilot" ? (
          <div className="mt-5 space-y-6">
            <div className="rounded-3xl border border-cyan-200 bg-cyan-50 px-5 py-5 text-sm text-cyan-900">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-semibold">Browser-Local Transcript Runtime</p>
                  <p className="mt-2 leading-7">
                    {demoMode
                      ? "Shared browser-local transcript runtime. OpenAI transcription runs through the secure server route, and answer generation is still not active."
                      : "This replaces the placeholder transcript/runtime section in the workspace shell with the same transcription runtime used on the standalone transcript route. It now performs real OpenAI transcription only, with no answer-generation orchestration."}
                  </p>
                  <p className="mt-2 leading-7">
                    {workspaceTranscriptCaptureSessionPlaceholder.statusLabel}:{" "}
                    {workspaceTranscriptCaptureSessionPlaceholder.statusValue}
                  </p>
                  {!demoMode ? (
                    <p className="mt-2 leading-7">
                      {workspaceTranscriptCaptureSessionPlaceholder.helperText}
                    </p>
                  ) : null}
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800">
                  {workspaceTranscriptCaptureSessionPlaceholder.transcriptChunks.length} runtime chunk
                  {workspaceTranscriptCaptureSessionPlaceholder.transcriptChunks.length === 1
                    ? ""
                    : "s"}
                </span>
              </div>
              {renderLiveMeetingRuntimeVerificationShell(
                workspaceTranscriptCaptureSessionPlaceholder
              )}
              <div className="mt-5">
                <TranscriptionRuntimeSurface
                  workflow={workspaceTranscriptionWorkflow}
                  variant="workspace"
                />
              </div>
              <div className="mt-5 rounded-2xl border border-cyan-200 bg-white px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">
                  Workspace Transcript Review And Answer Lane
                </p>
                <p className="mt-3 text-xs leading-6 text-cyan-800">
                  The review and answer-preparation surfaces below stay tied to the real
                  browser-local transcript runtime above.
                </p>
              </div>
              {renderLiveMeetingTranscriptReviewShell(
                workspaceTranscriptCaptureSessionPlaceholder
              )}
              {renderLiveMeetingAnswerPreparationShell(
                workspaceTranscriptCaptureSessionPlaceholder,
                handleTriggerWorkspaceTranscriptAnswerPreparationBoundary
              )}
              {renderLiveMeetingAnswerDraftShell(
                workspaceTranscriptCaptureSessionPlaceholder
              )}
            </div>
          </div>
        ) : shouldRenderLiveMeetingCapabilityPlaceholder ? (
          <div className="mt-5 space-y-6">
            {renderLiveMeetingCapabilityPlaceholderShell(
              liveMeetingCapabilityViewModel,
              liveMeetingTranscriptInputDraft,
              setLiveMeetingTranscriptInputDraft,
              handleIngestLiveMeetingTranscriptInput,
              handleTriggerLiveMeetingAnswerPreparationBoundary,
              handleTriggerLiveMeetingLaunchBoundary,
              handleStartLiveMeetingCaptureSession,
              handleStopLiveMeetingCaptureSession,
              handleTriggerLiveMeetingTranscriptStartBoundary,
              handleResetLiveMeetingRuntimeLane
            )}
            {shouldRenderLiveSessionTranscriptRuntime ? (
              <div className="rounded-3xl border border-cyan-200 bg-cyan-50 px-5 py-5 text-sm text-cyan-900">
                <p className="font-semibold">Live Session Transcript Runtime</p>
                <p className="mt-2 leading-7">
                  A confirmed live stream is connected to the same Block C transcription workflow used
                  by the transcript workspace. OpenAI transcription only, no answer generation.
                </p>
                <div className="mt-5">
                  <TranscriptionRuntimeSurface
                    workflow={workspaceTranscriptionWorkflow}
                    variant="workspace"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 rounded-3xl border border-violet-200 bg-violet-50 px-5 py-4 text-sm text-violet-900">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-semibold">Local change badges</p>
              <p className="mt-2 leading-7">{changeBadges.summary}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                {changeBadges.items.filter((item) => item.changed).length} areas changed
              </span>
              {reviewedAreas.length > 0 ? (
                <button
                  type="button"
                  onClick={clearAllReviewed}
                  disabled={isReplayMode}
                  className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                >
                  Clear Reviewed
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleRefreshBaseline}
                disabled={isReplayMode}
                className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
              >
                Accept As Baseline
              </button>
              <button
                type="button"
                onClick={() => setReviewMode((current) => !current)}
                className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition ${
                  reviewMode
                    ? "bg-slate-950 text-white hover:bg-slate-800"
                    : "border border-violet-300 bg-white text-violet-800 hover:border-violet-500"
                }`}
              >
                {reviewMode ? "Review Mode On" : "Review Mode Off"}
              </button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {changeBadges.items.map((item) => (
              <span
                key={item.key}
                className={`rounded-full px-3 py-2 text-xs font-semibold ${
                  item.changed
                    ? item.reviewed
                      ? "bg-sky-100 text-sky-800"
                      : "bg-amber-100 text-amber-800"
                    : "bg-emerald-100 text-emerald-800"
                }`}
                title={item.detail}
              >
                {item.label}: {item.changed ? (item.reviewed ? "reviewed" : "review") : "same"}
              </span>
            ))}
          </div>
          <p className="mt-4 leading-7">
            {reviewMode
              ? "Review mode is active. Only sections currently marked changed remain visible."
              : "Review mode is off. The full local workspace is visible."}
          </p>
            <p className="mt-2 leading-7">
              Accepting the current state as baseline is local-only. It resets change badges and
              reviewed markers for this browser session baseline, not backend history.
            </p>
            {isReplayMode ? (
              <p className="mt-2 leading-7 text-amber-900">{replayModeLockMessage}</p>
            ) : null}
            <div className="mt-4 rounded-3xl border border-violet-200 bg-white px-4 py-4 text-sm text-violet-900">
              <label className="block font-semibold">
                Baseline note
                <textarea
                  className="mt-3 min-h-24 w-full rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm leading-7 text-slate-700"
                  value={baselineNoteDraft}
                  disabled={isReplayMode}
                  onChange={(event) => setBaselineNoteDraft(event.target.value)}
                  placeholder="Record why this local baseline was accepted. This stays in the browser only."
                />
            </label>
            <p className="mt-3 leading-7">
              {changeBaseline?.note
                ? `Current baseline note: ${changeBaseline.note}`
                : "No baseline note saved yet for the current local baseline."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleSaveBaselineNote}
                disabled={isReplayMode || !changeBaseline}
                className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                Save Note
              </button>
              <button
                type="button"
                onClick={handleClearBaselineNote}
                disabled={isReplayMode || !changeBaseline || !changeBaseline.note}
                className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                Clear Note
              </button>
            </div>
          </div>
          <div className="mt-4 rounded-3xl border border-violet-200 bg-white px-4 py-4 text-sm text-violet-900">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">Local baseline history</p>
                <p className="mt-2 leading-7">
                  Recent accepted baselines stay in this browser only. This is not backend history
                  or version control.
                </p>
              </div>
              {baselineHistory.length > 0 ? (
                <button
                  type="button"
                  onClick={clearHistory}
                  disabled={isReplayMode}
                  className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                >
                  Clear History
                </button>
              ) : null}
            </div>
            {baselineHistory.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="block font-semibold">
                    Search local history notes
                    <input
                      type="text"
                      value={baselineHistoryQuery}
                      onChange={(event) => setBaselineHistoryQuery(event.target.value)}
                      placeholder="Filter by note text, timestamp, or current/previous"
                      className="mt-3 w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm leading-7 text-slate-700"
                    />
                  </label>
                  <label className="block font-semibold">
                    Sort local history
                    <select
                      value={baselineHistorySortMode}
                      onChange={(event) =>
                        setBaselineHistorySortMode(event.target.value as BaselineHistorySortMode)
                      }
                      className="mt-3 w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm leading-7 text-slate-700"
                    >
                      <option value="newest-first">Newest first</option>
                      <option value="oldest-first">Oldest first</option>
                      <option value="note-present-first">Note-present first</option>
                      <option value="current-first">Current first</option>
                    </select>
                  </label>
                </div>
                <p className="mt-3 leading-7 text-slate-700">
                  {baselineHistoryQuery.trim()
                    ? `Showing ${sortedBaselineHistory.length} of ${baselineHistory.length} local baseline entr${
                        baselineHistory.length === 1 ? "y" : "ies"
                      } for "${baselineHistoryQuery.trim()}" in ${
                        describeBaselineHistorySortMode(baselineHistorySortMode)
                      } order.`
                    : `Showing all ${baselineHistory.length} local baseline entr${
                        baselineHistory.length === 1 ? "y" : "ies"
                      } in ${describeBaselineHistorySortMode(baselineHistorySortMode)} order.`}
                </p>
                <p className="mt-2 leading-7 text-slate-700">
                  Quick focus can temporarily surface up to two local entries for faster compare or
                  note reuse. It stays in this browser only.
                </p>
              </div>
            ) : null}
            {quickFocusEntries.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-100/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">Quick-focus baselines</p>
                    <p className="mt-2 leading-7 text-slate-700">
                      Pinned entries stay surfaced here while still following the current local
                      search and sort settings.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      isReplayMode
                        ? setReplayMode((current) =>
                            current
                              ? {
                                  ...current,
                                  replayContext: {
                                    ...current.replayContext,
                                    focusedCandidateIds: [],
                                  },
                                }
                              : current
                          )
                        : setFocusedBaselineHistoryIds([])
                    }
                    className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                  >
                    Clear Quick Focus
                  </button>
                </div>
                <div className="mt-4 space-y-3">
                  {quickFocusEntries.map((entry) => {
                    const isCurrent = changeBaseline?.capturedAt === entry.capturedAt;
                    const isComparing = resolvedCompareTargetId === entry.id;

                    return (
                      <article
                        key={`quick-focus-${entry.id}`}
                        className="rounded-2xl border border-violet-200 bg-white p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-slate-950">
                                {new Date(entry.capturedAt).toLocaleString()}
                              </p>
                              <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800">
                                focused
                              </span>
                              <span
                                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                                  isCurrent
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-slate-100 text-slate-700"
                                }`}
                              >
                                {isCurrent ? "current" : "previous"}
                              </span>
                            </div>
                            <p className="mt-2 text-sm leading-6 text-slate-700">{entry.reason}</p>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              {entry.note ? entry.note : "No rationale note saved for this baseline."}
                            </p>
                            <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                              {entry.id}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => handleToggleFocusedBaselineHistoryEntry(entry.id)}
                              className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                            >
                              Unpin
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setComparisonBaselineHistoryId((current) =>
                                  current === entry.id ? null : entry.id
                                )
                              }
                              disabled={!changeBaseline || !entry.note || isCurrent}
                              className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                            >
                              {isComparing ? "Hide Compare" : "Compare Note"}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {quickFocusEntries.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-violet-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">Side-by-side candidate review</p>
                    <p className="mt-2 leading-7 text-slate-700">
                      Focused entries stay visible together here so you can review local note text
                      before deciding which one to compare against the current baseline note field
                      or reuse directly.
                    </p>
                  </div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    {quickFocusEntries.length === 1
                      ? "1 focused candidate"
                      : `${quickFocusEntries.length} focused candidates`}
                  </p>
                </div>
                <p className="mt-3 leading-7 text-slate-700">
                  Promote either focused candidate into the active local compare target with one
                  click, then keep using the existing diff summary and note reuse flow below.
                </p>
                {recentDecisionSnapshot ? (
                  <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                      Recent decision snapshot
                    </p>
                    <p className="mt-2 text-sm leading-7 text-slate-700">
                      {recentDecisionEntry
                        ? `Committed ${new Date(recentDecisionSnapshot.timestamp).toLocaleString()} for ${new Date(
                            recentDecisionEntry.capturedAt
                          ).toLocaleString()}.`
                        : `Committed ${new Date(recentDecisionSnapshot.timestamp).toLocaleString()} for a local candidate that is no longer available.`}
                    </p>
                  </div>
                ) : null}
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  {quickFocusEntries.map((entry) => {
                    const isCurrent = changeBaseline?.capturedAt === entry.capturedAt;
                    const isComparing = resolvedCompareTargetId === entry.id;
                    const hasNote = Boolean(entry.note.trim());
                    const isActiveCompareTarget = effectiveActiveCompareTargetId === entry.id;

                    return (
                      <article
                        key={`candidate-review-${entry.id}`}
                        className="rounded-2xl border border-violet-200 bg-violet-50 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              {new Date(entry.capturedAt).toLocaleString()}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800">
                                focused
                              </span>
                              <span
                                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                                  isCurrent
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-slate-100 text-slate-700"
                                }`}
                              >
                                {isCurrent ? "current" : "previous"}
                              </span>
                              <span
                                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                                  hasNote
                                    ? "bg-violet-100 text-violet-800"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {hasNote ? "note saved" : "no note saved"}
                              </span>
                              {isActiveCompareTarget ? (
                                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">
                                  active compare target
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggleFocusedBaselineHistoryEntry(entry.id)}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                          >
                            Unpin
                          </button>
                        </div>
                        <p className="mt-4 text-sm leading-6 text-slate-700">{entry.reason}</p>
                        <div className="mt-4 rounded-2xl border border-violet-200 bg-white p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                            Candidate note text
                          </p>
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                            {hasNote ? entry.note : "No rationale note saved for this baseline."}
                          </p>
                        </div>
                        <p className="mt-3 text-xs uppercase tracking-[0.16em] text-slate-500">
                          {entry.id}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => promoteToCompareTarget(entry.id)}
                            disabled={!changeBaseline || !hasNote || isCurrent}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            {isActiveCompareTarget ? "Active Compare Target" : "Use as Compare Target"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setComparisonBaselineHistoryId((current) =>
                                current === entry.id ? null : entry.id
                              )
                            }
                            disabled={!changeBaseline || !hasNote || isCurrent}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            {isComparing ? "Hide Compare" : "Compare Note"}
                          </button>
                        <button
                          type="button"
                          onClick={() => handleRestoreBaselineNoteFromHistory(entry.note)}
                            disabled={isReplayMode || !hasNote}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            Reuse Note
                          </button>
                          <button
                            type="button"
                            onClick={() => commitDecisionSnapshot(entry.id)}
                            disabled={isReplayMode}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                          >
                            Commit as Decision
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  {quickFocusEntries.length === 1 ? (
                    <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-8 text-sm leading-7 text-slate-500">
                      Pin one more local baseline history entry to keep two candidates visible here
                      side by side.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {hiddenFocusedEntryCount > 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-4 text-sm leading-7 text-slate-600">
                {hiddenFocusedEntryCount} quick-focus entr{hiddenFocusedEntryCount === 1 ? "y is" : "ies are"} currently hidden by the active search filter.
              </div>
            ) : null}
            {renderReplayBannerSection(
              replayBannerViewModel,
              shouldRenderReplayBanner,
              handleExitReplayMode
            )}
            <div className="mt-4 rounded-2xl border border-violet-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">Decision Timeline</p>
                  <p className="mt-2 leading-7 text-slate-700">
                    Re-focus this browser-local workspace to a recorded decision context without
                    changing baseline history, notes, or workspace data.
                  </p>
                </div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {decisionSnapshots.length} snapshot{decisionSnapshots.length === 1 ? "" : "s"}
                </p>
              </div>
              {decisionSnapshots.length > 0 ? (
                <>
                  <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                    <div className="grid gap-4 lg:grid-cols-[1fr_220px_auto]">
                      <label className="block font-semibold">
                        Filter by candidate id
                        <input
                          type="text"
                          value={decisionTimelineCandidateQuery}
                          onChange={(event) => setDecisionTimelineCandidateQuery(event.target.value)}
                          placeholder="Match candidate id text"
                          className="mt-3 w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm leading-7 text-slate-700"
                        />
                      </label>
                      <label className="block font-semibold">
                        Timeline scope
                        <select
                          value={decisionTimelineReplayabilityFilter}
                          onChange={(event) =>
                            setDecisionTimelineReplayabilityFilter(
                              event.target.value as DecisionTimelineReplayabilityFilter
                            )
                          }
                          className="mt-3 w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm leading-7 text-slate-700"
                        >
                          <option value="all">All snapshots</option>
                          <option value="replayable-only">Replayable only</option>
                        </select>
                      </label>
                      <div className="flex items-end">
                        <button
                          type="button"
                          onClick={() => {
                            setDecisionTimelineCandidateQuery("");
                            setDecisionTimelineReplayabilityFilter("all");
                          }}
                          className="rounded-full border border-violet-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                        >
                          Clear Filters
                        </button>
                      </div>
                    </div>
                    <p className="mt-3 leading-7 text-slate-700">
                      Showing {filteredDecisionSnapshots.length} of {decisionSnapshots.length} local
                      decision snapshot{decisionSnapshots.length === 1 ? "" : "s"}.
                    </p>
                  </div>
                  {selectedDecisionSnapshotDetail ? (
                    <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                        Decision snapshot details
                      </p>
                      <div className="mt-3 space-y-2 text-sm leading-7 text-slate-700">
                        <p>Candidate: {selectedDecisionSnapshotDetail.candidateId}</p>
                        <p>
                          Timestamp:{" "}
                          {new Date(selectedDecisionSnapshotDetail.timestamp).toLocaleString()}
                        </p>
                        <p>
                          Focused candidates:{" "}
                          {selectedDecisionSnapshotDetail.comparisonContext.focusedCandidateIds.length > 0
                            ? selectedDecisionSnapshotDetail.comparisonContext.focusedCandidateIds.join(", ")
                            : "None saved"}
                        </p>
                        <p>
                          Active compare target:{" "}
                          {selectedDecisionSnapshotDetail.comparisonContext.activeCompareTargetId ??
                            "None saved"}
                        </p>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleReplayDecisionSnapshot(selectedDecisionSnapshotDetail, {
                              closeDetails: true,
                            })
                          }
                          className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                        >
                          Replay Snapshot
                        </button>
                        <button
                          type="button"
                          onClick={handleCloseDecisionSnapshotDetails}
                          className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                        >
                          Close Details
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-4 space-y-3">
                    {filteredDecisionSnapshots.length > 0 ? (
                      filteredDecisionSnapshots.map((snapshot, index) => {
                        const snapshotEntry =
                          baselineHistory.find((entry) => entry.id === snapshot.candidateId) ?? null;
                        const isSelected =
                          selectedDecisionSnapshot?.candidateId === snapshot.candidateId &&
                          selectedDecisionSnapshot?.timestamp === snapshot.timestamp;

                        return (
                          <article
                            key={`${snapshot.candidateId}-${snapshot.timestamp}-${index}`}
                            className={`rounded-2xl border p-4 ${
                              isSelected
                                ? "border-violet-300 bg-violet-100/70"
                                : "border-violet-200 bg-violet-50"
                            }`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-slate-950">
                                  {new Date(snapshot.timestamp).toLocaleString()}
                                </p>
                                <p className="mt-2 text-sm leading-6 text-slate-700">
                                  Candidate: {snapshot.candidateId}
                                </p>
                                <p className="mt-2 text-sm leading-6 text-slate-600">
                                  {snapshot.comparisonContext.focusedCandidateIds.length} focused
                                  candidate
                                  {snapshot.comparisonContext.focusedCandidateIds.length === 1
                                    ? ""
                                    : "s"}
                                  {snapshot.comparisonContext.activeCompareTargetId
                                    ? `, active target ${snapshot.comparisonContext.activeCompareTargetId}`
                                    : ", no active target saved"}
                                </p>
                                <p className="mt-2 text-sm leading-6 text-slate-600">
                                  {snapshotEntry
                                    ? `Local candidate timestamp: ${new Date(snapshotEntry.capturedAt).toLocaleString()}`
                                    : "Snapshot candidate is no longer available in local baseline history."}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSelectedDecisionSnapshot({
                                      candidateId: snapshot.candidateId,
                                      timestamp: snapshot.timestamp,
                                    })
                                  }
                                  className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                                >
                                  View Details
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleReplayDecisionSnapshot(snapshot)}
                                  className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                                >
                                  Replay Snapshot
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-8 text-sm text-slate-500">
                        No decision snapshots match the current filters. Adjust the candidate id
                        query or timeline scope, or clear filters to see all local snapshots again.
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="mt-4 rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-8 text-sm text-slate-500">
                  No decision snapshots have been recorded yet. Commit a decision from the local
                  side-by-side candidate review to start this browser-local timeline.
                </div>
              )}
            </div>
            <div className="mt-4 space-y-3">
              {sortedBaselineHistory.length > 0 ? (
                remainingBaselineHistoryEntries.map((entry) => {
                  const isCurrent = changeBaseline?.capturedAt === entry.capturedAt;
                  const isComparing = resolvedCompareTargetId === entry.id;
                  const isFocused = displayedFocusedBaselineHistoryIds.includes(entry.id);

                  return (
                    <article
                      key={entry.id}
                      className="rounded-2xl border border-violet-200 bg-violet-50 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">
                              {new Date(entry.capturedAt).toLocaleString()}
                            </p>
                            <span
                              className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                                isCurrent
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-slate-100 text-slate-700"
                              }`}
                            >
                              {isCurrent ? "current" : "previous"}
                            </span>
                            {isFocused ? (
                              <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800">
                                focused
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-700">{entry.reason}</p>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            {entry.note ? entry.note : "No rationale note saved for this baseline."}
                          </p>
                          <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                            {entry.id}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => deleteHistoryEntry(entry.id)}
                            disabled={isReplayMode}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                        >
                          Clear Entry
                        </button>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleFocusedBaselineHistoryEntry(entry.id)}
                            disabled={!isFocused && isQuickFocusFull}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            {isFocused ? "Unpin" : isQuickFocusFull ? "Quick Focus Full" : "Pin"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setComparisonBaselineHistoryId((current) =>
                                current === entry.id ? null : entry.id
                              )
                            }
                            disabled={!changeBaseline || !entry.note || isCurrent}
                            className="rounded-full border border-violet-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            {isComparing ? "Hide Compare" : "Compare Note"}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })
              ) : baselineHistory.length > 0 ? (
                <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-8 text-sm text-slate-500">
                  No local baseline history entries match this filter yet.
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-8 text-sm text-slate-500">
                  No local baseline history recorded yet.
                </div>
              )}
            </div>
            {comparisonBaselineHistoryEntry ? (
              <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-100/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">Compare historical note before reuse</p>
                    <p className="mt-2 leading-7 text-slate-700">
                      This compares the current baseline note field with the selected historical
                      note only. It does not restore old workspace state.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleRestoreBaselineNoteFromHistory(comparisonBaselineHistoryEntry.note)
                      }
                      disabled={isReplayMode}
                      className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                    >
                      Reuse Selected Note
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setComparisonBaselineHistoryId(null);
                        setActiveCompareTargetId(null);
                      }}
                      className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-800 transition hover:border-violet-500"
                    >
                      Close Compare
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-2xl border border-violet-200 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                      Current baseline note field
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                      {baselineNoteDraft.trim()
                        ? baselineNoteDraft
                        : "No current baseline note text is entered right now."}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-violet-200 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                      Selected historical note
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                      {comparisonBaselineHistoryEntry.note}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-7 text-slate-700">
                  {baselineNoteDraft.trim() === comparisonBaselineHistoryEntry.note.trim()
                    ? "Both notes match already, so reuse would only confirm the same local rationale."
                    : "The notes differ. Reusing the historical note will replace the current baseline note field only."}
                </p>
                <div className="mt-4 rounded-2xl border border-violet-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                        Note-only diff summary
                      </p>
                      <p className="mt-2 text-sm leading-7 text-slate-700">
                        Added lines come from the selected historical note. Removed lines are only
                        in the current baseline note field.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.16em]">
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">
                        {comparisonBaselineNoteDiff.filter((line) => line.kind === "unchanged").length} unchanged
                      </span>
                      <span className="rounded-full bg-violet-100 px-3 py-1 text-violet-800">
                        {comparisonBaselineNoteDiff.filter((line) => line.kind === "added").length} added
                      </span>
                      <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">
                        {comparisonBaselineNoteDiff.filter((line) => line.kind === "removed").length} removed
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 space-y-2">
                    {comparisonBaselineNoteDiff.length > 0 ? (
                      comparisonBaselineNoteDiff.map((line, index) => (
                        <div
                          key={`${line.kind}-${index}-${line.value}`}
                          className={`rounded-2xl px-4 py-3 text-sm leading-7 ${
                            line.kind === "unchanged"
                              ? "bg-emerald-50 text-emerald-900"
                              : line.kind === "added"
                                ? "bg-violet-50 text-violet-900"
                                : "bg-amber-50 text-amber-900"
                          }`}
                        >
                          <span className="mr-2 text-xs font-semibold uppercase tracking-[0.16em]">
                            {line.kind === "unchanged"
                              ? "Same"
                              : line.kind === "added"
                                ? "Add"
                                : "Remove"}
                          </span>
                          {line.value}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50 px-4 py-6 text-sm text-slate-500">
                        No note lines are available to compare yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={`mt-5 rounded-3xl border px-5 py-4 text-sm ${
            recoveryStatus.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : recoveryStatus.tone === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-slate-200 bg-slate-50 text-slate-600"
          }`}
        >
          <p className="font-semibold">
            Local reset / restore safety
          </p>
          <p className="mt-2 leading-7">{recoveryStatus.message}</p>
          <p className="mt-2 leading-7">
            {recoverySnapshot
              ? `Recoverable snapshot: ${recoverySnapshot.reason} captured at ${new Date(
                  recoverySnapshot.capturedAt
                ).toLocaleString()}.`
              : "No recoverable local snapshot is stored yet."}
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <button
              type="button"
              onClick={handleRestoreRecoverySnapshot}
              disabled={isReplayMode || !recoverySnapshot}
              className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Restore Latest Snapshot
            </button>
            <button
              type="button"
              onClick={clearRecoverySnapshot}
              disabled={isReplayMode || !recoverySnapshot}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
            >
              Clear Recovery Snapshot
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <Link
            href="/prompt-library"
            className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800"
          >
            Review Prompt Vault
          </Link>
          <Link
            href="/transcripts"
            className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Review Transcript Workspace
          </Link>
          <button
            type="button"
            onClick={() => setExecutionStatus("ready")}
            disabled={isReplayMode}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Mark Execution Ready
          </button>
          <button
            type="button"
            onClick={handleConfirmedReset}
            disabled={isReplayMode}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Reset Local Shell State
          </button>
          <button
            type="button"
            onClick={() => applyPreset(mode)}
            disabled={isReplayMode}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Reapply Current Preset
          </button>
          <button
            type="button"
            onClick={handleConfirmedClearTurns}
            disabled={isReplayMode}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Clear Local Turns
          </button>
          <button
            type="button"
            onClick={handleConfirmedClearNotes}
            disabled={isReplayMode}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Clear Local Notes
          </button>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {shouldShowReviewSection("prompts") ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">Prompt References</h3>
              <div className="flex items-center gap-2">
                {renderChangeBadge("prompts")}
                {renderReviewAction("prompts")}
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                  {selectedPromptRefs.length} attached
                </span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {PROMPT_REFERENCE_CANDIDATES.map((ref) => (
                <button
                  key={ref.promptId}
                  type="button"
                  onClick={() => addPromptRef(ref)}
                  disabled={isReplayMode}
                  className="rounded-full border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  Add {ref.title}
                </button>
              ))}
            </div>
            <div className="mt-5 space-y-3">
              {selectedPromptRefs.length > 0 ? (
                selectedPromptRefs.map((ref) => (
                  <article key={ref.promptId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{ref.title}</p>
                        <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                          {ref.category} • {ref.visibility}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePromptRef(ref.promptId)}
                        disabled={isReplayMode}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                  No prompt references attached yet.
                </div>
              )}
            </div>
          </div>
          ) : null}

          {shouldShowReviewSection("transcripts") ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-950">Transcript References</h3>
              <div className="flex items-center gap-2">
                {renderChangeBadge("transcripts")}
                {renderReviewAction("transcripts")}
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                  {selectedTranscriptRefs.length} attached
                </span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {TRANSCRIPT_REFERENCE_CANDIDATES.map((ref) => (
                <button
                  key={ref.transcriptId}
                  type="button"
                  onClick={() => addTranscriptRef(ref)}
                  disabled={isReplayMode}
                  className="rounded-full border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  Add {ref.title}
                </button>
              ))}
            </div>
            <div className="mt-5 space-y-3">
              {selectedTranscriptRefs.length > 0 ? (
                selectedTranscriptRefs.map((ref) => (
                  <article key={ref.transcriptId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{ref.title}</p>
                        <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                          {ref.status}
                        </p>
                        {ref.excerptText ? (
                          <p className="mt-3 text-sm leading-6 text-slate-600">{ref.excerptText}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTranscriptRef(ref.transcriptId)}
                        disabled={isReplayMode}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                  No transcript references attached yet.
                </div>
              )}
            </div>
          </div>
          ) : null}
        </div>

        {reviewMode &&
        !shouldShowReviewSection("prompts") &&
        !shouldShowReviewSection("transcripts") ? (
          <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
            No prompt or transcript attachment changes need review right now.
          </div>
        ) : null}

        <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-950">Local Reference Recommendations</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                These suggestions are deterministic mode rules only. No AI scoring, backend
                orchestration, or hidden ranking is involved.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              {recommendedPromptRefs.length + recommendedTranscriptRefs.length} suggestions
            </span>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Recommended Prompts
              </p>
              <div className="mt-4 space-y-3">
                {recommendedPromptRefs.length > 0 ? (
                  recommendedPromptRefs.map((ref) => (
                    <article key={ref.promptId} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="text-sm font-semibold text-slate-950">{ref.title}</p>
                      <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                        {ref.category} • {ref.visibility}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => addPromptRef(ref)}
                          disabled={isReplayMode}
                          className="rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                        >
                          Attach Prompt
                        </button>
                        <button
                          type="button"
                          onClick={() => ignorePromptRecommendation(ref.promptId)}
                          className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                        >
                          Ignore
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
                    No prompt recommendation is waiting right now. You can keep your current manual
                    attachments as-is.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Recommended Transcripts
              </p>
              <div className="mt-4 space-y-3">
                {recommendedTranscriptRefs.length > 0 ? (
                  recommendedTranscriptRefs.map((ref) => (
                    <article key={ref.transcriptId} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="text-sm font-semibold text-slate-950">{ref.title}</p>
                      <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                        {ref.status}
                      </p>
                      {ref.excerptText ? (
                        <p className="mt-3 text-sm leading-6 text-slate-600">{ref.excerptText}</p>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => addTranscriptRef(ref)}
                          disabled={isReplayMode}
                          className="rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                        >
                          Attach Transcript
                        </button>
                        <button
                          type="button"
                          onClick={() => ignoreTranscriptRecommendation(ref.transcriptId)}
                          className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                        >
                          Ignore
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
                    No transcript recommendation is waiting right now. Existing manual transcript
                    attachments remain untouched.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {shouldShowReviewSection("turns") ? (
        <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Local Session Turns</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Stage user turns and passive assistant envelopes locally so the workspace can prove
                execution readiness before any backend runtime exists.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {renderChangeBadge("turns")}
              {renderReviewAction("turns")}
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                {stagedTurns.length} staged
              </span>
            </div>
          </div>

          <label className="mt-6 block text-sm font-medium text-slate-700">
            Draft User Turn
            <textarea
              className="mt-2 min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-7"
              value={draftUserTurn}
              disabled={isReplayMode}
              onChange={(event) => setDraftUserTurn(event.target.value)}
              placeholder="Stage a user turn here. This will persist locally and remain clearly non-executed."
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <button
              type="button"
              onClick={handleStageDraftTurn}
              disabled={isReplayMode || !draftUserTurn.trim()}
              className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Stage Local Turn
            </button>
            <button
              type="button"
              onClick={() => setAssistantPlaceholder(null)}
              disabled={isReplayMode}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            >
              Clear Assistant Placeholder
            </button>
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
            Local turn layer: <span className="font-semibold text-slate-900">staged only</span>
            <p className="mt-2 leading-7">
              These turns and placeholders are browser-local scaffolding. They are not sent to a
              model, not streamed, and not backed by session-memory runtime yet.
            </p>
          </div>
        </div>
        ) : reviewMode ? (
          <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
            No turn changes need review right now.
          </div>
        ) : null}

        {shouldShowReviewSection("notes") ? (
        <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Local Session Notes</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Stage manual notes, decisions, blockers, and action items locally so note-taking
                mode has a truthful shell before any backend orchestration or summary runtime exists.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {renderChangeBadge("notes")}
              {renderReviewAction("notes")}
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                {stagedNotes.length} notes
              </span>
            </div>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-[220px_1fr]">
            <label className="text-sm font-medium text-slate-700">
              Note Type
              <select
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                value={draftNoteType}
                disabled={isReplayMode}
                onChange={(event) =>
                  setDraftNoteType(event.target.value as SessionNoteRecord["type"])
                }
              >
                {SESSION_NOTE_TYPE_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium text-slate-700">
              Draft Note
              <textarea
                className="mt-2 min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-7"
                value={draftNote}
                disabled={isReplayMode}
                onChange={(event) => setDraftNote(event.target.value)}
                placeholder="Add a manual note, blocker, decision, or action item. This stays local only."
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <button
              type="button"
              onClick={handleStageNote}
              disabled={isReplayMode || !draftNote.trim()}
              className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Stage Local Note
            </button>
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
            Local note layer: <span className="font-semibold text-slate-900">manual only</span>
            <p className="mt-2 leading-7">
              These notes are user-authored placeholders. No summarization runtime, AI note
              generation, or backend persistence is active yet.
            </p>
          </div>
        </div>
        ) : reviewMode ? (
          <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
            No note changes need review right now.
          </div>
        ) : null}

        <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-950">Asset Snapshot</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Audit the working context before any session runtime is introduced. These
                explanations are deterministic mode rules only.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              {selectedPromptRefs.length + selectedTranscriptRefs.length} attached assets
            </span>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Prompt Snapshot
              </p>
              <div className="mt-4 space-y-3">
                {selectedPromptRefs.length > 0 ? (
                  selectedPromptRefs.map((ref) => (
                    <article key={ref.promptId} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="text-sm font-semibold text-slate-950">{ref.title}</p>
                      <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                        {ref.category} • {ref.visibility}
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        Why this matters: {describePromptValue(mode, ref)}
                      </p>
                    </article>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
                    {promptGapHint}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Transcript Snapshot
              </p>
              <div className="mt-4 space-y-3">
                {selectedTranscriptRefs.length > 0 ? (
                  selectedTranscriptRefs.map((ref) => (
                    <article key={ref.transcriptId} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="text-sm font-semibold text-slate-950">{ref.title}</p>
                      <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                        {ref.status}
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        Why this matters: {describeTranscriptValue(mode, ref)}
                      </p>
                    </article>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
                    {transcriptGapHint}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Local Activity Log</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Recent workspace actions are tracked in this browser only so operators can audit
                what changed before any backend runtime exists.
              </p>
            </div>
            <button
              type="button"
              onClick={clearActivityLog}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            >
              Clear Log
            </button>
          </div>

          <div className="mt-6 space-y-3">
            {activityEntries.length > 0 ? (
              activityEntries.map((entry) => (
                <article key={entry.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {entry.type}
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(entry.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">{entry.message}</p>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                No local workspace activity recorded yet.
              </div>
            )}
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Local Handoff Summary</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Compress the current shell into one copyable operator brief before any real backend
                runtime or orchestration exists.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCopyHandoffSummary()}
              className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              {handoffCopyState === "copied" ? "Copied" : "Copy Brief"}
            </button>
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
            <pre className="whitespace-pre-wrap font-[family-name:var(--font-sans)]">
              {handoffSummary}
            </pre>
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Local Session Export / Import</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Move this workspace shell between browser sessions manually. The payload stays
                local-only and does not claim backend memory, cloud sync, or orchestration.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCopyWorkspaceExport()}
              className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              {exportCopyState === "copied" ? "Copied" : "Copy Export JSON"}
            </button>
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
            <p className="font-semibold text-slate-950">Current local export payload</p>
            <p className="mt-2 leading-7 text-slate-600">
              This export contains browser-local session mode, goal, attached references, notes,
              staged turns, and passive execution state only.
            </p>
            <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap font-[family-name:var(--font-sans)]">
              {workspaceExportJson}
            </pre>
          </div>

          <div className="mt-6">
            <label className="text-sm font-medium text-slate-700">
              Import previously exported local session JSON
              <textarea
                className="mt-2 min-h-40 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-7"
                value={importValue}
                disabled={isReplayMode}
                onChange={(event) => setImportValue(event.target.value)}
                placeholder="Paste a local session export payload here to restore this browser-only workspace shell."
              />
            </label>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <button
                type="button"
                onClick={handleImportWorkspaceState}
                disabled={isReplayMode}
                className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800"
              >
                Import Local Session
              </button>
              <button
                type="button"
                onClick={() => setImportValue(workspaceExportJson)}
                disabled={isReplayMode}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
              >
                Load Current Export
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportValue("");
                  setImportState({
                    tone: "idle",
                    message:
                      "Paste a previously exported local session payload to restore this browser-only shell.",
                  });
                }}
                disabled={isReplayMode}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
              >
                Clear Import Area
              </button>
            </div>
            <div
              className={`mt-4 rounded-3xl border px-4 py-4 text-sm ${
                importState.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : importState.tone === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-900"
                    : "border-slate-200 bg-slate-50 text-slate-600"
              }`}
            >
              <p className="font-semibold">
                {importState.tone === "success"
                  ? "Import status: success"
                  : importState.tone === "error"
                    ? "Import status: blocked"
                    : "Import status: waiting"}
              </p>
              <p className="mt-2 leading-7">{importState.message}</p>
            </div>
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Local Template Library</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Save reusable workspace setups in this browser only. Templates keep prompts and
                transcripts linked by reference and do not create backend orchestration or cloud memory.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              {templates.length} templates
            </span>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-[1fr_auto]">
            <label className="text-sm font-medium text-slate-700">
              Template name
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                value={templateName}
                disabled={isReplayMode}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder={`${mode} local template`}
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleSaveTemplate}
                disabled={isReplayMode}
                className="rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Save Current Shell as Template
              </button>
            </div>
          </div>

          <div
            className={`mt-4 rounded-3xl border px-4 py-4 text-sm ${
              templateStatus.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : templateStatus.tone === "error"
                  ? "border-rose-200 bg-rose-50 text-rose-900"
                  : "border-slate-200 bg-slate-50 text-slate-600"
            }`}
          >
            <p className="font-semibold">Template library status</p>
            <p className="mt-2 leading-7">{templateStatus.message}</p>
          </div>

          <div className="mt-6 space-y-3">
            {templates.length > 0 ? (
              templates.map((template) => (
                <article key={template.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{template.name}</p>
                      <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                        {template.state.mode} • {template.state.selectedPromptRefs.length} prompts •{" "}
                        {template.state.selectedTranscriptRefs.length} transcripts •{" "}
                        {template.state.stagedNotes.length} notes
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-600">{template.state.goal}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setComparisonTemplateId(template.id);
                          setTemplateStatus({
                            tone: "idle",
                            message: `Comparing "${template.name}" against the current local shell.`,
                          });
                        }}
                        className="rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                      >
                        Compare
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRenameTemplate(template)}
                        disabled={isReplayMode}
                        className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTemplate(template)}
                        disabled={isReplayMode}
                        className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                No local templates saved yet. Save the current shell when you want a reusable setup.
              </div>
            )}
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Template Comparison
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Preview differences locally before you decide to load a template into the current shell.
                </p>
              </div>
              {comparisonTemplate ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleLoadTemplate(comparisonTemplate)}
                    disabled={isReplayMode}
                    className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                  >
                    Load Compared Template
                  </button>
                  <button
                    type="button"
                    onClick={() => setComparisonTemplateId(null)}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                  >
                    Clear Comparison
                  </button>
                </div>
              ) : null}
            </div>

            {comparisonTemplate ? (
              <div className="mt-5 space-y-3">
                {templateComparisonRows.map((row) => (
                  <article key={row.label} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-950">{row.label}</p>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                          row.status === "same"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {row.status}
                      </span>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Current shell
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-700">{row.currentValue}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Selected template
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-700">{row.templateValue}</p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
                Select a saved template to compare it against the current browser-local shell before loading it.
              </div>
            )}
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Readiness Checklist</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Audit the local shell state before any backend orchestration exists. This is a
                simple mode-aware checklist, not a score or AI prediction.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              {readinessChecklist.summary}
            </span>
          </div>

          <div className="mt-6 space-y-3">
            {readinessChecklist.items.map((item) => (
              <article
                key={item.label}
                className={`rounded-2xl border px-4 py-4 ${
                  item.status === "ready"
                    ? "border-emerald-200 bg-emerald-50"
                    : item.status === "partial"
                      ? "border-amber-200 bg-amber-50"
                      : "border-rose-200 bg-rose-50"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-950">{item.label}</p>
                  <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                    {item.status}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-700">{item.detail}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="panel p-8">
          <h2 className="text-2xl font-semibold text-slate-950">Passive Session Context</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            This preview shows what the session context layer is ready to hold before any backend
            persistence or orchestration runtime is introduced.
          </p>
          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
            <pre className="whitespace-pre-wrap font-[family-name:var(--font-sans)]">
              {JSON.stringify(contextPayloadPreview, null, 2)}
            </pre>
          </div>
        </div>

        <div className="panel p-8">
          <h2 className="text-2xl font-semibold text-slate-950">Passive Execution State</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            Execution is modeled but not active. These previews show the exact contract shapes that
            a future backend runtime can consume without changing the current workspace shell.
          </p>

          <div className="mt-6 grid gap-4">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Create or Resume Session
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-[family-name:var(--font-sans)]">
                {JSON.stringify(executionRequestPreview, null, 2)}
              </pre>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Append Turn Preview
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-[family-name:var(--font-sans)]">
                {JSON.stringify(appendTurnPreview, null, 2)}
              </pre>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Answer Request Preview
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-[family-name:var(--font-sans)]">
                {JSON.stringify(answerRequestPreview, null, 2)}
              </pre>
            </div>
            <div className="rounded-3xl border border-dashed border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
              <p className="font-semibold">Execution placeholder</p>
              <p className="mt-2 leading-7">
                Session execution is currently <span className="font-semibold">{executionState.status}</span>.
                No backend runtime, answer generation, or stream transport is connected yet.
              </p>
            </div>
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Staged Turn History</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                This is the local-only turn ledger for the workspace shell. It proves the frontend
                execution envelope without claiming AI output.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              {stagedTurns.length} turns
            </span>
          </div>

          <div className="mt-6 space-y-3">
            {stagedTurns.length > 0 ? (
              stagedTurns.map((turn) => (
                <article key={turn.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {turn.role} turn
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(turn.createdAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-700">{turn.content}</p>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                No local turns staged yet.
              </div>
            )}
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Assistant Placeholder Envelope
            </p>
            <div className="mt-3 text-sm leading-7 text-slate-700">
              {assistantPlaceholder ? (
                <pre className="whitespace-pre-wrap font-[family-name:var(--font-sans)]">
                  {JSON.stringify(assistantPlaceholder, null, 2)}
                </pre>
              ) : (
                <p className="text-slate-500">
                  No assistant placeholder staged yet. Stage a user turn to preview where the next
                  response envelope will attach.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Staged Note Ledger</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                This local-only note ledger keeps note-taking mode grounded without overclaiming
                memory intelligence or summary automation.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              {stagedNotes.length} notes
            </span>
          </div>

          <div className="mt-6 space-y-3">
            {stagedNotes.length > 0 ? (
              stagedNotes.map((note) => (
                <article key={note.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        {note.type} • {note.status}
                      </p>
                      <p className="mt-3 text-sm leading-7 text-slate-700">{note.content}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => toggleNoteStatus(note.id)}
                        disabled={isReplayMode}
                        className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        {note.status === "open" ? "Mark Resolved" : "Reopen"}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeNote(note.id)}
                        disabled={isReplayMode}
                        className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                No local notes staged yet.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
