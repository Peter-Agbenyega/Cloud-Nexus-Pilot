import { buildInterviewContext } from "./context";
import { detectStreamingQuestions } from "./question-detector";
import { extractJobProfile, extractResumeProfile } from "./profile-ingestion";
import { generateInterviewReport } from "./report";
import type { InterviewMode, InterviewReport } from "./types";

export type MockInterviewDifficulty = "entry" | "mid" | "senior" | "principal";

export type MockInterviewTurn = {
  id: string;
  role: "interviewer" | "candidate";
  text: string;
  createdAt: string;
  score?: number | null;
  feedback?: string | null;
};

export type MockInterviewRequest = {
  resumeText: string;
  jobDescriptionText: string;
  role: string;
  companyContext: string;
  difficulty: MockInterviewDifficulty;
  interviewMode: InterviewMode;
  history: MockInterviewTurn[];
  finish?: boolean;
};

export type MockInterviewResponse = {
  nextQuestion: string | null;
  followUp: string | null;
  score: number | null;
  feedback: string | null;
  report: InterviewReport | null;
  contextSummary: string[];
};

const MODE_QUESTIONS: Record<InterviewMode, string[]> = {
  general: [
    "Walk me through your background and why this role is a strong fit.",
    "What cloud or platform project best represents your current skill level?",
  ],
  behavioral: [
    "Tell me about a time you handled an ambiguous technical problem.",
    "Describe a time you had to influence stakeholders without direct authority.",
  ],
  ksa: [
    "Which knowledge, skills, and abilities from your background map most directly to this role?",
    "Tell me about a situation where you demonstrated the strongest required competency.",
  ],
  leadership: [
    "Tell me about a time you led a technical effort through uncertainty.",
    "How do you handle disagreement during an incident or architecture review?",
  ],
  "cloud-engineering": [
    "How would you design a secure and reliable cloud workload for this role?",
    "Walk me through how you would troubleshoot a production cloud outage.",
  ],
  aws: [
    "How would you debug an AWS IAM AccessDenied error during deployment?",
    "Design a highly available AWS API with secure networking and observability.",
  ],
  azure: [
    "How would you secure an Azure workload with identity, networking, and monitoring?",
    "Walk me through diagnosing an Azure deployment or permissions failure.",
  ],
  devops: [
    "How would you improve a slow or unreliable CI/CD pipeline?",
    "Tell me about a time you automated deployment or infrastructure operations.",
  ],
  devsecops: [
    "How would you add security controls into a CI/CD pipeline without blocking delivery?",
    "Tell me about a time you reduced risk in infrastructure or application delivery.",
  ],
  cybersecurity: [
    "Walk me through your approach to investigating a suspected security incident.",
    "How would you prioritize vulnerability remediation across cloud workloads?",
  ],
  kubernetes: [
    "How would you debug a Kubernetes pod that is stuck in CrashLoopBackOff?",
    "Design a production Kubernetes platform with security and observability.",
  ],
  "terraform-iac": [
    "How would you structure Terraform modules for reusable cloud infrastructure?",
    "Walk me through debugging Terraform drift or a failed apply.",
  ],
  "system-design": [
    "Design a multi-region API platform for high availability and secure operations.",
    "How would you design an event-driven platform with retries and observability?",
  ],
  coding: [
    "How would you approach debugging a failing Python or TypeScript function?",
    "Explain how you evaluate correctness, complexity, and edge cases in code.",
  ],
  "terminal-debugging": [
    "Walk me through how you debug a failing Terraform, kubectl, or AWS CLI command.",
    "What command would you run next when a deployment fails, and why?",
  ],
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function scoreAnswer(answer: string): { score: number; feedback: string } {
  const normalized = answer.toLowerCase();
  let score = 4;
  if (/\b(i would|i did|i led|i built|i designed|i automated|i resolved)\b/.test(normalized)) score += 1;
  if (/\b(tradeoff|risk|security|observability|rollback|least privilege|failure mode)\b/.test(normalized)) score += 1;
  if (/\b\d+%?|\b\d+x\b|\bminutes?\b|\bhours?\b/.test(normalized)) score += 1;
  if (/\b(not sure|maybe|kind of|sort of|don't know)\b/.test(normalized)) score -= 1;

  const boundedScore = Math.max(1, Math.min(9, score));
  const feedback =
    boundedScore >= 7
      ? "Strong answer. Keep the structure and add one crisp tradeoff or result if time allows."
      : boundedScore >= 5
        ? "Usable answer. Make the root cause, action, and outcome more explicit."
        : "Needs structure. Start with the answer, then add a concrete example and result.";

  return { score: boundedScore, feedback };
}

function countCandidateTurns(history: MockInterviewTurn[]): number {
  return history.filter((turn) => turn.role === "candidate").length;
}

function latestCandidateAnswer(history: MockInterviewTurn[]): string {
  return [...history].reverse().find((turn) => turn.role === "candidate")?.text ?? "";
}

function chooseNextQuestion(input: MockInterviewRequest): string {
  const resumeProfile = extractResumeProfile(input.resumeText);
  const jobProfile = extractJobProfile(input.jobDescriptionText, resumeProfile);
  const questions = MODE_QUESTIONS[input.interviewMode] ?? MODE_QUESTIONS.general;
  const answeredCount = countCandidateTurns(input.history);
  const baseQuestion = questions[answeredCount % questions.length];
  const requiredSkill = jobProfile.keywords[answeredCount % Math.max(1, jobProfile.keywords.length)];
  const resumeSkill = resumeProfile.technologies[answeredCount % Math.max(1, resumeProfile.technologies.length)];

  const difficultyFrame =
    input.difficulty === "principal"
      ? " Include cross-team ownership, risk, and tradeoffs."
      : input.difficulty === "senior"
        ? " Include tradeoffs and production impact."
        : input.difficulty === "entry"
          ? " Focus on fundamentals and your reasoning."
          : "";

  if (answeredCount === 0 && input.role.trim()) {
    return `For this ${input.role.trim()} interview, ${baseQuestion}${difficultyFrame}`;
  }

  if (requiredSkill) {
    return `${baseQuestion} Please anchor the answer around ${requiredSkill}.${difficultyFrame}`;
  }

  if (resumeSkill) {
    return `${baseQuestion} Use your ${resumeSkill} experience if relevant.${difficultyFrame}`;
  }

  return `${baseQuestion}${difficultyFrame}`;
}

function chooseFollowUp(input: MockInterviewRequest, score: number | null): string | null {
  const latestAnswer = latestCandidateAnswer(input.history);
  if (!latestAnswer || score === null) return null;
  if (score < 6) return "Can you give a more specific example with your action and the result?";
  if (/\bsecurity|iam|risk|devsecops\b/i.test(latestAnswer)) {
    return "What tradeoff did you make between delivery speed and security risk?";
  }
  if (/\bterraform|kubernetes|aws|azure|docker\b/i.test(latestAnswer)) {
    return "What signal or command would confirm your hypothesis in production?";
  }
  return "What would you do differently if the constraints changed?";
}

export function runMockInterviewTurn(input: MockInterviewRequest): MockInterviewResponse {
  const normalizedHistory = input.history.filter(
    (turn) => turn.text.trim() && (turn.role === "interviewer" || turn.role === "candidate")
  );
  const latestAnswer = latestCandidateAnswer(normalizedHistory);
  const scoreResult = latestAnswer ? scoreAnswer(latestAnswer) : null;
  const transcriptText = normalizedHistory.map((turn) => `${turn.role}: ${turn.text}`).join("\n");

  if (input.finish || countCandidateTurns(normalizedHistory) >= 6) {
    return {
      nextQuestion: null,
      followUp: null,
      score: scoreResult?.score ?? null,
      feedback: scoreResult?.feedback ?? null,
      report: generateInterviewReport({
        sessionId: createId("mock-session"),
        transcriptText,
        knownAnswers: normalizedHistory
          .filter((turn) => turn.role === "candidate")
          .map((turn) => turn.text),
      }),
      contextSummary: [],
    };
  }

  const nextQuestion = chooseNextQuestion({ ...input, history: normalizedHistory });
  const detectedQuestion = detectStreamingQuestions({ text: nextQuestion })[0];
  const contextSummary = detectedQuestion
    ? Array.from(
        new Set(
          buildInterviewContext({
          question: detectedQuestion,
          recentTranscript: transcriptText,
          mode: input.interviewMode,
          resumeProfile: extractResumeProfile(input.resumeText),
          jobProfile: extractJobProfile(input.jobDescriptionText),
          companyContext: input.companyContext,
        }).resumeEvidence.slice(0, 2)
        )
      )
    : [];

  return {
    nextQuestion,
    followUp: chooseFollowUp({ ...input, history: normalizedHistory }, scoreResult?.score ?? null),
    score: scoreResult?.score ?? null,
    feedback: scoreResult?.feedback ?? null,
    report: null,
    contextSummary,
  };
}
