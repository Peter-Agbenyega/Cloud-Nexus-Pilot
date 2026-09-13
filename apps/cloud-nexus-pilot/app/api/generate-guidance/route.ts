export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { buildInterviewContext, serializeInterviewContextForPrompt } from "@/lib/interview-intelligence/context";
import { buildInterviewSystemPrompt, buildInterviewUserPrompt } from "@/lib/interview-intelligence/natural-speaking";
import { detectStreamingQuestions } from "@/lib/interview-intelligence/question-detector";
import { extractJobProfile, extractResumeProfile } from "@/lib/interview-intelligence/profile-ingestion";
import { createScreenContextFromText } from "@/lib/interview-intelligence/screen-context";
import { diagnoseTerminalArtifact } from "@/lib/interview-intelligence/terminal-debugging";
import type { InterviewMode } from "@/lib/interview-intelligence/types";
import { selectConfiguredLLMProvider } from "@/lib/llm-providers";

const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1_200;
const MAX_DOCUMENT_CHARS = 12_000;
const GUIDANCE_TIMEOUT_MS = 12_000;

type GuidancePayload = {
  headline: string;
  speakNow: string;
  keyPoints: string[];
  example: string | null;
  technicalDetail: string | null;
  caution: string | null;
  followUp: string | null;
  gist: string;
  key_points: string[];
  full_answer: string;
};

const FALLBACK_GUIDANCE: GuidancePayload = {
  headline: "Answer with structure",
  speakNow: "I'd start by clarifying the goal and the main constraint. Then I'd explain the trade-off, pick the safest next step, and tie it back to the impact.",
  keyPoints: ["Clarify the goal", "Name the trade-off", "Pick a safe next step"],
  example: null,
  technicalDetail: null,
  caution: "Do not claim experience you have not provided.",
  followUp: "Ask what constraint matters most: cost, reliability, security, or delivery speed.",
  gist: "I'll frame the answer around the problem, trade-off, and next step.",
  key_points: ["Clarify the goal", "Name the trade-off", "Pick a safe next step"],
  full_answer:
    "I'd start by making sure I understand the problem and the constraint that matters most. From there, I'd explain the trade-off, choose a practical next step, and connect it back to the outcome the team needs. If I have direct experience from my background, I'd use that evidence. If I do not, I'd be clear that I'm describing how I'd approach it rather than claiming I've done that exact thing before.",
};

type GuidanceRequestBody = {
  question?: unknown;
  transcriptContext?: unknown;
  interviewMode?: unknown;
  promptRef?: unknown;
  userBackground?: unknown;
  resumeText?: unknown;
  jobDescriptionText?: unknown;
  companyContext?: unknown;
  screenText?: unknown;
  previousAnswers?: unknown;
};

function toSseChunk(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sanitizeText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function sanitizeRecentText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(-maxChars) : "";
}

function sanitizeStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, maxItems)
        .map((item) => item.trim().slice(0, maxChars))
    : [];
}

function normalizeInterviewMode(value: string): InterviewMode {
  const normalized = value.toLowerCase().replace(/_/g, "-");
  const allowed: InterviewMode[] = [
    "general",
    "behavioral",
    "ksa",
    "leadership",
    "cloud-engineering",
    "aws",
    "azure",
    "devops",
    "devsecops",
    "cybersecurity",
    "kubernetes",
    "terraform-iac",
    "system-design",
    "coding",
    "terminal-debugging",
  ];
  return allowed.includes(normalized as InterviewMode) ? (normalized as InterviewMode) : "general";
}

async function streamFailure(controller: ReadableStreamDefaultController<Uint8Array>, message: string) {
  controller.enqueue(toSseChunk({ type: "error", message }));
  controller.enqueue(toSseChunk({ type: "done" }));
  controller.close();
}

async function streamFallbackGuidance(controller: ReadableStreamDefaultController<Uint8Array>) {
  controller.enqueue(toSseChunk({ type: "chunk", content: JSON.stringify(FALLBACK_GUIDANCE) }));
  controller.enqueue(toSseChunk({ type: "done" }));
  controller.close();
}

