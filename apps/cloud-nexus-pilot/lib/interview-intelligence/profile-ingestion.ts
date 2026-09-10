import type { JobProfile, ResumeProfile } from "./types";

const CLOUD_TECH_TERMS = [
  "aws",
  "azure",
  "gcp",
  "terraform",
  "kubernetes",
  "docker",
  "linux",
  "python",
  "javascript",
  "typescript",
  "bash",
  "sql",
  "github actions",
  "ci/cd",
  "iam",
  "vpc",
  "networking",
  "devsecops",
  "owasp",
  "security",
  "incident response",
  "observability",
  "prometheus",
  "grafana",
] as const;

const CERTIFICATION_PATTERNS = [
  /\bAWS Certified [^\n,.;]+/gi,
  /\bAzure [^\n,.;]+/gi,
  /\bCertified Kubernetes [^\n,.;]+/gi,
  /\bSecurity\+[^\n,.;]*/gi,
  /\bCISSP\b/gi,
  /\bCCNA\b/gi,
] as const;

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n|[•]/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length >= 3);
}

function unique(items: string[], limit = 16): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function findMatchingTerms(text: string): string[] {
  return unique(
    CLOUD_TECH_TERMS.filter((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)),
    24
  );
}

function findPatternMatches(text: string, patterns: readonly RegExp[]): string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    matches.push(...Array.from(text.matchAll(pattern), (match) => match[0]));
  }
  return unique(matches, 12);
}

function selectLines(lines: string[], patterns: RegExp[], limit: number): string[] {
  return unique(
    lines.filter((line) => patterns.some((pattern) => pattern.test(line))),
    limit
  );
}

function summarize(text: string, fallback: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return fallback;
  return cleaned.slice(0, 420);
}

export function extractResumeProfile(text: string): ResumeProfile {
  const lines = normalizeLines(text);
  const technologies = findMatchingTerms(text);
  const achievements = selectLines(lines, [/\b\d+%?\b/, /\breduced\b/i, /\bimproved\b/i, /\bsaved\b/i, /\bautomated\b/i, /\bled\b/i], 10);
  const employment = selectLines(lines, [/\bengineer\b/i, /\bdeveloper\b/i, /\banalyst\b/i, /\barchitect\b/i, /\bconsultant\b/i, /\bmanager\b/i], 8);
  const projects = selectLines(lines, [/\bproject\b/i, /\bmigrat/i, /\bdeploy/i, /\bplatform\b/i, /\bpipeline\b/i], 8);
  const leadershipExamples = selectLines(lines, [/\bled\b/i, /\bmentor/i, /\bstakeholder/i, /\bcross-functional/i, /\bowned\b/i], 8);
  const securityExamples = selectLines(lines, [/\bsecurity\b/i, /\biam\b/i, /\bvulnerab/i, /\bcompliance\b/i, /\bincident\b/i, /\bthreat\b/i], 8);

  return {
    skills: technologies,
    certifications: findPatternMatches(text, CERTIFICATION_PATTERNS),
    employment,
    projects,
    achievements,
    technologies,
    leadershipExamples,
    securityExamples,
    starStories: unique([...achievements, ...leadershipExamples, ...securityExamples], 8),
    summary: summarize(text, "No resume text has been provided yet."),
  };
}

export function extractJobProfile(text: string, resume?: ResumeProfile): JobProfile {
  const lines = normalizeLines(text);
  const keywords = findMatchingTerms(text);
  const requiredSkills = selectLines(lines, [/\brequired\b/i, /\bmust\b/i, /\bminimum\b/i, /\bexperience with\b/i], 10);
  const preferredSkills = selectLines(lines, [/\bpreferred\b/i, /\bnice to have\b/i, /\bplus\b/i], 10);
  const responsibilities = selectLines(lines, [/\bresponsib/i, /\bbuild\b/i, /\bmanage\b/i, /\bdesign\b/i, /\bdeploy\b/i, /\bsecure\b/i], 10);
  const lower = text.toLowerCase();
  const seniority = /\bprincipal\b/.test(lower)
    ? "principal"
    : /\bsenior\b/.test(lower)
      ? "senior"
      : /\blead\b/.test(lower)
        ? "lead"
        : /\bjunior\b|\bentry\b/.test(lower)
          ? "entry"
          : null;
  const resumeSkills = new Set((resume?.technologies ?? []).map((skill) => skill.toLowerCase()));
  const gaps = keywords.filter((keyword) => !resumeSkills.has(keyword.toLowerCase())).slice(0, 10);

  return {
    requiredSkills: requiredSkills.length > 0 ? requiredSkills : keywords.slice(0, 8),
    preferredSkills,
    responsibilities,
    keywords,
    seniority,
    likelyInterviewTopics: unique([...keywords, ...responsibilities.map((line) => line.slice(0, 80))], 12),
    gaps,
    summary: summarize(text, "No job description has been provided yet."),
  };
}
