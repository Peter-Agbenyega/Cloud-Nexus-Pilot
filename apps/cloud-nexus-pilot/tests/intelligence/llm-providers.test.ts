import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAnthropicProvider,
  createOpenAiProvider,
  selectConfiguredLLMProvider,
} from "../../lib/llm-providers";

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 }
  );
}

async function collectTokens(provider: ReturnType<typeof createOpenAiProvider>) {
  const tokens: string[] = [];
  for await (const token of provider.streamText({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ],
    signal: new AbortController().signal,
    maxTokens: 32,
    temperature: 0.2,
    responseFormat: "json",
  })) {
    tokens.push(token);
  }
  return tokens.join("");
}

test("selects configured LLM provider by preference and available key", () => {
  assert.equal(selectConfiguredLLMProvider({})?.name, undefined);
  assert.equal(
    selectConfiguredLLMProvider({ OPENAI_API_KEY: "openai-key" })?.name,
    "openai"
  );
  assert.equal(
    selectConfiguredLLMProvider({
      LLM_PROVIDER: "anthropic",
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    })?.name,
    "anthropic"
  );
});

test("OpenAI provider streams chat-completion delta content", async () => {
  let requestUrl = "";
  let authorizationHeader = "";
  const provider = createOpenAiProvider({
    apiKey: "test-openai-key",
    model: "test-openai-model",
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      authorizationHeader = String(new Headers(init?.headers).get("Authorization"));
      const body = JSON.parse(String(init?.body)) as { model?: string; response_format?: { type?: string } };
      assert.equal(body.model, "test-openai-model");
      assert.equal(body.response_format?.type, "json_object");
      return createSseResponse([
        'data: {"choices":[{"delta":{"content":"{\\"headline\\":\\"Hi\\"}"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
  });

  assert.equal(await collectTokens(provider), '{"headline":"Hi"}');
  assert.match(requestUrl, /openai\.com/);
  assert.equal(authorizationHeader, "Bearer test-openai-key");
});

test("Anthropic provider streams message delta text without service SDK dependency", async () => {
  let requestUrl = "";
  let apiKeyHeader = "";
  const provider = createAnthropicProvider({
    apiKey: "test-anthropic-key",
    model: "test-anthropic-model",
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      const headers = new Headers(init?.headers);
      apiKeyHeader = String(headers.get("x-api-key"));
      const body = JSON.parse(String(init?.body)) as { model?: string; system?: string };
      assert.equal(body.model, "test-anthropic-model");
      assert.equal(body.system, "system");
      return createSseResponse([
        'data: {"type":"content_block_delta","delta":{"text":"{\\"headline\\":\\"Hello\\"}"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    },
  });

  const tokens: string[] = [];
  for await (const token of provider.streamText({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ],
    signal: new AbortController().signal,
    maxTokens: 32,
    temperature: 0.2,
    responseFormat: "json",
  })) {
    tokens.push(token);
  }

  assert.equal(tokens.join(""), '{"headline":"Hello"}');
  assert.match(requestUrl, /anthropic\.com/);
  assert.equal(apiKeyHeader, "test-anthropic-key");
});
