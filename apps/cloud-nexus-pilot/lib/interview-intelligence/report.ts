import { detectStreamingQuestions } from "./question-detector";
import type { InterviewReport, QuestionCategory } from "./types";

const TECHNICAL_TERMS = [
  "aws",
  "azure",
  "terraform",
  "kubernetes",
  "docker",
  "iam",
  "vpc",
  "ci/cd",
  "observability",
  "security",
  "owasp",
  "networking",
  "linux",
  "python",
  "typescript",
  "sql",
] as const;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.?!]+[.?!]?/g) ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function categoryBreakdown(questions: InterviewReport["questions"]): Record<QuestionCategory, number> {
  const counts = {} as Record<QuestionCategory, number>;
  for (const question of questions) {
    counts[question.category] = (counts[question.category] ?? 0) + 1;
  }
  return counts;
}

function findMentionedTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return TECHNICAL_TERMS.filter((term) => lower.includes(term));
}

export function generateInterviewReport(input: {
  sessionId: string;
  transcriptText: string;
  knownAnswers?: string[];
}): InterviewReport {
  const transcriptText = input.transcriptText.trim();
  const questions = detectStreamingQuestions({ text: transcriptText });
  const mentionedTerms = findMentionedTerms(transcriptText);
  const answers = input.knownAnswers?.filter((answer) => answer.trim().length > 0) ?? [];
  const sentences = splitSentences(transcriptText);
  const strongSignals = sentences
    .filter((sentence) => /\b(reduced|improved|led|designed|built|automated|secured|resolved)\b/i.test(sentence))
    .slice(0, 5);
  const weakSignals = sentences
    .filter((sentence) => /\b(not sure|maybe|i think|kind of|sort of|don't know)\b/i.test(sentence))
    .slice(0, 5);
  const missedTechnicalConcepts = TECHNICAL_TERMS.filter((term) => !mentionedTerms.includes(term)).slice(0, 6);

  return {
    id: createId("report"),
    sessionId: input.sessionId || createId("session"),
    generatedAt: new Date().toISOString(),
    questions,
    categoryBreakdown: categoryBreakdown(questions),
    strongAnswers:
      strongSignals.length > 0
        ? strongSignals
        : answers.slice(0, 3),
    weakAnswers: weakSignals,
    missedTechnicalConcepts,
    communicationIssues:
      weakSignals.length > 0
        ? ["Reduce hedging language and state assumptions more directly."]
        : [],
    recommendedBetterAnswers: questions.slice(0, 3).map((question) =>
      `For "${question.normalizedQuestion}", lead with a clear answer, then add one concrete example and one tradeoff.`
    ),
    likelyFollowUpQuestions: questions.slice(0, 4).map((question) =>
      question.category === "system_design"
        ? "What bottleneck or failure mode would you address first?"
        : question.category === "terminal_debugging"
          ? "What command would you run next, and what output would confirm your hypothesis?"
          : `Can you give a specific example related to ${question.subcategory ?? question.category}?`
    ),
    studyRecommendations: missedTechnicalConcepts.map((term) => `Review ${term} interview scenarios and troubleshooting patterns.`),
    overallScore: transcriptText.length < 200 ? null : Math.min(9, Math.max(5, 6 + strongSignals.length - Math.ceil(weakSignals.length / 2))),
  };
}
