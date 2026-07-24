import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";

import { WebSocket, type RawData } from "ws";

import { getEnvironment, type AppEnvironment } from "./env.js";
import { buildServer, shutdownServer } from "./server.js";
import { WebSocketRuntime } from "./wsRuntime.js";

const ALLOWED_PRODUCTION_ORIGIN = "https://pilot.cloudnexus.ai";
const SECOND_ALLOWED_ORIGIN = "https://app.cloudnexus.ai";

async function startTestServer(t: TestContext, corsOrigin: string, overrides: Partial<AppEnvironment> = {}) {
  const env = getEnvironment({
    NODE_ENV: "test",
    CORS_ORIGIN: corsOrigin,
    ...overrides,
  });
  const app = await buildServer({ env });
  await app.listen({ host: "127.0.0.1", port: 0 });

  t.after(async () => {
    if (app.server.listening) {
      await app.close();
    }
  });

  const address = app.server.address() as AddressInfo;

  return {
    app,
    wsUrl: `ws://127.0.0.1:${address.port}/ws/session`,
  };
}

type ConnectOptions = {
  origin?: string;
  autoPong?: boolean;
  headers?: Record<string, string>;
};

async function connectWebSocket(url: string, options: string | ConnectOptions = {}): Promise<{ ws: WebSocket; readyMessage: Record<string, unknown> }> {
  const resolvedOptions: ConnectOptions = typeof options === "string" ? { origin: options } : options;
  const ws = new WebSocket(url, {
    autoPong: resolvedOptions.autoPong,
    headers: resolvedOptions.headers,
    origin: resolvedOptions.origin,
  });
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

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function expectWebSocketClose(url: string, expectedCode: number, options: string | ConnectOptions = {}): Promise<void> {
  const resolvedOptions: ConnectOptions = typeof options === "string" ? { origin: options } : options;
  const ws = new WebSocket(url, {
    autoPong: resolvedOptions.autoPong,
    headers: resolvedOptions.headers,
    origin: resolvedOptions.origin,
  });

  const closeCode = await new Promise<number>((resolve, reject) => {
    ws.once("close", (code) => resolve(code));
    ws.once("error", reject);
    ws.once("message", () => reject(new Error("WebSocket unexpectedly received a session message")));
    ws.once("unexpected-response", (_request, response) => {
      reject(new Error(`Unexpected response ${response.statusCode ?? "unknown"}`));
    });
  });

  assert.equal(closeCode, expectedCode);
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

async function expectUnavailableWebSocket(url: string, origin: string): Promise<void> {
  const ws = new WebSocket(url, { origin });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.close();
      reject(new Error("WebSocket connection unexpectedly opened"));
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 503);
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

test("rejects oversized WebSocket messages without crashing", async (t) => {
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_MAX_PAYLOAD_BYTES: 64,
  });
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    const closePromise = new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });

    ws.send("x".repeat(65));

    assert.equal(await closePromise, 1009);
    assert.equal(app.webSocketRuntime.activeSessionCount, 0);
  } finally {
    await closeWebSocket(ws);
  }
});

test("enforces the global active-session limit and decrements after close", async (t) => {
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_MAX_CONNECTIONS: 1,
    WS_MAX_CONNECTIONS_PER_IP: 10,
  });
  const first = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(app.webSocketRuntime.activeSessionCount, 1);
    await expectWebSocketClose(wsUrl, 1013, ALLOWED_PRODUCTION_ORIGIN);

    await closeWebSocket(first.ws);
    await waitFor(() => app.webSocketRuntime.activeSessionCount === 0);
    assert.equal(app.webSocketRuntime.activeSessionCount, 0);

    const second = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);
    await closeWebSocket(second.ws);
  } finally {
    await closeWebSocket(first.ws);
  }
});

test("enforces per-IP active-session limits without trusting forwarded headers", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_MAX_CONNECTIONS: 10,
    WS_MAX_CONNECTIONS_PER_IP: 1,
  });
  const first = await connectWebSocket(wsUrl, {
    headers: { "x-forwarded-for": "203.0.113.10" },
    origin: ALLOWED_PRODUCTION_ORIGIN,
  });

  try {
    await expectWebSocketClose(wsUrl, 1013, {
      headers: { "x-forwarded-for": "203.0.113.11" },
      origin: ALLOWED_PRODUCTION_ORIGIN,
    });
  } finally {
    await closeWebSocket(first.ws);
  }
});

test("terminates WebSocket sessions that miss native heartbeat pongs", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_HEARTBEAT_INTERVAL_MS: 20,
    WS_IDLE_TIMEOUT_MS: 1_000,
  });
  const { ws } = await connectWebSocket(wsUrl, {
    autoPong: false,
    origin: ALLOWED_PRODUCTION_ORIGIN,
  });

  try {
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });

    assert.equal(closeCode, 1006);
  } finally {
    await closeWebSocket(ws);
  }
});

test("closes idle WebSocket sessions and resets idle timeout on valid client traffic", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_HEARTBEAT_INTERVAL_MS: 1_000,
    WS_IDLE_TIMEOUT_MS: 50,
  });
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    ws.send(JSON.stringify({ type: "ping", sentAt: new Date().toISOString() }));
    const pongMessage = await receiveJson(ws);
    assert.equal(pongMessage.type, "pong");

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.notEqual(ws.readyState, WebSocket.CLOSED);

    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });
    assert.equal(closeCode, 1001);
  } finally {
    await closeWebSocket(ws);
  }
});

test("graceful shutdown rejects new sessions and closes active sessions with 1012", async (t) => {
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_SHUTDOWN_GRACE_MS: 100,
  });
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);
  const closePromise = new Promise<number>((resolve) => {
    ws.once("close", (code) => resolve(code));
  });

  const shutdownPromise = shutdownServer(app);

  await expectUnavailableWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);
  assert.equal(await closePromise, 1012);
  await shutdownPromise;
});

test("graceful shutdown terminates sockets that remain after the grace period", async () => {
  class FakeSocket extends EventEmitter {
    closeCode: number | undefined;
    terminateCount = 0;

    close(code?: number): void {
      this.closeCode = code;
    }

    ping(): void {}

    terminate(): void {
      this.terminateCount += 1;
      this.emit("close", 1006);
    }
  }

  const runtime = new WebSocketRuntime(
    getEnvironment({
      NODE_ENV: "test",
      CORS_ORIGIN: ALLOWED_PRODUCTION_ORIGIN,
      WS_HEARTBEAT_INTERVAL_MS: 1_000,
      WS_IDLE_TIMEOUT_MS: 1_000,
      WS_SHUTDOWN_GRACE_MS: 5,
    })
  );
  const socket = new FakeSocket();
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  const registration = runtime.registerSession(
    socket as unknown as WebSocket,
    { ip: "127.0.0.1", log: logger } as unknown as Parameters<WebSocketRuntime["registerSession"]>[1],
    "test-session"
  );

  assert.equal(registration.accepted, true);
  socket.once("close", () => {
    if (registration.accepted) {
      registration.cleanup();
    }
  });

  await runtime.shutdown(
    {
      close: async () => {},
      log: logger,
    } as unknown as Parameters<WebSocketRuntime["shutdown"]>[0],
    5
  );

  assert.equal(socket.closeCode, 1012);
  assert.equal(socket.terminateCount, 1);
  assert.equal(runtime.activeSessionCount, 0);
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
