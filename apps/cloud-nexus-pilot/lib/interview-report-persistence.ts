"use client";

import type { InterviewReport } from "@/lib/interview-intelligence/types";
import { supabase } from "@/lib/supabase";

export const INTERVIEW_REPORT_STORAGE_KEY = "cloudnexus.interview-reports.guest.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Client = Pick<NonNullable<typeof supabase>, "auth" | "from">;
export type SavedInterviewReport = {
  report: InterviewReport;
  ownerId: string | null;
  source: "local" | "remote";
};
export type ReportTranscriptOption = { id: string; title: string; transcriptText: string; updatedAt: number };

export function createReportOwnerTracker(onChange: () => void) {
  let initialized = false;
  let current: string | null = null;
  return {
    observe(ownerId: string | null) {
      const changed = initialized && current !== ownerId;
      initialized = true;
      current = ownerId;
      if (changed) onChange();
      return changed;
    },
  };
}

export function readReportTranscriptOptions(ownerId: string | null, storage: Storage | null = browserStorage()): ReportTranscriptOption[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem("cloudnexus.transcripts.v1") ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): ReportTranscriptOption[] => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const owned = ownerId === null
        ? record.ownerScope === "local-user" && record.ownerId === null
        : record.ownerScope === "authenticated-user" && record.ownerId === ownerId;
      if (!owned || typeof record.id !== "string" || typeof record.title !== "string" || typeof record.transcriptText !== "string") return [];
      return [{ id: record.id, title: record.title, transcriptText: record.transcriptText, updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0 }];
    }).sort((left, right) => right.updatedAt - left.updatedAt);
  } catch { return []; }
}

const columns = "id,user_id,interview_session_id,question_list,category_breakdown,strong_answers,weak_answers,missed_technical_concepts,communication_issues,recommended_better_answers,likely_follow_up_questions,study_recommendations,overall_score,generated_at";
const textArrays = ["strongAnswers", "weakAnswers", "missedTechnicalConcepts", "communicationIssues", "recommendedBetterAnswers", "likelyFollowUpQuestions", "studyRecommendations"] as const;

function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

async function remote<T>(operation: () => PromiseLike<T>, message: string): Promise<T> {
  try { return await operation(); }
  catch { throw new Error(message); }
}

function isReport(value: unknown): value is InterviewReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return typeof report.id === "string" && report.id.length > 0 &&
    typeof report.sessionId === "string" && typeof report.generatedAt === "string" &&
    Number.isFinite(Date.parse(report.generatedAt)) && Array.isArray(report.questions) &&
    report.questions.every((question) => question && typeof question === "object") &&
    !!report.categoryBreakdown && typeof report.categoryBreakdown === "object" &&
    !Array.isArray(report.categoryBreakdown) &&
    Object.values(report.categoryBreakdown).every((count) => typeof count === "number" && Number.isFinite(count)) &&
    textArrays.every((key) => Array.isArray(report[key]) && report[key].every((item) => typeof item === "string")) &&
    (report.overallScore === null || (typeof report.overallScore === "number" && Number.isFinite(report.overallScore)));
}

async function stableId(ownerId: string, reportId: string, kind: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([ownerId, reportId, kind])));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fromRow(row: Record<string, unknown>, ownerId: string): InterviewReport {
  if (row.user_id !== ownerId) throw new Error("Saved report ownership could not be verified.");
  const report = {
    id: row.id, sessionId: row.interview_session_id, generatedAt: row.generated_at,
    questions: row.question_list, categoryBreakdown: row.category_breakdown,
    strongAnswers: row.strong_answers, weakAnswers: row.weak_answers,
    missedTechnicalConcepts: row.missed_technical_concepts, communicationIssues: row.communication_issues,
    recommendedBetterAnswers: row.recommended_better_answers, likelyFollowUpQuestions: row.likely_follow_up_questions,
    studyRecommendations: row.study_recommendations, overallScore: row.overall_score,
  };
  if (!isReport(report)) throw new Error("Saved report data could not be read.");
  return report;
}