async function streamGuidancePayload(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: GuidancePayload
) {
  controller.enqueue(toSseChunk({ type: "chunk", content: JSON.stringify(payload) }));
  controller.enqueue(toSseChunk({ type: "done" }));
  controller.close();
}

async function streamFinalGuidancePayload(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: GuidancePayload
) {
  controller.enqueue(toSseChunk({ type: "final", content: JSON.stringify(payload) }));
  controller.enqueue(toSseChunk({ type: "done" }));
  controller.close();
}

function createTimeoutSignal(parentSignal: AbortSignal, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const abort = () => {
    clearTimeout(timeoutId);
    controller.abort();
  };

  if (parentSignal.aborted) {
    abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        parentSignal.removeEventListener("abort", abort);
      },
      { once: true }
    );
  }

  return controller.signal;
}

function limitWords(text: string, maxWords: number): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}

function limitSentences(text: string, maxSentences: number, maxWords: number): string {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, maxSentences)
    .join(" ");
  return limitWords(sentences || text, maxWords);
}

function normalizeGuidancePayload(value: unknown): GuidancePayload {
  if (!value || typeof value !== "object") return FALLBACK_GUIDANCE;
  const record = value as Record<string, unknown>;
  const headline =
    typeof record.headline === "string" && record.headline.trim()
      ? limitWords(record.headline, 8)
      : FALLBACK_GUIDANCE.headline;
  const speakNow =
    typeof record.speakNow === "string" && record.speakNow.trim()
      ? limitSentences(record.speakNow, 4, 72)
      : typeof record.gist === "string" && record.gist.trim()
        ? limitSentences(record.gist, 2, 36)
        : FALLBACK_GUIDANCE.speakNow;
  const gist =
    typeof record.gist === "string" && record.gist.trim()
      ? limitWords(record.gist, 18)
      : speakNow;
  const rawKeyPoints = Array.isArray(record.keyPoints)
    ? record.keyPoints
    : Array.isArray(record.key_points)
      ? record.key_points
      : [];
  const keyPoints = rawKeyPoints
        .filter((point): point is string => typeof point === "string" && point.trim().length > 0)
        .slice(0, 5)
        .map((point) => limitWords(point, 9));
  const fullAnswer =
    typeof record.full_answer === "string" && record.full_answer.trim()
      ? limitWords(record.full_answer, 180)
      : FALLBACK_GUIDANCE.full_answer;

  while (keyPoints.length < 3) {
    keyPoints.push(FALLBACK_GUIDANCE.key_points[keyPoints.length]);
  }

  return {
    headline,
    speakNow,
    keyPoints,
    example: typeof record.example === "string" && record.example.trim() ? limitWords(record.example, 50) : null,
    technicalDetail:
      typeof record.technicalDetail === "string" && record.technicalDetail.trim()
        ? limitWords(record.technicalDetail, 60)
        : null,
    caution: typeof record.caution === "string" && record.caution.trim() ? limitWords(record.caution, 40) : null,
    followUp: typeof record.followUp === "string" && record.followUp.trim() ? limitWords(record.followUp, 30) : null,
    gist,
    key_points: keyPoints,
    full_answer: fullAnswer,
  };
}

function parseGuidancePayload(rawText: string): GuidancePayload {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      return normalizeGuidancePayload(JSON.parse(jsonMatch[0]));
    } catch {
      // Fall through to regex extraction below.
    }
  }

  const gistMatch = stripped.match(/"gist"\s*:\s*"([^"]+)"/i) ?? stripped.match(/gist\s*[:\-]\s*([^\n.?!]+[.?!]?)/i);
  if (gistMatch?.[1]) {
    return {
      ...FALLBACK_GUIDANCE,
      gist: limitWords(gistMatch[1], 18),
    };
  }

  return FALLBACK_GUIDANCE;
}

