import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";

import { WebSocket, type RawData } from "ws";

import { buildServer } from "./server.js";

const ALLOWED_PRODUCTION_ORIGIN = "https://pilot.cloudnexus.ai";
const SECOND_ALLOWED_ORIGIN = "https://app.cloudnexus.ai";

async function startTestServer(t: TestContext, corsOrigin: string) {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
  };

  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGIN = corsOrigin;

  const app = await buildServer();
  await app.listen({ host: "127.0.0.1", port: 0 });

  t.after(async () => {
    await app.close();
    restoreEnv(previousEnv);
  });

  const address = app.server.address() as AddressInfo;

  return {
    app,
    wsUrl: `ws://127.0.0.1:${address.port}/ws/session`,
  };
}

function restoreEnv(previousEnv: { NODE_ENV: string | undefined; CORS_ORIGIN: string | undefined }): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function connectWebSocket(url: string, origin?: string): Promise<{ ws: WebSocket; readyMessage: Record<string, unknown> }> {
  const ws = new WebSocket(url, origin === undefined ? undefined : { origin });
  const readyMessagePromise = receiveJson(ws);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => {
      reject(new Error(`Unexpected response ${response.statusCode ?? "unknown"}`));
    });
  });

  return {
    ws,
    readyMessage: await readyMessagePromise,
  };
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

async function expectForbiddenWebSocket(url: string, origin: string): Promise<void> {
  const ws = new WebSocket(url, { origin });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.close();
      reject(new Error("WebSocket connection unexpectedly opened"));
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 403);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function receiveJson(ws: WebSocket): Promise<Record<string, unknown>> {
  const rawData = await new Promise<RawData>((resolve, reject) => {
    ws.once("message", resolve);
    ws.once("error", reject);
  });

  return JSON.parse(rawData.toString()) as Record<string, unknown>;
}

test("allows a configured production Origin", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, readyMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(readyMessage.type, "session.ready");
  } finally {
    await closeWebSocket(ws);
  }
});

test("allows a second configured Origin", async (t) => {
  const { wsUrl } = await startTestServer(t, `${ALLOWED_PRODUCTION_ORIGIN},${SECOND_ALLOWED_ORIGIN}`);
  const { ws, readyMessage } = await connectWebSocket(wsUrl, SECOND_ALLOWED_ORIGIN);

  try {
    assert.equal(readyMessage.type, "session.ready");
  } finally {
    await closeWebSocket(ws);
  }
});

test("rejects an unauthorized browser Origin with HTTP 403", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);

  await expectForbiddenWebSocket(wsUrl, "https://attacker.example");
});

test("trims whitespace around configured Origins", async (t) => {
  const { wsUrl } = await startTestServer(t, ` ${ALLOWED_PRODUCTION_ORIGIN} , ${SECOND_ALLOWED_ORIGIN} `);
  const { ws, readyMessage } = await connectWebSocket(wsUrl, SECOND_ALLOWED_ORIGIN);

  try {
    assert.equal(readyMessage.type, "session.ready");
  } finally {
    await closeWebSocket(ws);
  }
});

test("allows any Origin when CORS_ORIGIN is wildcard", async (t) => {
  const { wsUrl } = await startTestServer(t, "*");
  const { ws, readyMessage } = await connectWebSocket(wsUrl, "https://attacker.example");

  try {
    assert.equal(readyMessage.type, "session.ready");
  } finally {
    await closeWebSocket(ws);
  }
});

test("allows missing Origin for trusted non-browser clients", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, readyMessage } = await connectWebSocket(wsUrl);

  try {
    assert.equal(readyMessage.type, "session.ready");
  } finally {
    await closeWebSocket(ws);
  }
});

test("preserves ping/pong and session.end behavior", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, readyMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(readyMessage.type, "session.ready");

    ws.send(JSON.stringify({ type: "ping", sentAt: new Date().toISOString() }));
    const pongMessage = await receiveJson(ws);
    assert.equal(pongMessage.type, "pong");

    ws.send(JSON.stringify({ type: "session.end", reason: "test complete" }));
    const endedMessage = await receiveJson(ws);
    assert.equal(endedMessage.type, "session.ended");
    assert.equal(endedMessage.sessionId, readyMessage.sessionId);

    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.once("close", (code) => resolve(code));
      ws.once("error", reject);
    });
    assert.equal(closeCode, 1000);
  } finally {
    await closeWebSocket(ws);
  }
});