export function createInterviewReportRepository(options: {
  client?: Client | null;
  storage?: Storage | null;
} = {}) {
  const client = options.client === undefined ? supabase : options.client;
  const storage = options.storage === undefined ? browserStorage() : options.storage;

  async function getOwnerId(): Promise<string | null> {
    if (!client) return null;
    try {
      const { data, error } = await client.auth.getUser();
      if (error?.name === "AuthSessionMissingError") return null;
      if (error) throw error;
      return data.user?.id ?? null;
    } catch {
      throw new Error("Your account could not be verified. Report access is paused.");
    }
  }

  async function checkOwner(expected: string | null) {
    if (await getOwnerId() !== expected) throw new Error("Your account changed. Generate the report again before saving.");
  }

  function localReports(): InterviewReport[] {
    if (!storage) return [];
    try {
      const parsed: unknown = JSON.parse(storage.getItem(INTERVIEW_REPORT_STORAGE_KEY) ?? "[]");
      if (!Array.isArray(parsed) || !parsed.every(isReport)) throw new Error("invalid reports");
      return parsed;
    } catch {
      throw new Error("Browser reports could not be read. Existing storage was left unchanged.");
    }
  }

  return {
    getOwnerId,
    async list(): Promise<{ ownerId: string | null; reports: SavedInterviewReport[] }> {
      const ownerId = await getOwnerId();
      if (!ownerId) return { ownerId, reports: localReports().sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).map((report) => ({ report, ownerId, source: "local" })) };
      const { data, error } = await remote(() => client!.from("interview_reports").select(columns).eq("user_id", ownerId).order("generated_at", { ascending: false }), "Account reports could not be loaded. Browser reports were left unchanged.");
      if (error) throw new Error("Account reports could not be loaded. Browser reports were left unchanged.");
      await checkOwner(ownerId);
      return { ownerId, reports: (data ?? []).map((row) => ({ report: fromRow(row as Record<string, unknown>, ownerId), ownerId, source: "remote" })) };
    },
    async save(report: InterviewReport, expectedOwnerId: string | null): Promise<SavedInterviewReport> {
      if (!isReport(report)) throw new Error("The generated report is invalid and was not saved.");
      await checkOwner(expectedOwnerId);
      if (!expectedOwnerId) {
        if (!storage) throw new Error("Browser storage is unavailable. The report was not saved.");
        const reports = localReports();
        const existing = reports.find((item) => item.id === report.id);
        if (existing) return { report: existing, ownerId: null, source: "local" };
        try { storage.setItem(INTERVIEW_REPORT_STORAGE_KEY, JSON.stringify([report, ...reports])); }
        catch { throw new Error("Browser storage could not save the report. Keep this page open and retry."); }
        return { report, ownerId: null, source: "local" };
      }
      const reportId = await stableId(expectedOwnerId, report.id, "report");
      const sessionId = await stableId(expectedOwnerId, report.id, "debrief-session");
      // Stable IDs plus ignoreDuplicates preserve a committed write when its
      // response is lost. Retrying never overwrites an existing report/session.
      const { error: sessionError } = await remote(() => client!.from("interview_sessions").upsert({
        id: sessionId, user_id: expectedOwnerId, title: "Interview debrief", mode: "general", status: "ended",
        started_at: report.generatedAt, ended_at: report.generatedAt,
      }, { onConflict: "id", ignoreDuplicates: true }), "The report session could not be saved. Retry with the same report.");
      if (sessionError) throw new Error("The report session could not be saved. Retry with the same report.");
      await checkOwner(expectedOwnerId);
      const { error } = await remote(() => client!.from("interview_reports").upsert({
        id: reportId, user_id: expectedOwnerId, interview_session_id: sessionId,
        question_list: report.questions, category_breakdown: report.categoryBreakdown,
        strong_answers: report.strongAnswers, weak_answers: report.weakAnswers,
        missed_technical_concepts: report.missedTechnicalConcepts, communication_issues: report.communicationIssues,
        recommended_better_answers: report.recommendedBetterAnswers, likely_follow_up_questions: report.likelyFollowUpQuestions,
        study_recommendations: report.studyRecommendations, overall_score: report.overallScore, generated_at: report.generatedAt,
      }, { onConflict: "id", ignoreDuplicates: true }), "The report save was not confirmed. Retry with the same report.");
      if (error) throw new Error("The report save was not confirmed. Retry with the same report.");
      const { data, error: readError } = await remote(() => client!.from("interview_reports").select(columns).eq("id", reportId).eq("user_id", expectedOwnerId).maybeSingle(), "The saved report could not be confirmed. Retry with the same report.");
      if (readError || !data) throw new Error("The saved report could not be confirmed. Retry with the same report.");
      await checkOwner(expectedOwnerId);
      return { report: fromRow(data as Record<string, unknown>, expectedOwnerId), ownerId: expectedOwnerId, source: "remote" };
    },
  };
}
