import assert from "node:assert/strict";
import { test } from "node:test";

import {
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

test("selects OpenAI only when an OpenAI key is available", () => {
  assert.equal(selectConfiguredLLMProvider({})?.name, undefined);
  assert.equal(
    selectConfiguredLLMProvider({ OPENAI_API_KEY: "openai-key" })?.name,
    "openai"
  );
  assert.equal(
    selectConfiguredLLMProvider({
      OPENAI_API_KEY: "openai-key",
      UNUSED_VENDOR_API_KEY: "unused-key",
    })?.name,
    "openai"
  );
  assert.equal(selectConfiguredLLMProvider({ UNUSED_VENDOR_API_KEY: "unused-key" })?.name, undefined);
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
