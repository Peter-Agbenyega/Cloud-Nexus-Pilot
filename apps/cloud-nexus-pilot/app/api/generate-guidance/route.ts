export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1_200;
const GUIDANCE_TIMEOUT_MS = 12_000;

type GuidanceRequestBody = {
  question?: unknown;
  transcriptContext?: unknown;
  interviewMode?: unknown;
  promptRef?: unknown;
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

function buildSystemPrompt() {
  return [
    "You are helping a friend ace their interview. Return ONLY valid JSON: {\"gist\": \"...\", \"key_points\": [\"...\", \"...\"], \"full_answer\": \"...\"}.",
    "Return concise JSON immediately.",
    "Do not over-explain.",
    "No long stories unless explicitly requested.",
    "gist: max 1 short sentence under 18 words.",
    "key_points: exactly 3 short bullets, each under 10 words.",
    "full_answer: 80-120 words max in conversational first-person tone.",
    "Write full_answer in first person, warm and conversational. Use contractions.",
    "Never use: furthermore, moreover, leverage, utilize, delve, streamline, robust, synergy.",
    "Sound like a smart confident friend, not a textbook.",
    "Do not mention being an AI. Do not wrap in markdown code fences.",
  ].join("\n");
}

function buildUserPrompt(input: {
  question: string;
  transcriptContext: string;
  interviewMode: string;
  promptRef?: string;
}) {
  return [
    `Interview mode: ${input.interviewMode || "general"}`,
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

export async function POST(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = (await request.json().catch(() => ({}))) as GuidanceRequestBody;
      const question = sanitizeText(body.question, MAX_QUESTION_CHARS);
      const transcriptContext = sanitizeRecentText(body.transcriptContext, MAX_CONTEXT_CHARS);
      const interviewMode = sanitizeText(body.interviewMode, 80) || "general";
      const promptRef = sanitizeText(body.promptRef, 120);

      controller.enqueue(toSseChunk({ type: "start" }));

      if (!question) {
        await streamFailure(controller, "A detected question is required before guidance can be generated.");
        return;
      }

      const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
      if (!openAiApiKey) {
        await streamFailure(
          controller,
          "OPENAI_API_KEY is not configured on the server, so live guidance is unavailable."
        );
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
                }),
              },
            ],
          }),
          cache: "no-store",
          signal: guidanceSignal,
        });

        if (!openAiResponse.ok || !openAiResponse.body) {
          await streamFailure(
            controller,
            "The guidance model did not return a usable stream. Please try again."
          );
          return;
        }

        const reader = openAiResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
                controller.enqueue(toSseChunk({ type: "done" }));
                controller.close();
                return;
              }

              const payload = JSON.parse(dataText) as {
                choices?: Array<{ delta?: { content?: string | null } }>;
                error?: { message?: string };
              };

              const token = payload.choices?.[0]?.delta?.content;
              if (typeof token === "string" && token.length > 0) {
                controller.enqueue(toSseChunk({ type: "chunk", content: token }));
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
            controller.enqueue(toSseChunk({ type: "done" }));
            controller.close();
            return;
          }
        }
      } catch (error) {
        const message =
          error instanceof Error && error.name === "AbortError"
            ? "Guidance generation timed out or was cancelled."
            : "Unable to generate guidance right now.";
        await streamFailure(controller, message);
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
