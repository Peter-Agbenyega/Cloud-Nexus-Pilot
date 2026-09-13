export type LLMProviderName = "openai";

export type LLMMessage = {
  role: "system" | "user";
  content: string;
};

export type LLMStreamRequest = {
  messages: LLMMessage[];
  signal: AbortSignal;
  maxTokens: number;
  temperature: number;
  responseFormat: "json";
};

export type LLMProvider = {
  name: LLMProviderName;
  model: string;
  streamText(input: LLMStreamRequest): AsyncIterable<string>;
};

type ProviderEnv = Record<string, string | undefined> & {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
};

type FetchLike = typeof fetch;

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function requireBody(response: Response, provider: LLMProviderName): ReadableStream<Uint8Array> {
  if (!response.ok || !response.body) {
    throw new Error(`${provider} guidance request failed.`);
  }
  return response.body;
}

function splitSseEvents(buffer: string): { events: string[]; buffer: string } {
  const events: string[] = [];
  let nextBuffer = buffer;
  let boundaryIndex = nextBuffer.indexOf("\n\n");

  while (boundaryIndex >= 0) {
    events.push(nextBuffer.slice(0, boundaryIndex));
    nextBuffer = nextBuffer.slice(boundaryIndex + 2);
    boundaryIndex = nextBuffer.indexOf("\n\n");
  }

  return { events, buffer: nextBuffer };
}

function readSseDataLines(rawEvent: string): string[] {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

async function* streamOpenAiTokens(responseBody: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const parsed = splitSseEvents(buffer);
    buffer = parsed.buffer;

    for (const event of parsed.events) {
      for (const dataText of readSseDataLines(event)) {
        if (dataText === "[DONE]") return;
        const payload = JSON.parse(dataText) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
          error?: { message?: string };
        };
        if (payload.error) throw new Error(payload.error.message || "OpenAI stream error.");
        const token = payload.choices?.[0]?.delta?.content;
        if (typeof token === "string" && token) yield token;
      }
    }

    if (done) return;
  }
}

export function createOpenAiProvider(params: {
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
}): LLMProvider {
  const fetchImpl = params.fetchImpl ?? fetch;
  const model = params.model?.trim() || DEFAULT_OPENAI_MODEL;

  return {
    name: "openai",
    model,
    async *streamText(input) {
      const response = await fetchImpl(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: input.maxTokens,
          temperature: input.temperature,
          stream: true,
          response_format: input.responseFormat === "json" ? { type: "json_object" } : undefined,
          messages: input.messages,
        }),
        cache: "no-store",
        signal: input.signal,
      });

      yield* streamOpenAiTokens(requireBody(response, "openai"));
    },
  };
}

export function selectConfiguredLLMProvider(
  env: ProviderEnv = process.env,
  fetchImpl?: FetchLike
): LLMProvider | null {
  const openAiKey = env.OPENAI_API_KEY?.trim() ?? "";

  if (openAiKey) {
    return createOpenAiProvider({
      apiKey: openAiKey,
      model: env.OPENAI_MODEL,
      fetchImpl,
    });
  }

  return null;
}
