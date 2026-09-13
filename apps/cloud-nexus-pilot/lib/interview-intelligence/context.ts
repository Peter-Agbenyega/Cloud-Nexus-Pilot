import type { DetectedQuestion, InterviewContext, InterviewMode, JobProfile, ResumeProfile, ScreenContext } from "./types";

const MAX_RECENT_TRANSCRIPT_CHARS = 1_500;

function scoreEvidence(text: string, question: DetectedQuestion): number {
  const questionTerms = new Set(
    question.normalizedQuestion
      .toLowerCase()
      .split(/[^a-z0-9+/#-]+/)
      .filter((term) => term.length > 2)
  );
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of questionTerms) {
    if (lower.includes(term)) score += 2;
  }
  if (question.category !== "general" && lower.includes(question.category.replace("_", " "))) score += 3;
  return score;
}

function packEvidence(items: string[], question: DetectedQuestion, limit: number): string[] {
  return [...items]
    .filter((item) => item.trim().length > 0)
    .sort((left, right) => scoreEvidence(right, question) - scoreEvidence(left, question))
    .slice(0, limit);
}

export function buildInterviewContext(input: {
  question: DetectedQuestion;
  recentTranscript: string;
  mode: InterviewMode;
  resumeProfile?: ResumeProfile | null;
  jobProfile?: JobProfile | null;
  companyContext?: string;
  previousAnswers?: string[];
  screenContext?: ScreenContext | null;
  sessionMemory?: string[];
  userPreferences?: string[];
}): InterviewContext {
  const resumeProfile = input.resumeProfile ?? null;
  const jobProfile = input.jobProfile ?? null;
  const resumeEvidence = resumeProfile
    ? packEvidence(
        [
          ...resumeProfile.achievements,
          ...resumeProfile.projects,
          ...resumeProfile.employment,
          ...resumeProfile.leadershipExamples,
          ...resumeProfile.securityExamples,
          ...resumeProfile.certifications,
          ...resumeProfile.technologies,
        ],
        input.question,
        8
      )
    : [];
  const jobEvidence = jobProfile
    ? packEvidence(
        [
          ...jobProfile.requiredSkills,
          ...jobProfile.preferredSkills,
          ...jobProfile.responsibilities,
          ...jobProfile.likelyInterviewTopics,
          ...jobProfile.gaps.map((gap) => `Resume gap to handle carefully: ${gap}`),
        ],
        input.question,
        8
      )
    : [];

  return {
    question: input.question,
    recentTranscript: input.recentTranscript.trim().slice(-MAX_RECENT_TRANSCRIPT_CHARS),
    mode: input.mode,
    resumeEvidence,
    jobEvidence,
    companyContext: input.companyContext?.trim() ? [input.companyContext.trim().slice(0, 800)] : [],
    previousAnswers: (input.previousAnswers ?? []).slice(-4),
    screenContext: input.screenContext ?? null,
    codeOrTerminalContext: input.screenContext?.codeSnippet
      ? [input.screenContext.codeSnippet]
      : input.screenContext?.extractedText
        ? [input.screenContext.extractedText.slice(0, 1_000)]
        : [],
    sessionMemory: (input.sessionMemory ?? []).slice(-8),
    userPreferences: (input.userPreferences ?? []).slice(0, 8),
  };
}

export function serializeInterviewContextForPrompt(context: InterviewContext): string {
  return [
    `Mode: ${context.mode}`,
    `Question category: ${context.question.category}${context.question.subcategory ? ` / ${context.question.subcategory}` : ""}`,
    context.recentTranscript ? `Recent transcript:\n${context.recentTranscript}` : "",
    context.resumeEvidence.length > 0 ? `Candidate evidence:\n- ${context.resumeEvidence.join("\n- ")}` : "Candidate evidence: none provided. Do not invent experience.",
    context.jobEvidence.length > 0 ? `Job evidence:\n- ${context.jobEvidence.join("\n- ")}` : "",
    context.companyContext.length > 0 ? `Company context:\n- ${context.companyContext.join("\n- ")}` : "",
    context.codeOrTerminalContext.length > 0 ? `Visible code or terminal context:\n${context.codeOrTerminalContext.join("\n\n")}` : "",
    context.screenContext ? `Screen context type: ${context.screenContext.sourceType}; confidence ${context.screenContext.confidence}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
