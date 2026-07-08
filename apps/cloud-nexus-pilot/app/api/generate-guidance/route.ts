export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1_200;
const GUIDANCE_TIMEOUT_MS = 12_000;
const FALLBACK_GUIDANCE = {
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
};

type GuidancePayload = typeof FALLBACK_GUIDANCE;

function toSseChunk(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sanitizeText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function sanitizeRecentText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(-maxChars) : "";
}

function buildSystemPrompt() {
  return [
    "You are a fast interview coach. Return ONLY valid JSON immediately with no preamble. Be concise. Do not over-explain. No long stories. No corporate buzzwords like furthermore, leverage, utilize, synergy, streamline. Sound like a smart friend giving a quick tip. JSON shape: {gist, key_points, full_answer}",
    "gist: maximum 18 words, one punchy sentence the user can say immediately.",
    "key_points: exactly 3 bullets, each under 10 words.",
    "full_answer: 80 to 120 words maximum, first person conversational tone.",
    "The user is a real person in a live interview. Write the full_answer as if THEY are speaking — first person, warm, natural, using their actual background if provided. Avoid sounding like a chatbot. Vary sentence length. Start with a human opener, not a textbook definition.",
    "The candidate may be from any country. Do not assume US-specific experience. Accept international education, work experience from any country, and non-US company names as valid credentials. Treat all backgrounds equally.",
    "Do not mention being an AI. Do not wrap in markdown code fences.",
  ].join("\n");
}

function buildUserPrompt(input: {
  question: string;
  transcriptContext: string;
  interviewMode: string;
  promptRef?: string;
  userBackground?: string;
}) {
  return [
    `Interview mode: ${input.interviewMode || "general"}`,
    input.userBackground ? input.userBackground : "",
    "",
    "Question:",
    input.question,
    "",
    "Transcript context:",
    input.transcriptContext || "No additional transcript context provided.",
    "",
    "Return ONLY valid JSON with gist, key_points, and full_answer fields. Keep it short.",
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

function getOpenAiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
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
  const gist =
    typeof record.gist === "string" && record.gist.trim()
      ? limitWords(record.gist, 18)
      : FALLBACK_GUIDANCE.gist;
  const keyPoints = Array.isArray(record.key_points)
    ? record.key_points
        .filter((point): point is string => typeof point === "string" && point.trim().length > 0)
        .slice(0, 3)
        .map((point) => limitWords(point, 9))
    : [];
  const fullAnswer =
    typeof record.full_answer === "string" && record.full_answer.trim()
      ? limitWords(record.full_answer, 120)
      : FALLBACK_GUIDANCE.full_answer;

  while (keyPoints.length < 3) {
    keyPoints.push(FALLBACK_GUIDANCE.key_points[keyPoints.length]);
  }

  return {
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

      controller.enqueue(toSseChunk({ type: "start" }));

      if (!question) {
        await streamFailure(controller, "A detected question is required before guidance can be generated.");
        return;
      }

      const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
      if (!openAiApiKey) {
        await streamFallbackGuidance(controller);
        return;
      }

      try {
        const model = getOpenAiModel();
        const guidanceSignal = createTimeoutSignal(request.signal, GUIDANCE_TIMEOUT_MS);
        const openAiResponse = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model,
            max_completion_tokens: 240,
            temperature: 0.3,
            stream: true,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: buildSystemPrompt(),
              },
              {
                role: "user",
                content: buildUserPrompt({
                  question,
                  transcriptContext,
                  interviewMode,
                  promptRef: promptRef || undefined,
                  userBackground: userBackground || undefined,
                }),
              },
            ],
          }),
          cache: "no-store",
          signal: guidanceSignal,
        });

        if (!openAiResponse.ok || !openAiResponse.body) {
          await streamFallbackGuidance(controller);
          return;
        }

        const reader = openAiResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let modelContent = "";

        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

          let boundaryIndex = buffer.indexOf("\n\n");
          while (boundaryIndex >= 0) {
            const rawEvent = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);

            const dataLines = rawEvent
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .filter(Boolean);

            if (dataLines.length > 0) {
              const dataText = dataLines.join("\n");

              if (dataText === "[DONE]") {
                await streamGuidancePayload(controller, parseGuidancePayload(modelContent));
                return;
              }

              let payload: {
                choices?: Array<{ delta?: { content?: string | null } }>;
                error?: { message?: string };
              };
              try {
                payload = JSON.parse(dataText) as {
                  choices?: Array<{ delta?: { content?: string | null } }>;
                  error?: { message?: string };
                };
              } catch {
                await streamGuidancePayload(controller, parseGuidancePayload(modelContent));
                return;
              }

              const token = payload.choices?.[0]?.delta?.content;
              if (typeof token === "string" && token.length > 0) {
                modelContent += token;
              }

              if (payload.error) {
                await streamFailure(
                  controller,
                  payload.error?.message?.trim() || "The guidance model returned an error."
                );
                return;
              }
            }

            boundaryIndex = buffer.indexOf("\n\n");
          }

          if (done) {
            await streamGuidancePayload(controller, parseGuidancePayload(modelContent));
            return;
          }
        }
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
