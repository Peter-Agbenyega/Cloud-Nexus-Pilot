export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4.1-mini";
const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 6_000;

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

function buildSystemPrompt() {
  return [
    "You are an expert interview coach. Give short, sharp, confident answers first, then optional deeper explanation.",
    "Start with a direct 1-2 sentence answer immediately.",
    "Then continue with concise bullet points that deepen or support the answer.",
    "Keep the answer practical and interview-ready.",
    "Do not mention being an AI.",
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
    "Answer immediately.",
    "The first output must be a short answer in 1-2 sentences.",
    "Then continue with bullet points only.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function streamFailure(controller: ReadableStreamDefaultController<Uint8Array>, message: string) {
  controller.enqueue(toSseChunk({ type: "error", message }));
  controller.enqueue(toSseChunk({ type: "done" }));
  controller.close();
}

export async function POST(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = (await request.json().catch(() => ({}))) as GuidanceRequestBody;
      const question = sanitizeText(body.question, MAX_QUESTION_CHARS);
      const transcriptContext = sanitizeText(body.transcriptContext, MAX_CONTEXT_CHARS);
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
        const openAiResponse = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            max_completion_tokens: 500,
            temperature: 0.3,
            stream: true,
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
          signal: request.signal,
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
            ? "Guidance generation was cancelled."
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
