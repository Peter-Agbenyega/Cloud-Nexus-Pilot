export type InterviewMode =
  | "general"
  | "behavioral"
  | "ksa"
  | "leadership"
  | "cloud-engineering"
  | "aws"
  | "azure"
  | "devops"
  | "devsecops"
  | "cybersecurity"
  | "kubernetes"
  | "terraform-iac"
  | "system-design"
  | "coding"
  | "terminal-debugging";

export type QuestionCategory =
  | "behavioral"
  | "ksa"
  | "leadership"
  | "cloud"
  | "devops"
  | "devsecops"
  | "cybersecurity"
  | "kubernetes"
  | "terraform"
  | "system_design"
  | "coding"
  | "terminal_debugging"
  | "general";

export type DetectedQuestion = {
  id: string;
  timestamp: string;
  rawText: string;
  normalizedQuestion: string;
  category: QuestionCategory;
  subcategory: string | null;
  confidence: number;
  urgency: "low" | "normal" | "high";
  requiresVisualContext: boolean;
  requiresResumeContext: boolean;
  requiresCodeContext: boolean;
};

export type ResumeProfile = {
  skills: string[];
  certifications: string[];
  employment: string[];
  projects: string[];
  achievements: string[];
  technologies: string[];
  leadershipExamples: string[];
  securityExamples: string[];
  starStories: string[];
  summary: string;
};

export type JobProfile = {
  requiredSkills: string[];
  preferredSkills: string[];
  responsibilities: string[];
  keywords: string[];
  seniority: string | null;
  likelyInterviewTopics: string[];
  gaps: string[];
  summary: string;
};

export type ScreenContext = {
  timestamp: string;
  sourceType:
    | "ide"
    | "terminal"
    | "browser"
    | "cloud-console"
    | "architecture-diagram"
    | "whiteboard"
    | "error-dialog"
    | "documentation"
    | "unknown";
  extractedText: string;
  detectedLanguage: string | null;
  errorMessages: string[];
  codeSnippet: string | null;
  infrastructureResources: string[];
  diagramSummary: string | null;
  confidence: number;
};

export type InterviewContext = {
  question: DetectedQuestion;
  recentTranscript: string;
  mode: InterviewMode;
  resumeEvidence: string[];
  jobEvidence: string[];
  companyContext: string[];
  previousAnswers: string[];
  screenContext: ScreenContext | null;
  codeOrTerminalContext: string[];
  sessionMemory: string[];
  userPreferences: string[];
};

export type GuidanceItem = {
  id: string;
  questionId: string;
  headline: string;
  speakNow: string;
  keyPoints: string[];
  example: string | null;
  technicalDetail: string | null;
  caution: string | null;
  followUp: string | null;
};

export type InterviewReport = {
  id: string;
  sessionId: string;
  generatedAt: string;
  questions: DetectedQuestion[];
  categoryBreakdown: Record<QuestionCategory, number>;
  strongAnswers: string[];
  weakAnswers: string[];
  missedTechnicalConcepts: string[];
  communicationIssues: string[];
  recommendedBetterAnswers: string[];
  likelyFollowUpQuestions: string[];
  studyRecommendations: string[];
  overallScore: number | null;
};
