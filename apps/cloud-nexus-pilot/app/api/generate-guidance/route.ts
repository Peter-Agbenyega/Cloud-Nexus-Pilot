export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_SONNET_MODEL?.trim() || "claude-3-5-sonnet-latest";
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

function buildSystemPrompt(interviewMode: string) {
  const normalizedMode = interviewMode.trim().toLowerCase();
  const basePrompt = [
    "You are Cloud Nexus Pilot, a live interview copilot.",
    "Your job is to generate short, useful answer guidance for the candidate in real time.",
    "Do not mention being an AI or that you saw a transcript.",
    "Be concrete, fast to scan, and safe for in-call use.",
    "Prefer bullets and short sections over long paragraphs.",
    "Ground the guidance in the provided question and transcript context only.",
  ];

  if (normalizedMode === "technical") {
    basePrompt.push(
      "Optimize for technical interviews.",
      "Return: 1) direct answer angle, 2) key technical points, 3) a concise example or tradeoff."
    );
  } else if (normalizedMode === "behavioral") {
    basePrompt.push(
      "Optimize for behavioral interviews.",
      "Return: 1) the story angle, 2) STAR bullets, 3) the business/result emphasis."
    );
  } else if (normalizedMode === "system_design") {
    basePrompt.push(
      "Optimize for system design interviews.",
      "Return: 1) framing, 2) architecture/components, 3) tradeoffs and scaling risks."
    );
  } else if (normalizedMode === "comparison") {
    basePrompt.push(
      "Optimize for comparison questions.",
      "Return: 1) clear recommendation, 2) side-by-side tradeoffs, 3) when to choose each option."
    );
  } else if (normalizedMode === "follow_up") {
    basePrompt.push(
      "Optimize for follow-up questions.",
      "Answer the exact follow-up directly, then reinforce the strongest supporting detail."
    );
  } else {
    basePrompt.push(
      "Optimize for general interview guidance.",
      "Return: 1) answer angle, 2) supporting bullets, 3) concise closing line."
    );
  }

  return basePrompt.join("\n");
}

function buildUserPrompt(input: {
  question: string;
  transcriptContext: string;
  interviewMode: string;
  promptRef?: string;
}) {
  return [
    `Interview mode: ${input.interviewMode || "general"}`,
    input.promptRef ? `Prompt reference: ${input.promptRef}` : null,
    "",
    "Question:",
    input.question,
    "",
    "Transcript context:",
    input.transcriptContext || "No additional transcript context provided.",
    "",
    "Produce live answer guidance that is immediately usable.",
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

      const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || "";
      if (!anthropicApiKey) {
        await streamFailure(
          controller,
          "ANTHROPIC_API_KEY is not configured on the server, so live guidance is unavailable."
        );
        return;
      }

      try {
        const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 500,
            temperature: 0.2,
            stream: true,
            system: buildSystemPrompt(interviewMode),
            messages: [
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

        if (!anthropicResponse.ok || !anthropicResponse.body) {
          await streamFailure(
            controller,
            "The guidance model did not return a usable stream. Please try again."
          );
          return;
        }

        const reader = anthropicResponse.body.getReader();
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
                type?: string;
                delta?: { text?: string };
                error?: { message?: string };
              };

              if (payload.type === "content_block_delta" && payload.delta?.text) {
                controller.enqueue(toSseChunk({ type: "token", token: payload.delta.text }));
              }

              if (payload.type === "error") {
                await streamFailure(
                  controller,
                  payload.error?.message?.trim() || "The guidance model returned an error."
                );
                return;
              }

              if (payload.type === "message_stop") {
                controller.enqueue(toSseChunk({ type: "done" }));
                controller.close();
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
