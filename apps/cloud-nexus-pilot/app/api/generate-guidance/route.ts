export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { buildInterviewContext, serializeInterviewContextForPrompt } from "@/lib/interview-intelligence/context";
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
  speakNow: "Let me frame this around the problem, the tradeoffs, and the safest next step.",
  keyPoints: ["Clarify scope", "Explain tradeoffs", "Close with impact"],
  example: null,
  technicalDetail: null,
  caution: "Do not claim experience you have not provided.",
  followUp: "Ask what constraint matters most: cost, reliability, security, or delivery speed.",
  gist: "Great question — give me a second to think through that.",
  key_points: ["Clarify the problem", "Show your process", "End with impact"],
  full_answer:
    "That's a great question. Let me take a moment to walk you through my thinking on that. I want to make sure I explain the situation clearly, what I was responsible for, and how I approached the problem step by step. The main thing I focus on in those moments is staying calm, understanding the root issue, communicating clearly with the people involved, and choosing a practical path forward. From there, I would explain the tradeoffs, make the next step clear, and connect the answer back to the result the team needed.",
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

function buildSystemPrompt() {
  return [
    "You are Cloud Nexus Pilot, a fast interview copilot for cloud, DevOps, cybersecurity, IaC, debugging, system design, coding, behavioral, and KSA interviews.",
    "Return ONLY valid JSON immediately with no preamble. Be concise. No markdown fences. Do not over-explain.",
    "JSON shape: {headline, speakNow, keyPoints, example, technicalDetail, caution, followUp, gist, key_points, full_answer}",
    "headline: maximum 8 words.",
    "speakNow: 1-2 first-person lines the candidate can say immediately.",
    "keyPoints/key_points: exactly 3 bullets, each under 10 words.",
    "full_answer: 80 to 130 words maximum, first person conversational tone.",
    "The user is a real person in a live interview. Write the full_answer as if THEY are speaking — first person, warm, natural, using their actual background if provided. Avoid sounding like a chatbot. Vary sentence length. Start with a human opener, not a textbook definition.",
    "For system design, lead with requirements, components, security, scale, tradeoffs, and follow-up question.",
    "For terminal debugging, include likely root cause, next command, risk level, and avoid destructive commands.",
    "For behavioral/KSA, use STAR talking points only when candidate evidence supports them. Do not invent experience.",
    "The candidate may be from any country. Do not assume US-specific experience. Accept international education, work experience from any country, and non-US company names as valid credentials. Treat all backgrounds equally.",
    "Never include anti-proctoring, stealth, evasion, or monitoring circumvention advice.",
  ].join("\n");
}

function buildUserPrompt(input: {
  question: string;
  packedContext: string;
  promptRef?: string;
}) {
  return [
    "Question:",
    input.question,
    "",
    "Packed interview context:",
    input.packedContext,
    "",
    input.promptRef ? `Operator prompt reference: ${input.promptRef}` : "",
    "",
    "Return ONLY valid JSON with the requested fields. Keep live guidance short enough to scan while speaking.",
  ]
    .filter(Boolean)
    .join("\n");
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

function normalizeGuidancePayload(value: unknown): GuidancePayload {
  if (!value || typeof value !== "object") return FALLBACK_GUIDANCE;
  const record = value as Record<string, unknown>;
  const headline =
    typeof record.headline === "string" && record.headline.trim()
      ? limitWords(record.headline, 8)
      : FALLBACK_GUIDANCE.headline;
  const speakNow =
    typeof record.speakNow === "string" && record.speakNow.trim()
      ? limitWords(record.speakNow, 36)
      : typeof record.gist === "string" && record.gist.trim()
        ? limitWords(record.gist, 18)
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
        .slice(0, 3)
        .map((point) => limitWords(point, 9));
  const fullAnswer =
    typeof record.full_answer === "string" && record.full_answer.trim()
      ? limitWords(record.full_answer, 120)
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
                mode: normalizeInterviewMode(interviewMode),
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
                content: buildSystemPrompt(),
              },
              {
                role: "user",
                content: buildUserPrompt({
                  question,
                  packedContext,
                  promptRef: promptRef || undefined,
                }),
              },
            ],
            maxTokens: 240,
            temperature: 0.3,
            responseFormat: "json",
            signal: guidanceSignal,
          })) {
            modelContent += token;
          }
        } catch {
          await streamFallbackGuidance(controller);
          return;
        }

        await streamGuidancePayload(controller, parseGuidancePayload(modelContent));
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
