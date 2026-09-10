"use client";

import type { User } from "@supabase/supabase-js";

import type { TranscriptSource } from "./contracts/transcription";
import { extractJobProfile, extractResumeProfile } from "./interview-intelligence/profile-ingestion";
import type { InterviewMode, ScreenContext } from "./interview-intelligence/types";
import { supabase, supabaseConfigError } from "./supabase";

export const INTERVIEW_SESSION_STORAGE_KEY = "cloudnexus.interview-sessions.v1";

export type InterviewSessionStatus = "draft" | "active" | "paused" | "ended" | "failed";

export type PersistedInterviewSession = {
  id: string;
  title: string;
  mode: InterviewMode;
  status: InterviewSessionStatus;
  resumeId: string | null;
  jobDescriptionId: string | null;
  companyContext: string;
  notes: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  source: "local" | "remote";
};

export type InterviewPersistenceInfo = {
  mode: "local" | "supabase-ready" | "supabase-active";
  note: string;
  cloudSyncReady: boolean;
  authState: "signed-out-local" | "supabase-ready" | "signed-in-cloud";
  userEmail: string | null;
};

export type CreateInterviewSessionInput = {
  title: string;
  mode: InterviewMode;
  resumeText: string;
  jobDescriptionText: string;
  companyContext: string;
  notes: string;
};

export type PersistTranscriptSegmentInput = {
  sessionId: string;
  clientEventId: string;
  source: TranscriptSource;
  speakerId?: string | number | null;
  text: string;
  isPartial?: boolean;
  capturedAt?: string;
};

export type PersistDetectedQuestionInput = {
  sessionId: string;
  questionId: string;
  transcriptSegmentId?: string | null;
  rawText: string;
  normalizedQuestion: string;
  category: string;
  subcategory?: string | null;
  confidence: number;
  urgency: string;
  requiresVisualContext?: boolean;
  requiresResumeContext?: boolean;
  requiresCodeContext?: boolean;
  detectedAt?: string;
};

export type PersistGuidanceInput = {
  sessionId: string;
  detectedQuestionId?: string | null;
  guidance: {
    headline: string;
    speakNow: string;
    keyPoints: string[];
    example: string | null;
    technicalDetail: string | null;
    caution: string | null;
    followUp: string | null;
    provider: string | null;
    model: string | null;
    latencyMs: number | null;
  };
};

export type PersistScreenContextInput = {
  sessionId: string;
  context: ScreenContext & {
    retainScreenshot?: boolean;
    screenshotStorageKey?: string | null;
  };
};

type LocalInterviewStore = {
  sessions: PersistedInterviewSession[];
  transcriptSegments: PersistTranscriptSegmentInput[];
  detectedQuestions: PersistDetectedQuestionInput[];
  guidanceItems: PersistGuidanceInput[];
  screenContextEvents: PersistScreenContextInput[];
};

function createLocalPersistenceInfo(note?: string): InterviewPersistenceInfo {
  return {
    mode: "local",
    note:
      note ||
      "Interview persistence is local-first. Cloud sync activates when Supabase env, auth, and interview tables are ready.",
    cloudSyncReady: false,
    authState: "signed-out-local",
    userEmail: null,
  };
}

function readLocalStore(): LocalInterviewStore {
  if (typeof window === "undefined") {
    return {
      sessions: [],
      transcriptSegments: [],
      detectedQuestions: [],
      guidanceItems: [],
      screenContextEvents: [],
    };
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(INTERVIEW_SESSION_STORAGE_KEY) || "{}"
    ) as Partial<LocalInterviewStore>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      transcriptSegments: Array.isArray(parsed.transcriptSegments)
        ? parsed.transcriptSegments
        : [],
      detectedQuestions: Array.isArray(parsed.detectedQuestions)
        ? parsed.detectedQuestions
        : [],
      guidanceItems: Array.isArray(parsed.guidanceItems) ? parsed.guidanceItems : [],
      screenContextEvents: Array.isArray(parsed.screenContextEvents)
        ? parsed.screenContextEvents
        : [],
    };
  } catch {
    return {
      sessions: [],
      transcriptSegments: [],
      detectedQuestions: [],
      guidanceItems: [],
      screenContextEvents: [],
    };
  }
}