export async function POST(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = (await request.json().catch(() => ({}))) as GuidanceRequestBody;
      const question = sanitizeText(body.question, MAX_QUESTION_CHARS);
      const transcriptContext = sanitizeRecentText(body.transcriptContext, MAX_CONTEXT_CHARS);
      const interviewMode = sanitizeText(body.interviewMode, 80) || "general";
      const promptRef = sanitizeText(body.promptRef, 120);
      const userBackground = sanitizeText(body.userBackground, 300);
      const resumeText = sanitizeText(body.resumeText, MAX_DOCUMENT_CHARS) || userBackground;
      const jobDescriptionText = sanitizeText(body.jobDescriptionText, MAX_DOCUMENT_CHARS);
      const companyContext = sanitizeText(body.companyContext, 1_200);
      const screenText = sanitizeText(body.screenText, 4_000);
      const previousAnswers = sanitizeStringArray(body.previousAnswers, 4, 700);

      controller.enqueue(toSseChunk({ type: "start" }));

      if (!question) {
        await streamFailure(controller, "A detected question is required before guidance can be generated.");
        return;
      }

      const provider = selectConfiguredLLMProvider();
      if (!provider) {
        await streamFallbackGuidance(controller);
        return;
      }

      try {
        const guidanceSignal = createTimeoutSignal(request.signal, GUIDANCE_TIMEOUT_MS);
        const detectedQuestion =
          detectStreamingQuestions({ text: question })[0] ??
          detectStreamingQuestions({ text: `What is your answer to: ${question}?` })[0];
        const normalizedMode = normalizeInterviewMode(interviewMode);
        const resumeProfile = resumeText ? extractResumeProfile(resumeText) : null;
        const jobProfile = jobDescriptionText ? extractJobProfile(jobDescriptionText, resumeProfile ?? undefined) : null;
        const screenContext = screenText ? createScreenContextFromText(screenText) : null;
        const terminalDiagnosis =
          screenContext &&
          (screenContext.sourceType === "terminal" ||
            screenContext.errorMessages.length > 0 ||
            detectedQuestion?.category === "terminal_debugging")
            ? diagnoseTerminalArtifact(screenText || question)
            : null;
        const basePackedContext = detectedQuestion
          ? serializeInterviewContextForPrompt(
              buildInterviewContext({
                question: detectedQuestion,
                recentTranscript: transcriptContext,
                mode: normalizedMode,
                resumeProfile,
                jobProfile,
                companyContext,
                previousAnswers,
                screenContext,
              })
            )
          : transcriptContext;
        const packedContext = [
          basePackedContext,
          terminalDiagnosis
            ? [
                "Operational debugging diagnosis:",
                `- Type: ${terminalDiagnosis.artifactType}`,
                `- Diagnosis: ${terminalDiagnosis.diagnosis}`,
                `- Likely root cause: ${terminalDiagnosis.likelyRootCause}`,
                terminalDiagnosis.nextCommand
                  ? `- Next read-only/safe command: ${terminalDiagnosis.nextCommand}`
                  : "",
                `- Risk level: ${terminalDiagnosis.riskLevel}`,
                terminalDiagnosis.dangerousCommand
                  ? "- Caution: visible command includes destructive or high-risk operations; do not recommend automatic execution."
                  : "",
              ]
                .filter(Boolean)
                .join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        let modelContent = "";

        try {
          for await (const token of provider.streamText({
            messages: [
              {
                role: "system",
                content: buildInterviewSystemPrompt({
                  mode: normalizedMode,
                  category: detectedQuestion?.category ?? "general",
                }),
              },
              {
                role: "user",
                content: buildInterviewUserPrompt({
                  question,
                  packedContext,
                  promptRef: promptRef || undefined,
                  mode: normalizedMode,
                  category: detectedQuestion?.category ?? "general",
                }),
              },
            ],
            maxTokens: 420,
            temperature: 0.3,
            responseFormat: "json",
            signal: guidanceSignal,
          })) {
            modelContent += token;
            controller.enqueue(toSseChunk({ type: "token", token }));
          }
        } catch {
          await streamFallbackGuidance(controller);
          return;
        }

        await streamFinalGuidancePayload(controller, parseGuidancePayload(modelContent));
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          await streamFallbackGuidance(controller);
          return;
        }
        await streamFailure(controller, "Unable to generate guidance right now.");
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
