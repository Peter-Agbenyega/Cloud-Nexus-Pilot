import { readOpenAiLimitError } from "./server/openai-failure";
import { openAiEndpoint } from "./server/provider-endpoint";
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
  let finished = false;
  let receivedBytes = 0;

  try {
  while (true) {
    const { done, value } = await reader.read();
    receivedBytes += value?.byteLength ?? 0;
    if (receivedBytes > 262_144) throw new Error("Provider response exceeded its limit.");
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n");
    const parsed = splitSseEvents(buffer);
    buffer = parsed.buffer;
    if (buffer.length > 65_536) throw new Error("Provider event exceeded its limit.");

    for (const event of parsed.events) {
      if (event.length > 65_536) throw new Error("Provider event exceeded its limit.");
      for (const dataText of readSseDataLines(event)) {
        if (dataText === "[DONE]") return;
        const payload = JSON.parse(dataText) as {
          choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          error?: { message?: string };
        };
        if (payload.error) throw new Error(payload.error.message || "OpenAI stream error.");
        if (payload.choices?.some((choice) => choice.finish_reason === "stop")) finished = true;
        const token = payload.choices?.[0]?.delta?.content;
        if (typeof token === "string" && token) yield token;
      }
    }

    if (done) {
      if (buffer.trim() || !finished) throw new Error("Incomplete provider stream.");
      return;
    }
  }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createOpenAiProvider(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}): LLMProvider {
  const fetchImpl = params.fetchImpl ?? fetch;
  const model = params.model?.trim() || DEFAULT_OPENAI_MODEL;

  return {
    name: "openai",
    model,
    async *streamText(input) {
      const response = await fetchImpl(openAiEndpoint("chat/completions", params.baseUrl), {
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
        redirect: "error",
        signal: input.signal,
      });

      if (!response.ok) {
        const limitError = await readOpenAiLimitError(response, input.signal);
        if (limitError) throw limitError;
      }
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
      baseUrl: env.OPENAI_BASE_URL,
      fetchImpl,
    });
  }

  return null;
}