function writeLocalStore(store: LocalInterviewStore) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(INTERVIEW_SESSION_STORAGE_KEY, JSON.stringify(store));
}

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getAuthenticatedUser(): Promise<{
  user: User | null;
  persistence: InterviewPersistenceInfo;
}> {
  if (!supabase) {
    return {
      user: null,
      persistence: createLocalPersistenceInfo(
        supabaseConfigError ||
          "Supabase is not configured yet, so interview persistence remains local."
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
      persistence: createLocalPersistenceInfo(
        "Supabase auth check failed, so interview persistence remains local."
      ),
    };
  }

  if (!user) {
    return {
      user: null,
      persistence: {
        mode: "supabase-ready",
        note:
          "Supabase is configured, but no signed-in user is active. Interview artifacts stay local until sign-in.",
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
      note: "Authenticated cloud interview persistence is active.",
      cloudSyncReady: true,
      authState: "signed-in-cloud",
      userEmail: user.email ?? null,
    },
  };
}

function mapSessionRow(row: Record<string, unknown>): PersistedInterviewSession {
  return {
    id: String(row.id),
    title: String(row.title ?? "Interview session"),
    mode: String(row.mode ?? "general") as InterviewMode,
    status: String(row.status ?? "draft") as InterviewSessionStatus,
    resumeId: typeof row.resume_id === "string" ? row.resume_id : null,
    jobDescriptionId: typeof row.job_description_id === "string" ? row.job_description_id : null,
    companyContext: String(row.company_context ?? ""),
    notes: String(row.notes ?? ""),
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
    source: "remote",
  };
}

async function createRemoteInterviewSession(
  user: User,
  input: CreateInterviewSessionInput
): Promise<PersistedInterviewSession> {
  let resumeId: string | null = null;
  let jobDescriptionId: string | null = null;

  if (input.resumeText.trim()) {
    const { data, error } = await supabase!
      .from("resumes")
      .insert({
        user_id: user.id,
        title: "Live interview resume",
        raw_text: input.resumeText.trim(),
        profile: extractResumeProfile(input.resumeText),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Resume persistence failed. ${error?.message ?? ""}`.trim());
    resumeId = String(data.id);
  }

  if (input.jobDescriptionText.trim()) {
    const resumeProfile = input.resumeText.trim()
      ? extractResumeProfile(input.resumeText)
      : undefined;
    const { data, error } = await supabase!
      .from("job_descriptions")
      .insert({
        user_id: user.id,
        title: "Live interview job description",
        raw_text: input.jobDescriptionText.trim(),
        company_name: input.companyContext.trim() || null,
        profile: extractJobProfile(input.jobDescriptionText, resumeProfile),
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`Job description persistence failed. ${error?.message ?? ""}`.trim());
    }
    jobDescriptionId = String(data.id);
  }

  const { data, error } = await supabase!
    .from("interview_sessions")
    .insert({
      user_id: user.id,
      resume_id: resumeId,
      job_description_id: jobDescriptionId,
      mode: input.mode,
      status: "active",
      title: input.title.trim() || "Live interview session",
      company_context: input.companyContext.trim(),
      notes: input.notes.trim(),
      started_at: new Date().toISOString(),
    })
    .select(
      "id,title,mode,status,resume_id,job_description_id,company_context,notes,started_at,ended_at,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(`Interview session persistence failed. ${error?.message ?? ""}`.trim());
  }

  return mapSessionRow(data as Record<string, unknown>);
}

function createLocalInterviewSession(input: CreateInterviewSessionInput): PersistedInterviewSession {
  const now = new Date().toISOString();
  const session: PersistedInterviewSession = {
    id: createLocalId("interview-session"),
    title: input.title.trim() || "Live interview session",
    mode: input.mode,
    status: "active",
    resumeId: input.resumeText.trim() ? createLocalId("resume") : null,
    jobDescriptionId: input.jobDescriptionText.trim() ? createLocalId("job") : null,
    companyContext: input.companyContext.trim(),
    notes: input.notes.trim(),
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    source: "local",
  };
  const store = readLocalStore();
  writeLocalStore({ ...store, sessions: [session, ...store.sessions] });
  return session;
}

async function withUserOrLocal<T>(
  remote: (user: User) => Promise<T>,
  local: () => T | Promise<T>
): Promise<{ data: T; persistence: InterviewPersistenceInfo }> {
  const { user, persistence } = await getAuthenticatedUser();

  if (!user) {
    return {
      data: await local(),
      persistence,
    };
  }

  try {
    return {
      data: await remote(user),
      persistence,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Supabase interview persistence failed.";
    return {
      data: await local(),
      persistence: createLocalPersistenceInfo(`${message} Falling back to local interview storage.`),
    };
  }
}

export function createInterviewPersistenceRepository() {
  return {
    async createSession(input: CreateInterviewSessionInput) {
      return withUserOrLocal(
        (user) => createRemoteInterviewSession(user, input),
        () => createLocalInterviewSession(input)
      );
    },

    async endSession(sessionId: string) {
      return withUserOrLocal(
        async (user) => {
          const endedAt = new Date().toISOString();
          const { data, error } = await supabase!
            .from("interview_sessions")
            .update({ status: "ended", ended_at: endedAt, updated_at: endedAt })
            .eq("id", sessionId)
            .eq("user_id", user.id)
            .select(
              "id,title,mode,status,resume_id,job_description_id,company_context,notes,started_at,ended_at,created_at,updated_at"
            )
            .single();
          if (error || !data) throw new Error(`Interview session end failed. ${error?.message ?? ""}`.trim());
          return mapSessionRow(data as Record<string, unknown>);
        },
        () => {
          const endedAt = new Date().toISOString();
          const store = readLocalStore();
          const sessions = store.sessions.map((session) =>
            session.id === sessionId
              ? { ...session, status: "ended" as const, endedAt, updatedAt: endedAt }
              : session
          );
          writeLocalStore({ ...store, sessions });
          return sessions.find((session) => session.id === sessionId) ?? null;
        }
      );
    },

    async saveTranscriptSegment(input: PersistTranscriptSegmentInput) {
      return withUserOrLocal(
        async (user) => {
          const { data, error } = await supabase!
            .from("transcript_segments")
            .insert({
              user_id: user.id,
              interview_session_id: input.sessionId,
              source: input.source,
              speaker_id: input.speakerId == null ? null : String(input.speakerId),
              text: input.text.trim(),
              is_partial: Boolean(input.isPartial),
              client_event_id: input.clientEventId,
              captured_at: input.capturedAt ?? new Date().toISOString(),
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(`Transcript segment save failed. ${error?.message ?? ""}`.trim());
          return String(data.id);
        },
        () => {
          const store = readLocalStore();
          if (
            store.transcriptSegments.some(
              (segment) =>
                segment.sessionId === input.sessionId &&
                segment.clientEventId === input.clientEventId
            )
          ) {
            return input.clientEventId;
          }
          writeLocalStore({
            ...store,
            transcriptSegments: [...store.transcriptSegments, input],
          });
          return input.clientEventId;
        }
      );
    },

    async saveDetectedQuestion(input: PersistDetectedQuestionInput) {
      return withUserOrLocal(
        async (user) => {
          const { data, error } = await supabase!
            .from("detected_questions")
            .insert({
              user_id: user.id,
              interview_session_id: input.sessionId,
              transcript_segment_id: input.transcriptSegmentId ?? null,
              raw_text: input.rawText.trim(),
              normalized_question: input.normalizedQuestion.trim(),
              category: input.category,
              subcategory: input.subcategory ?? null,
              confidence: input.confidence,
              urgency: input.urgency,
              requires_visual_context: Boolean(input.requiresVisualContext),
              requires_resume_context: Boolean(input.requiresResumeContext),
              requires_code_context: Boolean(input.requiresCodeContext),
              detected_at: input.detectedAt ?? new Date().toISOString(),
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(`Detected question save failed. ${error?.message ?? ""}`.trim());
          return String(data.id);
        },
        () => {
          const store = readLocalStore();
          if (store.detectedQuestions.some((question) => question.questionId === input.questionId)) {
            return input.questionId;
          }
          writeLocalStore({
            ...store,
            detectedQuestions: [...store.detectedQuestions, input],
          });
          return input.questionId;
        }
      );
    },

    async saveGuidance(input: PersistGuidanceInput) {
      return withUserOrLocal(
        async (user) => {
          const { data, error } = await supabase!
            .from("guidance_items")
            .insert({
              user_id: user.id,
              interview_session_id: input.sessionId,
              detected_question_id: input.detectedQuestionId ?? null,
              headline: input.guidance.headline,
              speak_now: input.guidance.speakNow,
              key_points: input.guidance.keyPoints,
              example: input.guidance.example ?? null,
              technical_detail: input.guidance.technicalDetail ?? null,
              caution: input.guidance.caution ?? null,
              follow_up: input.guidance.followUp ?? null,
              provider: input.guidance.provider ?? null,
              model: input.guidance.model ?? null,
              latency_ms: input.guidance.latencyMs ?? null,
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(`Guidance save failed. ${error?.message ?? ""}`.trim());
          return String(data.id);
        },
        () => {
          const store = readLocalStore();
          writeLocalStore({
            ...store,
            guidanceItems: [...store.guidanceItems, input],
          });
          return createLocalId("guidance");
        }
      );
    },

    async saveScreenContext(input: PersistScreenContextInput) {
      return withUserOrLocal(
        async (user) => {
          const { data, error } = await supabase!
            .from("screen_context_events")
            .insert({
              user_id: user.id,
              interview_session_id: input.sessionId,
              source_type: input.context.sourceType,
              extracted_text: input.context.extractedText,
              detected_language: input.context.detectedLanguage ?? null,
              error_messages: input.context.errorMessages,
              code_snippet: input.context.codeSnippet ?? null,
              infrastructure_resources: input.context.infrastructureResources,
              diagram_summary: input.context.diagramSummary ?? null,
              confidence: input.context.confidence,
              retain_screenshot: Boolean(input.context.retainScreenshot),
              screenshot_storage_key: input.context.screenshotStorageKey ?? null,
              captured_at: input.context.timestamp,
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(`Screen context save failed. ${error?.message ?? ""}`.trim());
          return String(data.id);
        },
        () => {
          const store = readLocalStore();
          writeLocalStore({
            ...store,
            screenContextEvents: [...store.screenContextEvents, input],
          });
          return createLocalId("screen-context");
        }
      );
    },
  };
}
