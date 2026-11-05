import { extractGuidancePreview } from "@/lib/interview-intelligence/guidance-preview";
import { ProviderLimitError, providerLimitErrors } from "@/lib/provider-limits";
import { createHash } from "node:crypto";
import { processingRepository, type Principal, type Reservation } from "@/lib/server/processing-repository";
import { boundaryResponse, processingScope, RequestBoundaryError, withAbort } from "@/lib/server/request-boundary";
import { readJsonObject, invalidJsonObjectResponse } from "@/lib/server/json-request";
import { requireProviderUser } from "@/lib/server/provider-auth";
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

async function streamFailure(controller: ReadableStreamDefaultController<Uint8Array>, message: string, code = "guidance_processing_failed") {
  controller.enqueue(toSseChunk({ type: "error", code, message }));
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


function limitWords(text: string, maxWords: number): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ").slice(0, Math.min(maxWords * 32, 6000));
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
  if (!value || typeof value !== "object") throw new Error("Invalid guidance payload");
  const record = value as Record<string, unknown>;
  const headline =
    typeof record.headline === "string" && record.headline.trim()
      ? limitWords(record.headline, 8)
      : "Guidance";
  const speakNow =
    typeof record.speakNow === "string" && record.speakNow.trim()
      ? limitSentences(record.speakNow, 4, 72)
      : typeof record.gist === "string" && record.gist.trim()
        ? limitSentences(record.gist, 2, 36)
        : "";
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
      : speakNow;

  if (!speakNow) throw new Error("Provider returned empty guidance.");

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
      // Malformed or empty provider output must not become a synthetic answer.
    }
  }

  throw new Error("Provider returned unreadable guidance.");
}

export async function POST(request: Request) {
  const provider = selectConfiguredLLMProvider();
  let principal: Principal | undefined;
  if (provider) {
    const auth = await requireProviderUser(request);
    if (auth.response) return auth.response;
    principal = auth;
  }
  const body = await readJsonObject(request);
  if (!body) return invalidJsonObjectResponse();
  const scope = processingScope(request.signal, GUIDANCE_TIMEOUT_MS);
  const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  const turnIdentity = [sessionId ?? "standalone", sanitizeText(body.questionId, 128) || sanitizeText(body.question, 500), sanitizeText(body.transcriptRevision, 128)];
  const operationId = `guidance:${createHash("sha256").update(JSON.stringify(turnIdentity)).digest("hex")}`;
  let held: Reservation | undefined;
  if (provider && principal && typeof body.question === "string" && body.question.trim()) {
    try {
      if (sessionId) {
        const session = await processingRepository.read(principal, sessionId, 0, scope.signal);
        if (session.status !== "active") throw new RequestBoundaryError(409, "session_stopped", "The session is stopped.");
      }
      held = await processingRepository.reserve(principal, { sessionId, operationId, requestHash, maxUnits: 1000, kind: "guidance" }, scope.signal);
      if (!held.acquired && held.state !== "succeeded") {
        throw new RequestBoundaryError(["quota_exhausted", "concurrency_exceeded"].includes(held.state) ? 429 : 409, "guidance_not_available", "Guidance allowance is exhausted, pending or unavailable. Reload saved work before retrying.");
      }
    } catch (error) { scope.dispose(); return boundaryResponse(error); }
  }
  let providerStarted = false;
  let settled = false;
  let providerIterator: AsyncIterator<string> | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
      if (held?.state === "succeeded") {
        scope.dispose();
        await streamFinalGuidancePayload(controller, normalizeGuidancePayload(held.result));
        return;
      }

      if (!question) {
        scope.dispose();
        await streamFailure(controller, "A detected question is required before guidance can be generated.");
        return;
      }

      if (!provider) {
        scope.dispose();
        await streamFailure(controller, "No guidance provider is configured. No AI guidance was generated.");
        return;
      }

      try {
        const guidanceSignal = scope.signal;
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
        let modelContent = "", lastPreview = "", previewBytes = 0;

        try {
          providerStarted = true;
          if (sessionId && principal) {
            const watch = async () => {
              try {
                const current = await processingRepository.read(principal, sessionId, 0, guidanceSignal);
                if (current.status !== "active") scope.abort();
                else if (!scope.signal.aborted) watchTimer = setTimeout(() => void watch(), 2_000);
              } catch { scope.abort(); }
            };
            watchTimer = setTimeout(() => void watch(), 2_000);
          }
          providerIterator = provider.streamText({
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
          })[Symbol.asyncIterator]();
          while (true) {
            const item = await withAbort(providerIterator.next(), guidanceSignal);
            if (item.done) break;
            const token = item.value;
            modelContent += token;
            if (modelContent.length > 32_768) { scope.abort(); throw new Error("Output limit exceeded"); }
            // Provisional words can appear immediately; only final JSON is saved.
            const preview = extractGuidancePreview(modelContent);
            if (preview && preview !== lastPreview) {
              const chunk = toSseChunk({ type: "preview", speakNow: preview, draft: true });
              // Cumulative previews must leave space for the bounded final payload.
              if (previewBytes + chunk.byteLength <= 65_536) {
                previewBytes += chunk.byteLength; lastPreview = preview;
                controller.enqueue(chunk);
              }
            }
          }
        } catch (error) {
          if (error instanceof ProviderLimitError && Object.hasOwn(providerLimitErrors, error.code)) {
            await streamFailure(controller, providerLimitErrors[error.code].message, error.code);
            return;
          }
          await streamFailure(controller, "The guidance provider failed. No AI guidance was generated.");
          return;
        }

        const payload = parseGuidancePayload(modelContent);
        scope.signal.throwIfAborted();
        if (principal && held?.acquired) {
          const result = await processingRepository.complete(principal, { operationId, requestHash, usedUnits: 1000, outcome: "succeeded", result: { ...payload, question, questionId: sanitizeText(body.questionId, 128) || requestHash, transcriptRevision: sanitizeText(body.transcriptRevision, 128), sessionId: sessionId ?? null } });
          if ((result as { state?: string }).state !== "succeeded") throw new Error("Guidance not committed");
          settled = true;
        }
        await streamFinalGuidancePayload(controller, payload);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          await streamFailure(controller, "The guidance provider failed. No AI guidance was generated.");
          return;
        }
        await streamFailure(controller, "Unable to generate guidance right now.");
      } finally {
        clearTimeout(watchTimer); scope.abort(); scope.dispose();
        if (providerIterator?.return) void providerIterator.return().catch(() => {});
        if (principal && held?.acquired && !settled) {
          await processingRepository.complete(principal, { operationId, requestHash, usedUnits: providerStarted ? 1000 : 0, outcome: providerStarted ? "unknown" : "failed", result: { error: { code: "guidance_incomplete" } } }).catch(() => {});
        }
      }
    },
    cancel() { clearTimeout(watchTimer); scope.abort(); scope.dispose(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
