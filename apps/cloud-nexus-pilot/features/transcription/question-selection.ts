import { cleanTranscriptText, getDetectedQuestion } from "./transcript-bridge";

const WEAK_TRAILING_QUESTION_PATTERNS = [
  /\babout the time you\s*$/i,
  /\babout a time you\s*$/i,
  /\btell me about\s*$/i,
  /\bcan you tell me\s*$/i,
  /\bcould you tell me\s*$/i,
  /\bhow would you\s*$/i,
  /\bwhat would you\s*$/i,
] as const;

function normalizeTranscriptForFiltering(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\[\](){}]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countMeaningfulWords(text: string): number {
  return normalizeTranscriptForFiltering(text)
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .length;
}

export function isIncompleteDetectedQuestion(text: string): boolean {
  const cleaned = cleanTranscriptText(text);
  if (!cleaned) return true;
  if (/[?]["']?\s*$/.test(cleaned)) return false;
  if (WEAK_TRAILING_QUESTION_PATTERNS.some((pattern) => pattern.test(cleaned))) return true;

  return countMeaningfulWords(cleaned) < 8;
}

// Keep the most recent complete question when later chunks contain statements,
// silence, or an unfinished prompt. Extract the question without trailing narration.
type QuestionCandidate = { question: string; key: string; position: number };
export type BoundDetectedQuestion = { question: string; sourceKey: string; position: number };
type QuestionSegments = ReadonlyArray<{ text: string }>;

function scanQuestionCandidates(segments: QuestionSegments) {
  let latest: QuestionCandidate | null = null, complete: QuestionCandidate | null = null;
  let unfinished = "", unfinishedPosition = 0, position = 0;
  const startsPrompt = /^(what|why|how|when|where|who|which|can|could|would|will|do|does|did|are|is|was|were|have|has|tell me about|walk me through|describe|explain|share)\b/i;
  for (const segment of segments) {
    const sentences = cleanTranscriptText(segment.text).split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (!sentence) continue;
      // Keep the opening words when a question spans separately saved chunks.
      // A completed statement is not evidence that the unfinished prompt grew.
      const continues = Boolean(unfinished && !startsPrompt.test(sentence) && !/[.!]["']?\s*$/.test(sentence));
      const candidate = continues ? cleanTranscriptText(`${unfinished} ${sentence}`) : sentence;
      const candidatePosition = continues ? unfinishedPosition : position;
      const question = getDetectedQuestion(candidate);
      if (question || startsPrompt.test(candidate)) {
        latest = { question: candidate, key: `${candidatePosition}:${detectedQuestionKey(candidate)}`, position: candidatePosition };
        if (question && !isIncompleteDetectedQuestion(question)) complete = latest;
      }
      unfinished = !/[.!?]["']?\s*$/.test(candidate) && startsPrompt.test(candidate) ? candidate : "";
      unfinishedPosition = candidatePosition;
      position += 1;
    }
  }
  return { latest, complete };
}

// Normalization is a fallback, not a prerequisite for answering a complete
// question. Tiny unfinished openings wait for words instead of paying for a guess.
export function questionNormalizationCandidate(segments: QuestionSegments, acceptedSourceKey: string | null = null): QuestionCandidate | null {
  const { latest, complete } = scanQuestionCandidates(segments);
  if (!latest || latest.key === complete?.key || latest.key === acceptedSourceKey || !getDetectedQuestion(latest.question)) return null;
  return latest;
}

export function latestCompleteQuestion(segments: QuestionSegments): string {
  return scanQuestionCandidates(segments).complete?.question ?? "";
}

// The correction belongs to the candidate that was sent, not whichever
// transcript happens to be displayed when the asynchronous response arrives.
export function bindDetectedQuestion(question: string, requested: QuestionSegments, current: QuestionSegments): BoundDetectedQuestion | null {
  const source = scanQuestionCandidates(requested).latest;
  const latest = scanQuestionCandidates(current).latest;
  const corrected = latestCompleteQuestion([{ text: question }]);
  if (!source || source.key !== latest?.key || !corrected) return null;
  return { question: corrected, sourceKey: source.key, position: source.position };
}

export function selectDetectedQuestion(segments: QuestionSegments, correction: BoundDetectedQuestion | null): string {
  const local = scanQuestionCandidates(segments).complete;
  // A completed correction remains current through noise or the next unfinished
  // prompt. A newer local question (or a revision of the same candidate) wins.
  if (correction && (!local || correction.position > local.position ||
      (correction.position === local.position && correction.sourceKey === local.key))) return correction.question;
  return local?.question ?? "";
}

export function detectedQuestionKey(question: string): string {
  // Ignore sentence punctuation, not technical distinctions such as C++/C#.
  return cleanTranscriptText(question).slice(0, 500).toLowerCase()
    .replace(/[.,!?;:"“”'‘’]/g, "").replace(/\s+/g, " ").trim();
}

export function shouldReplaceDetectedQuestion(activeQuestion: string, nextQuestion: string): boolean {
  const nextKey = detectedQuestionKey(nextQuestion);
  return Boolean(nextKey && nextKey !== detectedQuestionKey(activeQuestion));
}
