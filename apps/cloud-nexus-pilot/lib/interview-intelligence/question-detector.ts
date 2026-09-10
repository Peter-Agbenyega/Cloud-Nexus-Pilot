import type { DetectedQuestion, QuestionCategory } from "./types";

const EXPLICIT_QUESTION_PATTERNS = [
  /\?$/,
  /^(what|why|how|when|where|who|which)\b/i,
  /^(can|could|would|will|do|does|did|are|is|was|were|have|has)\b/i,
] as const;

const IMPLICIT_PROMPT_PATTERNS = [
  /\bwalk me through\b/i,
  /\btell me about\b/i,
  /\bdescribe\b/i,
  /\bexplain\b/i,
  /\bdesign\b/i,
  /\bdebug\b/i,
  /\bwhat happens if\b/i,
  /\bhow would you\b/i,
  /\blet's say\b/i,
  /\bsuppose\b/i,
] as const;

const CATEGORY_PATTERNS: Array<{
  category: QuestionCategory;
  subcategory: string | null;
  patterns: RegExp[];
}> = [
  { category: "system_design", subcategory: "architecture", patterns: [/system design/i, /architecture/i, /multi-region/i, /high availability/i, /scale/i] },
  { category: "terminal_debugging", subcategory: "operations", patterns: [/kubectl/i, /terraform error/i, /docker (error|build|compose)/i, /aws cli/i, /accessdenied/i, /permission denied/i, /logs?/i] },
  { category: "coding", subcategory: "implementation", patterns: [/code/i, /algorithm/i, /function/i, /typescript/i, /javascript/i, /python/i, /sql/i, /complexity/i] },
  { category: "terraform", subcategory: "iac", patterns: [/terraform/i, /\biac\b/i, /infrastructure as code/i] },
  { category: "kubernetes", subcategory: "platform", patterns: [/kubernetes/i, /\bk8s\b/i, /pod\b/i, /\bkubernetes deployment\b/i, /service mesh/i] },
  { category: "cybersecurity", subcategory: "security", patterns: [/security/i, /threat/i, /vulnerability/i, /owasp/i, /iam/i, /zero trust/i] },
  { category: "devsecops", subcategory: "pipeline-security", patterns: [/devsecops/i, /sast/i, /dast/i, /supply chain/i, /secrets?/i] },
  { category: "devops", subcategory: "delivery", patterns: [/ci\/cd/i, /pipeline/i, /github actions/i, /deploy/i, /incident/i, /observability/i] },
  { category: "cloud", subcategory: "aws", patterns: [/\baws\b/i, /lambda/i, /vpc/i, /ec2/i, /s3\b/i, /cloudwatch/i] },
  { category: "cloud", subcategory: "azure", patterns: [/\bazure\b/i, /aks\b/i, /entra/i, /resource group/i] },
  { category: "leadership", subcategory: "ownership", patterns: [/lead/i, /stakeholder/i, /mentor/i, /conflict/i, /prioriti[sz]e/i] },
  { category: "behavioral", subcategory: "star", patterns: [/tell me about a time/i, /describe a time/i, /how did you handle/i, /example of/i] },
  { category: "ksa", subcategory: "competency", patterns: [/\bksa\b/i, /knowledge, skills/i, /competenc/i] },
];

const VISUAL_CONTEXT_PATTERNS = [/screen/i, /diagram/i, /whiteboard/i, /shown here/i, /\bthis\b.*\berror\b/i, /\bthis\b.*\bcode\b/i, /terminal/i];
const RESUME_CONTEXT_PATTERNS = [/your experience/i, /your background/i, /project you worked/i, /tell me about a time/i, /resume/i];
const CODE_CONTEXT_PATTERNS = [/code/i, /function/i, /bug/i, /stack trace/i, /terminal/i, /kubectl/i, /terraform/i, /docker/i];

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1");
}

function slug(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function stableQuestionId(text: string, timestampSeed: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `question-${slug(text) || "detected"}-${timestampSeed.slice(0, 10)}-${hash.toString(36)}`;
}

function classifyQuestion(text: string): { category: QuestionCategory; subcategory: string | null } {
  for (const candidate of CATEGORY_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(text))) {
      return { category: candidate.category, subcategory: candidate.subcategory };
    }
  }
  return { category: "general", subcategory: null };
}

function calculateConfidence(text: string): number {
  const hasExplicit = EXPLICIT_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
  const hasImplicit = IMPLICIT_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  let confidence = 0;
  if (hasExplicit) confidence += 0.5;
  if (hasImplicit) confidence += 0.75;
  if (wordCount >= 6) confidence += 0.08;
  if (/[.?!]$/.test(text)) confidence += 0.02;
  return Math.min(0.98, Math.max(0.35, confidence));
}

function isQuestionCandidate(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) return false;
  return (
    EXPLICIT_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    IMPLICIT_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function splitCandidatePrompts(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const sentenceLike = normalized.match(/[^.?!]+[.?!]?/g) ?? [normalized];
  return sentenceLike
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);
}

export function detectStreamingQuestions(input: {
  text: string;
  seenQuestionKeys?: ReadonlySet<string>;
  timestamp?: Date;
}): DetectedQuestion[] {
  const timestamp = input.timestamp ?? new Date();
  const timestampIso = timestamp.toISOString();
  const seen = input.seenQuestionKeys ?? new Set<string>();
  const detected: DetectedQuestion[] = [];

  for (const candidate of splitCandidatePrompts(input.text)) {
    if (!isQuestionCandidate(candidate)) continue;
    const normalizedQuestion = normalizeText(candidate);
    const dedupeKey = createQuestionDedupeKey(normalizedQuestion);
    if (seen.has(dedupeKey)) continue;
    const classification = classifyQuestion(normalizedQuestion);
    const requiresVisualContext = VISUAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalizedQuestion));
    const requiresCodeContext = CODE_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalizedQuestion));

    detected.push({
      id: stableQuestionId(normalizedQuestion, timestampIso),
      timestamp: timestampIso,
      rawText: candidate,
      normalizedQuestion,
      category: classification.category,
      subcategory: classification.subcategory,
      confidence: calculateConfidence(normalizedQuestion),
      urgency: requiresCodeContext || requiresVisualContext ? "high" : "normal",
      requiresVisualContext,
      requiresResumeContext: RESUME_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalizedQuestion)),
      requiresCodeContext,
    });
  }

  return detected;
}

export function createQuestionDedupeKey(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
