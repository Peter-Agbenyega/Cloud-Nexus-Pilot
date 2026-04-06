const FILLER_PATTERNS = [
  /\bum\b/gi,
  /\buh\b/gi,
  /\byou know\b/gi,
  /\blike\b/gi,
] as const;
const QUESTION_START_PATTERNS = [
  /^(what|why|how|when|where|who|which)\b/i,
  /^(can|could|would|will|do|does|did|are|is|was|were|have|has)\b/i,
  /^(tell me about|walk me through|describe|explain|share)\b/i,
  /\b(can you|could you|would you|tell me about|walk me through|describe how|explain how)\b/i,
] as const;

export function cleanTranscriptText(transcript: string): string {
  let cleaned = transcript.trim();

  for (const pattern of FILLER_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }

  return cleaned
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([,.!?]){2,}/g, "$1")
    .trim();
}

export function getDetectedQuestion(latestSegment: string): string | null {
  const cleaned = cleanTranscriptText(latestSegment);
  if (!cleaned) return null;

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const looksLikeQuestion =
    cleaned.includes("?") ||
    (wordCount >= 4 && QUESTION_START_PATTERNS.some((pattern) => pattern.test(cleaned)));

  return looksLikeQuestion ? cleaned : null;
}

export function detectQuestionBoundary(latestSegment: string): boolean {
  return Boolean(getDetectedQuestion(latestSegment));
}

export function summarizeTranscriptState(transcript: string): string {
  const cleaned = cleanTranscriptText(transcript);
  if (!cleaned) return "No transcript available yet.";

  if (cleaned.length <= 180) return cleaned;
  return `${cleaned.slice(0, 177).trimEnd()}...`;
}
