import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";

import Fastify from "fastify";
import { WebSocket, type RawData } from "ws";

import {
  AuthVerificationError,
  createSignalAwareFetch,
  validateSupabaseClaims,
  type AuthVerifier,
  type VerifiedAuthToken,
} from "./authVerifier.js";
import { getEnvironment, type AppEnvironment } from "./env.js";
import { buildServer, getTrustProxyOption, shutdownServer } from "./server.js";
import { WebSocketRuntime } from "./wsRuntime.js";

const ALLOWED_PRODUCTION_ORIGIN = "https://pilot.cloudnexus.ai";
const SECOND_ALLOWED_ORIGIN = "https://app.cloudnexus.ai";
type TestEnvironmentOverrides = Partial<Omit<AppEnvironment, "WS_TRUSTED_PROXY_CIDRS">> & {
  WS_TRUSTED_PROXY_CIDRS?: string | string[];
};

const VALID_TOKEN = "valid-access-token";
const REFRESH_TOKEN = "refresh-access-token";
const OTHER_USER_TOKEN = "other-user-access-token";
const INVALID_TOKEN = "invalid-access-token";
const TEST_USER_ID = "user-123";
const OTHER_USER_ID = "user-456";

function futureExpiry(seconds = 60): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function makeVerifiedToken(userId = TEST_USER_ID, seconds = 60): VerifiedAuthToken {
  return {
    userId,
    expiresAtEpochSeconds: futureExpiry(seconds),
  };
}

function createFakeAuthVerifier(overrides: Record<string, VerifiedAuthToken | Error> = {}): AuthVerifier {
  return {
    async verifyAccessToken(accessToken: string, _signal: AbortSignal): Promise<VerifiedAuthToken> {
      const configured = overrides[accessToken];
      if (configured instanceof Error) {
        throw configured;
      }

      if (configured !== undefined) {
        return configured;
      }

      if (accessToken === VALID_TOKEN || accessToken === REFRESH_TOKEN) {
        return makeVerifiedToken();
      }

      if (accessToken === OTHER_USER_TOKEN) {
        return makeVerifiedToken(OTHER_USER_ID);
      }

      throw new AuthVerificationError("unverifiable");
    },
  };
}

function createControlledVerifier() {
  let resolveVerification: (token: VerifiedAuthToken) => void = () => {};
  let rejectVerification: (error: Error) => void = () => {};
  const signals: AbortSignal[] = [];
  const verifier: AuthVerifier = {
    verifyAccessToken: (_accessToken: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<VerifiedAuthToken>((resolve, reject) => {
        resolveVerification = resolve;
        rejectVerification = reject;
      });
    },
  };

  return {
    verifier,
    resolveVerification: (token: VerifiedAuthToken): void => resolveVerification(token),
    rejectVerification: (error: Error): void => rejectVerification(error),
    signals,
  };
}

function createAbortRejectingVerifier() {
  const signals: AbortSignal[] = [];
  const verifier: AuthVerifier = {
    verifyAccessToken: (_accessToken: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<VerifiedAuthToken>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new AuthVerificationError("aborted"));
          return;
        }

        signal.addEventListener("abort", () => reject(new AuthVerificationError("aborted")), { once: true });
      });
    },
  };

  return {
    verifier,
    signals,
  };
}

async function startTestServer(
  t: TestContext,
  corsOrigin: string,
  overrides: TestEnvironmentOverrides = {},
  authVerifier: AuthVerifier = createFakeAuthVerifier(),
  loggerStream?: NodeJS.WritableStream
) {
  const env = getEnvironment({
    NODE_ENV: "test",
    CORS_ORIGIN: corsOrigin,
    SUPABASE_URL: "http://localhost",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    ...overrides,
  });
  const app = await buildServer({ authVerifier, env, loggerStream });
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

async function connectWebSocket(url: string, options: string | ConnectOptions = {}): Promise<{ ws: WebSocket; firstMessage: Record<string, unknown> }> {
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
    firstMessage: await readyMessagePromise,
  };
}

async function authenticateWebSocket(ws: WebSocket, accessToken = VALID_TOKEN): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({ type: "session.authenticate", accessToken }));
  return receiveJson(ws);
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

async function receiveJsonWithin(ws: WebSocket, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      resolve(undefined);
    }, timeoutMs);

    const onMessage = (rawData: RawData): void => {
      clearTimeout(timer);
      ws.off("error", onError);
      resolve(JSON.parse(rawData.toString()) as Record<string, unknown>);
    };

    const onError = (error: Error): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(error);
    };

    ws.once("message", onMessage);
    ws.once("error", onError);
  });
}

async function expectCloseCode(ws: WebSocket): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    ws.once("close", (code) => resolve(code));
    ws.once("error", reject);
  });
}

async function resolveFastifyRequestIp(envOverrides: TestEnvironmentOverrides, headers: Record<string, string>, remoteAddress = "127.0.0.1"): Promise<string> {
  const env = getEnvironment({
    NODE_ENV: "test",
    CORS_ORIGIN: ALLOWED_PRODUCTION_ORIGIN,
    ...envOverrides,
  });
  const app = Fastify({
    trustProxy: getTrustProxyOption(env),
  });

  app.get("/ip", async (request) => {
    return { ip: request.ip };
  });

  try {
    const response = await app.inject({
      headers,
      method: "GET",
      remoteAddress,
      url: "/ip",
    });
    const payload = JSON.parse(response.payload) as { ip: string };
    return payload.ip;
  } finally {
    await app.close();
  }
}

test("allows a configured production Origin", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, firstMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
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

test("ignores forwarded client IP headers when trusted proxy is disabled", async () => {
  const ip = await resolveFastifyRequestIp({}, { "x-forwarded-for": "203.0.113.10" }, "127.0.0.1");

  assert.equal(ip, "127.0.0.1");
});

test("uses forwarded client IP only from configured trusted proxy addresses", async () => {
  const ip = await resolveFastifyRequestIp(
    {
      WS_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    },
    { "x-forwarded-for": "203.0.113.10" },
    "127.0.0.1"
  );

  assert.equal(ip, "203.0.113.10");
});

test("does not accept a spoofed forwarded client IP from an untrusted peer", async () => {
  const ip = await resolveFastifyRequestIp(
    {
      WS_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    },
    { "x-forwarded-for": "203.0.113.10" },
    "198.51.100.20"
  );

  assert.equal(ip, "198.51.100.20");
});

test("production Supabase auth configuration fails closed when invalid", async () => {
  assert.throws(
    () =>
      getEnvironment({
        NODE_ENV: "production",
        CORS_ORIGIN: ALLOWED_PRODUCTION_ORIGIN,
      }),
    /Invalid environment configuration/
  );

  assert.throws(
    () =>
      getEnvironment({
        NODE_ENV: "production",
        CORS_ORIGIN: ALLOWED_PRODUCTION_ORIGIN,
        SUPABASE_URL: "http://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
      }),
    /Invalid environment configuration/
  );

  assert.throws(
    () =>
      getEnvironment({
        NODE_ENV: "production",
        CORS_ORIGIN: ALLOWED_PRODUCTION_ORIGIN,
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "service_role_secret",
      }),
    /Invalid environment configuration/
  );
});

test("verified Supabase claims require authenticated non-anonymous users from the expected issuer", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  };
  const validClaims = {
    aud: "authenticated",
    exp: futureExpiry(),
    is_anonymous: false,
    iss: "https://example.supabase.co/auth/v1",
    role: "authenticated",
    sub: TEST_USER_ID,
  };

  assert.deepEqual(validateSupabaseClaims(validClaims, env), {
    userId: TEST_USER_ID,
    expiresAtEpochSeconds: validClaims.exp,
  });
  assert.deepEqual(validateSupabaseClaims({ ...validClaims, aud: ["authenticated", "other"] }, env), {
    userId: TEST_USER_ID,
    expiresAtEpochSeconds: validClaims.exp,
  });
  assert.deepEqual(validateSupabaseClaims({ ...validClaims, iss: "https://example.supabase.co/auth/v1" }, {
    SUPABASE_URL: "https://example.supabase.co/",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  }), {
    userId: TEST_USER_ID,
    expiresAtEpochSeconds: validClaims.exp,
  });
  assert.throws(() => validateSupabaseClaims({ ...validClaims, iss: "https://attacker.example/auth/v1" }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, sub: "" }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, exp: "not-a-number" }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, is_anonymous: true }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, role: "anon" }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, aud: ["anon", "service_role"] }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, aud: 123 }, env), AuthVerificationError);
});

test("verified Supabase claims reject expiration boundaries fail-closed", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  };
  const now = Math.floor(Date.now() / 1000);
  const validClaims = {
    aud: "authenticated",
    exp: now + 1,
    is_anonymous: false,
    iss: "https://example.supabase.co/auth/v1",
    role: "authenticated",
    sub: TEST_USER_ID,
  };

  assert.deepEqual(validateSupabaseClaims(validClaims, env), {
    userId: TEST_USER_ID,
    expiresAtEpochSeconds: validClaims.exp,
  });
  assert.throws(() => validateSupabaseClaims({ ...validClaims, exp: now }, env), AuthVerificationError);
  assert.throws(() => validateSupabaseClaims({ ...validClaims, exp: now - 1 }, env), AuthVerificationError);
});

test("signal-aware fetch passes already-aborted attempt signals to base fetch", async () => {
  const controller = new AbortController();
  controller.abort("attempt cancelled");
  let capturedSignal: AbortSignal | undefined;
  const baseFetch: typeof fetch = async (_input, init) => {
    capturedSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const response = await createSignalAwareFetch(controller.signal, baseFetch)("https://auth.example.test/claims");

  assert.equal(response.status, 200);
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(capturedSignal?.reason, "attempt cancelled");
});

test("signal-aware fetch combines attempt, Request, and RequestInit signals", async () => {
  for (const abortSource of ["attempt", "request", "init"] as const) {
    const attemptController = new AbortController();
    const requestController = new AbortController();
    const initController = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const baseFetch: typeof fetch = async (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const request = new Request("https://auth.example.test/claims", {
      signal: requestController.signal,
    });

    void createSignalAwareFetch(attemptController.signal, baseFetch)(request, {
      signal: initController.signal,
    });
    await waitFor(() => capturedSignal !== undefined);

    if (abortSource === "attempt") {
      attemptController.abort("attempt");
    } else if (abortSource === "request") {
      requestController.abort("request");
    } else {
      initController.abort("init");
    }

    await waitFor(() => capturedSignal!.aborted);
    assert.equal(capturedSignal!.aborted, true);
    assert.equal(capturedSignal!.reason, abortSource);
  }
});

test("signal-aware fetch preserves init values and handles duplicate signals", async () => {
  const controller = new AbortController();
  let capturedInit: RequestInit | undefined;
  const baseFetch: typeof fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await createSignalAwareFetch(controller.signal, baseFetch)("https://auth.example.test/user", {
    body: "body-value",
    cache: "no-store",
    credentials: "include",
    headers: {
      authorization: "Bearer test-token",
      "x-test": "preserved",
    },
    method: "POST",
    mode: "cors",
    redirect: "manual",
    signal: controller.signal,
  });

  assert.equal(capturedInit?.body, "body-value");
  assert.equal(capturedInit?.cache, "no-store");
  assert.equal(capturedInit?.credentials, "include");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.mode, "cors");
  assert.equal(capturedInit?.redirect, "manual");
  assert.equal((capturedInit?.headers as Record<string, string>)["x-test"], "preserved");
  assert.equal(capturedInit?.signal, controller.signal);
});

test("signal-aware fetch returns a generic synthetic response after aborted base fetch", async () => {
  const sensitiveToken = "jwt-secret-value";
  const controller = new AbortController();
  controller.abort(`cancel ${sensitiveToken}`);
  const baseFetch: typeof fetch = async () => {
    throw new Error(`fetch failed for ${sensitiveToken}`);
  };

  const response = await createSignalAwareFetch(controller.signal, baseFetch)("https://auth.example.test/user");
  const body = await response.text();

  assert.equal(response.status, 499);
  assert.equal(body.includes(sensitiveToken), false);
  assert.equal(body.includes("cancel"), false);
  assert.deepEqual(JSON.parse(body), { message: "Authentication failed" });
});

test("per-IP limits distinguish forwarded clients only when trusted proxy is enabled", async (t) => {
  const disabled = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_MAX_CONNECTIONS: 10,
    WS_MAX_CONNECTIONS_PER_IP: 1,
  });
  const firstDisabled = await connectWebSocket(disabled.wsUrl, {
    headers: { "x-forwarded-for": "203.0.113.10" },
    origin: ALLOWED_PRODUCTION_ORIGIN,
  });

  try {
    await expectWebSocketClose(disabled.wsUrl, 1013, {
      headers: { "x-forwarded-for": "203.0.113.11" },
      origin: ALLOWED_PRODUCTION_ORIGIN,
    });
  } finally {
    await closeWebSocket(firstDisabled.ws);
  }

  const enabled = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_MAX_CONNECTIONS: 10,
    WS_MAX_CONNECTIONS_PER_IP: 1,
    WS_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  });
  const firstEnabled = await connectWebSocket(enabled.wsUrl, {
    headers: { "x-forwarded-for": "203.0.113.10" },
    origin: ALLOWED_PRODUCTION_ORIGIN,
  });
  const secondEnabled = await connectWebSocket(enabled.wsUrl, {
    headers: { "x-forwarded-for": "203.0.113.11" },
    origin: ALLOWED_PRODUCTION_ORIGIN,
  });

  try {
    assert.equal(enabled.app.webSocketRuntime.activeSessionCount, 2);
  } finally {
    await closeWebSocket(secondEnabled.ws);
    await closeWebSocket(firstEnabled.ws);
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
    await authenticateWebSocket(ws);
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

test("graceful shutdown closes authenticated sessions with 1012", async (t) => {
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_SHUTDOWN_GRACE_MS: 100,
  });
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);
  await authenticateWebSocket(ws);
  const closePromise = expectCloseCode(ws);

  const shutdownPromise = shutdownServer(app);

  assert.equal(await closePromise, 1012);
  await shutdownPromise;
});

test("graceful shutdown completes as soon as active sessions drain", async () => {
  class FakeSocket extends EventEmitter {
    closeCode: number | undefined;
    terminateCount = 0;

    close(code?: number): void {
      this.closeCode = code;
      setImmediate(() => this.emit("close", code));
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
      WS_SHUTDOWN_GRACE_MS: 1_000,
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

  const startedAt = Date.now();
  await runtime.shutdown(
    {
      close: async () => {},
      log: logger,
    } as unknown as Parameters<WebSocketRuntime["shutdown"]>[0],
    1_000
  );

  assert.equal(socket.closeCode, 1012);
  assert.equal(socket.terminateCount, 0);
  assert.equal(runtime.activeSessionCount, 0);
  assert.ok(Date.now() - startedAt < 250);
});

test("graceful shutdown isolates throwing shutdown callbacks", async () => {
  class FakeSocket extends EventEmitter {
    closeCode: number | undefined;

    close(code?: number): void {
      this.closeCode = code;
      setImmediate(() => this.emit("close", code));
    }

    ping(): void {}

    terminate(): void {
      this.emit("close", 1006);
    }
  }

  const runtime = new WebSocketRuntime(
    getEnvironment({
      NODE_ENV: "test",
      CORS_ORIGIN: ALLOWED_PRODUCTION_ORIGIN,
      WS_HEARTBEAT_INTERVAL_MS: 1_000,
      WS_IDLE_TIMEOUT_MS: 1_000,
      WS_SHUTDOWN_GRACE_MS: 1_000,
    })
  );
  const sensitiveToken = "shutdown-secret-token";
  const errorLogs: unknown[] = [];
  const logger = {
    info() {},
    warn() {},
    error(payload: unknown) {
      errorLogs.push(payload);
    },
  };
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const firstRegistration = runtime.registerSession(
    firstSocket as unknown as WebSocket,
    { ip: "127.0.0.1", log: logger } as unknown as Parameters<WebSocketRuntime["registerSession"]>[1],
    "first-session"
  );
  const secondRegistration = runtime.registerSession(
    secondSocket as unknown as WebSocket,
    { ip: "127.0.0.2", log: logger } as unknown as Parameters<WebSocketRuntime["registerSession"]>[1],
    "second-session"
  );

  assert.equal(firstRegistration.accepted, true);
  assert.equal(secondRegistration.accepted, true);

  let laterFirstCallbackRan = false;
  let secondCallbackRan = false;
  if (firstRegistration.accepted) {
    firstRegistration.onShutdownStart(() => {
      throw new Error(`callback failed ${sensitiveToken}`);
    });
    firstRegistration.onShutdownStart(() => {
      laterFirstCallbackRan = true;
    });
    firstSocket.once("close", () => firstRegistration.cleanup());
  }
  if (secondRegistration.accepted) {
    secondRegistration.onShutdownStart(() => {
      secondCallbackRan = true;
    });
    secondSocket.once("close", () => secondRegistration.cleanup());
  }

  await runtime.shutdown(
    {
      close: async () => {},
      log: logger,
    } as unknown as Parameters<WebSocketRuntime["shutdown"]>[0],
    1_000
  );

  assert.equal(laterFirstCallbackRan, true);
  assert.equal(secondCallbackRan, true);
  assert.equal(firstSocket.closeCode, 1012);
  assert.equal(secondSocket.closeCode, 1012);
  assert.equal(runtime.activeSessionCount, 0);
  assert.equal(JSON.stringify(errorLogs).includes(sensitiveToken), false);
  assert.deepEqual(errorLogs, [
    {
      clientIp: "127.0.0.1",
      event: "shutdown_callback_failed",
      sessionId: "first-session",
    },
  ]);
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
  const { ws, firstMessage } = await connectWebSocket(wsUrl, SECOND_ALLOWED_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
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
  const { ws, firstMessage } = await connectWebSocket(wsUrl, SECOND_ALLOWED_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
  } finally {
    await closeWebSocket(ws);
  }
});

test("allows any Origin when CORS_ORIGIN is wildcard", async (t) => {
  const { wsUrl } = await startTestServer(t, "*");
  const { ws, firstMessage } = await connectWebSocket(wsUrl, "https://attacker.example");

  try {
    assert.equal(firstMessage.type, "session.auth_required");
  } finally {
    await closeWebSocket(ws);
  }
});

test("allows missing Origin for trusted non-browser clients", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, firstMessage } = await connectWebSocket(wsUrl);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
  } finally {
    await closeWebSocket(ws);
  }
});

test("sends session.auth_required first and does not send session.ready before authentication", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, firstMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
    assert.equal(firstMessage.protocolVersion, "1.1");
    assert.equal(firstMessage.authTimeoutMs, 10_000);
    assert.equal(await receiveJsonWithin(ws, 30), undefined);
  } finally {
    await closeWebSocket(ws);
  }
});

test("valid token authenticates and enables ping/pong", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, firstMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
    const readyMessage = await authenticateWebSocket(ws);
    assert.equal(readyMessage.type, "session.ready");
    assert.equal(readyMessage.protocolVersion, "1.1");

    ws.send(JSON.stringify({ type: "ping", sentAt: new Date().toISOString() }));
    const pongMessage = await receiveJson(ws);
    assert.equal(pongMessage.type, "pong");
  } finally {
    await closeWebSocket(ws);
  }
});

test("missing authentication times out and closes with 1008", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_AUTH_TIMEOUT_MS: 20,
  });
  const { ws, firstMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("invalid token closes with a generic authentication error and 1008", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: INVALID_TOKEN }));
    const errorMessage = await receiveJson(ws);
    assert.deepEqual(errorMessage, {
      type: "error",
      code: "authentication_failed",
      message: "Authentication failed.",
    });
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("token is never echoed in responses or logs", async (t) => {
  let logOutput = "";
  const loggerStream = new Writable({
    write(chunk, _encoding, callback) {
      logOutput += chunk.toString();
      callback();
    },
  });
  const sensitiveToken = "super-secret-jwt-value";
  const verifier = createFakeAuthVerifier({
    [sensitiveToken]: new AuthVerificationError("unverifiable"),
  });
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier, loggerStream);
  const { ws, firstMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    const firstRaw = JSON.stringify(firstMessage);
    assert.equal(firstRaw.includes(sensitiveToken), false);
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: sensitiveToken }));
    const errorMessage = await receiveJson(ws);
    assert.equal(JSON.stringify(errorMessage).includes(sensitiveToken), false);
    assert.equal(await expectCloseCode(ws), 1008);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(logOutput.includes(sensitiveToken), false);
  } finally {
    await closeWebSocket(ws);
  }
});

test("pre-auth binary input is rejected with a generic authentication failure", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(Buffer.from("not-json"));
    const errorMessage = await receiveJson(ws);
    assert.deepEqual(errorMessage, {
      type: "error",
      code: "authentication_failed",
      message: "Authentication failed.",
    });
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("malformed JSON before authentication returns invalid_json and remains bounded by auth timeout", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_AUTH_TIMEOUT_MS: 20,
  });
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send("{");
    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "invalid_json");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("pre-auth ping is rejected", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "ping", sentAt: new Date().toISOString() }));
    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "authentication_failed");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("pre-auth session.end is rejected", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.end", reason: "stop" }));
    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "authentication_failed");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("duplicate initial authentication is rejected", async (t) => {
  let resolveVerification: (token: VerifiedAuthToken) => void = () => {};
  const verifier: AuthVerifier = {
    verifyAccessToken: (_accessToken: string, _signal: AbortSignal) =>
      new Promise<VerifiedAuthToken>((resolve) => {
        resolveVerification = resolve;
      }),
  };
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: REFRESH_TOKEN }));
    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "authentication_failed");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    resolveVerification(makeVerifiedToken());
    await closeWebSocket(ws);
  }
});

test("authenticated session.end still works", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    const readyMessage = await authenticateWebSocket(ws);
    ws.send(JSON.stringify({ type: "session.end", reason: "test complete" }));
    const endedMessage = await receiveJson(ws);
    assert.equal(endedMessage.type, "session.ended");
    assert.equal(endedMessage.sessionId, readyMessage.sessionId);
    assert.equal(await expectCloseCode(ws), 1000);
  } finally {
    await closeWebSocket(ws);
  }
});

test("authenticated runtime events are acknowledged without echoing content", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    await authenticateWebSocket(ws);
    ws.send(
      JSON.stringify({
        type: "transcript.final",
        clientEventId: "segment-123",
        text: "How would you debug a Terraform AccessDenied error?",
        source: "system-audio",
        timestamp: new Date().toISOString(),
      })
    );
    const ackMessage = await receiveJson(ws);
    assert.equal(ackMessage.type, "event.ack");
    assert.equal(ackMessage.clientEventId, "segment-123");
    assert.equal(ackMessage.receivedType, "transcript.final");
    assert.equal(JSON.stringify(ackMessage).includes("AccessDenied"), false);
  } finally {
    await closeWebSocket(ws);
  }
});

test("token expiration closes the socket", async (t) => {
  const verifier = createFakeAuthVerifier({
    [VALID_TOKEN]: makeVerifiedToken(TEST_USER_ID, 1),
  });
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    const readyMessage = await authenticateWebSocket(ws);
    assert.equal(readyMessage.type, "session.ready");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("successful reauthentication extends the session", async (t) => {
  const verifier = createFakeAuthVerifier({
    [VALID_TOKEN]: makeVerifiedToken(TEST_USER_ID, 1),
    [REFRESH_TOKEN]: makeVerifiedToken(TEST_USER_ID, 3),
  });
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    await authenticateWebSocket(ws, VALID_TOKEN);
    ws.send(JSON.stringify({ type: "session.reauthenticate", accessToken: REFRESH_TOKEN }));
    const refreshedMessage = await receiveJson(ws);
    assert.equal(refreshedMessage.type, "session.auth_refreshed");

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.notEqual(ws.readyState, WebSocket.CLOSED);
  } finally {
    await closeWebSocket(ws);
  }
});

test("replaced expiration timer cannot close a refreshed session at the old expiration", async (t) => {
  const verifier = createFakeAuthVerifier({
    [VALID_TOKEN]: makeVerifiedToken(TEST_USER_ID, 1),
    [REFRESH_TOKEN]: makeVerifiedToken(TEST_USER_ID, 60),
  });
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    const readyMessage = await authenticateWebSocket(ws, VALID_TOKEN);
    const oldExpiresAt = Date.parse(String(readyMessage.expiresAt));
    ws.send(JSON.stringify({ type: "session.reauthenticate", accessToken: REFRESH_TOKEN }));
    const refreshedMessage = await receiveJson(ws);
    assert.equal(refreshedMessage.type, "session.auth_refreshed");

    await waitFor(() => Date.now() > oldExpiresAt + 100, 1_500);
    assert.notEqual(ws.readyState, WebSocket.CLOSED);
  } finally {
    await closeWebSocket(ws);
  }
});

test("reauthentication with a different sub is rejected", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    await authenticateWebSocket(ws, VALID_TOKEN);
    ws.send(JSON.stringify({ type: "session.reauthenticate", accessToken: OTHER_USER_TOKEN }));
    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "authentication_failed");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("verifier exceptions fail closed", async (t) => {
  const verifier: AuthVerifier = {
    async verifyAccessToken(_accessToken: string, _signal: AbortSignal) {
      throw new Error("network unavailable");
    },
  };
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "authentication_failed");
    assert.equal(await expectCloseCode(ws), 1008);
  } finally {
    await closeWebSocket(ws);
  }
});

test("late verifier completion after auth timeout cannot authenticate the session", async (t) => {
  const controlled = createControlledVerifier();
  const { app, wsUrl } = await startTestServer(
    t,
    ALLOWED_PRODUCTION_ORIGIN,
    {
      WS_AUTH_TIMEOUT_MS: 20,
    },
    controlled.verifier
  );
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
    assert.equal(await expectCloseCode(ws), 1008);
    controlled.resolveVerification(makeVerifiedToken());
    await waitFor(() => app.webSocketRuntime.activeSessionCount === 0);
    assert.equal(app.webSocketRuntime.activeSessionCount, 0);
  } finally {
    controlled.resolveVerification(makeVerifiedToken());
    await closeWebSocket(ws);
  }
});

test("auth timeout aborts in-flight authentication verification", async (t) => {
  const controlled = createControlledVerifier();
  const { wsUrl } = await startTestServer(
    t,
    ALLOWED_PRODUCTION_ORIGIN,
    {
      WS_AUTH_TIMEOUT_MS: 20,
    },
    controlled.verifier
  );
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
    await waitFor(() => controlled.signals.length === 1);

    assert.equal(await expectCloseCode(ws), 1008);
    assert.equal(controlled.signals[0]!.aborted, true);
  } finally {
    controlled.resolveVerification(makeVerifiedToken());
    await closeWebSocket(ws);
  }
});

test("client disconnect aborts in-flight authentication verification", async (t) => {
  const controlled = createControlledVerifier();
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, controlled.verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
  await waitFor(() => controlled.signals.length === 1);
  await closeWebSocket(ws);
  await waitFor(() => controlled.signals[0]!.aborted);

  assert.equal(controlled.signals[0]!.aborted, true);
  controlled.resolveVerification(makeVerifiedToken());
});

test("socket cleanup after terminated client aborts in-flight authentication verification", async (t) => {
  const controlled = createControlledVerifier();
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, controlled.verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
  await waitFor(() => controlled.signals.length === 1);
  ws.terminate();
  await waitFor(() => app.webSocketRuntime.activeSessionCount === 0);

  assert.equal(controlled.signals[0]!.aborted, true);
  controlled.resolveVerification(makeVerifiedToken());
});

test("late verifier completion after client disconnect cannot authenticate the session", async (t) => {
  const controlled = createControlledVerifier();
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, controlled.verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
  await closeWebSocket(ws);
  controlled.resolveVerification(makeVerifiedToken());
  await waitFor(() => app.webSocketRuntime.activeSessionCount === 0);

  assert.equal(app.webSocketRuntime.activeSessionCount, 0);
});

test("graceful shutdown during in-flight authentication keeps shutdown close code", async (t) => {
  const controlled = createControlledVerifier();
  const { app, wsUrl } = await startTestServer(
    t,
    ALLOWED_PRODUCTION_ORIGIN,
    {
      WS_SHUTDOWN_GRACE_MS: 100,
    },
    controlled.verifier
  );
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
  await waitFor(() => controlled.signals.length === 1);
  const closePromise = expectCloseCode(ws);
  const shutdownPromise = shutdownServer(app);
  assert.equal(await closePromise, 1012);
  assert.equal(controlled.signals[0]!.aborted, true);

  controlled.resolveVerification(makeVerifiedToken());
  await shutdownPromise;
  assert.equal(app.webSocketRuntime.activeSessionCount, 0);
});

test("superseded initial authentication aborts the active verifier", async (t) => {
  const controlled = createControlledVerifier();
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, controlled.verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
    await waitFor(() => controlled.signals.length === 1);
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: REFRESH_TOKEN }));

    const errorMessage = await receiveJson(ws);
    assert.equal(errorMessage.code, "authentication_failed");
    assert.equal(await expectCloseCode(ws), 1008);
    assert.equal(controlled.signals[0]!.aborted, true);
  } finally {
    controlled.resolveVerification(makeVerifiedToken());
    await closeWebSocket(ws);
  }
});

test("aborted initial authentication cannot send session.ready", async (t) => {
  const controlled = createControlledVerifier();
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, controlled.verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (rawData) => {
    messages.push(JSON.parse(rawData.toString()) as Record<string, unknown>);
  });

  ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
  await waitFor(() => controlled.signals.length === 1);
  await closeWebSocket(ws);
  await waitFor(() => controlled.signals[0]!.aborted);
  controlled.resolveVerification(makeVerifiedToken());
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(controlled.signals[0]!.aborted, true);
  assert.equal(messages.some((message) => message.type === "session.ready"), false);
});

test("aborted reauthentication cannot send session.auth_refreshed", async (t) => {
  let resolveRefresh: (token: VerifiedAuthToken) => void = () => {};
  const signals: AbortSignal[] = [];
  const verifier: AuthVerifier = {
    verifyAccessToken: (accessToken: string, signal: AbortSignal) => {
      signals.push(signal);
      if (accessToken === VALID_TOKEN) {
        return Promise.resolve(makeVerifiedToken(TEST_USER_ID, 60));
      }

      return new Promise<VerifiedAuthToken>((resolve) => {
        resolveRefresh = resolve;
      });
    },
  };
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {}, verifier);
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (rawData) => {
    messages.push(JSON.parse(rawData.toString()) as Record<string, unknown>);
  });

  await authenticateWebSocket(ws, VALID_TOKEN);
  ws.send(JSON.stringify({ type: "session.reauthenticate", accessToken: REFRESH_TOKEN }));
  await waitFor(() => signals.length === 2);
  await closeWebSocket(ws);
  await waitFor(() => signals[1]!.aborted);
  resolveRefresh(makeVerifiedToken(TEST_USER_ID, 120));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(signals[1]!.aborted, true);
  assert.equal(messages.some((message) => message.type === "session.auth_refreshed"), false);
});

test("abort rejection is handled without an unhandled rejection", async (t) => {
  const aborting = createAbortRejectingVerifier();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  t.after(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });
  const { wsUrl } = await startTestServer(
    t,
    ALLOWED_PRODUCTION_ORIGIN,
    {
      WS_AUTH_TIMEOUT_MS: 20,
    },
    aborting.verifier
  );
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: VALID_TOKEN }));
    await waitFor(() => aborting.signals.length === 1);

    assert.equal(await expectCloseCode(ws), 1008);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
  } finally {
    await closeWebSocket(ws);
  }
});

test("abort reason and logs do not include the access token", async (t) => {
  let logOutput = "";
  const loggerStream = new Writable({
    write(chunk, _encoding, callback) {
      logOutput += chunk.toString();
      callback();
    },
  });
  const controlled = createControlledVerifier();
  const sensitiveToken = "abort-secret-access-token";
  const { wsUrl } = await startTestServer(
    t,
    ALLOWED_PRODUCTION_ORIGIN,
    {
      WS_AUTH_TIMEOUT_MS: 20,
    },
    controlled.verifier,
    loggerStream
  );
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: sensitiveToken }));
    await waitFor(() => controlled.signals.length === 1);
    assert.equal(await expectCloseCode(ws), 1008);

    assert.equal(String(controlled.signals[0]!.reason).includes(sensitiveToken), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(logOutput.includes(sensitiveToken), false);
  } finally {
    controlled.resolveVerification(makeVerifiedToken());
    await closeWebSocket(ws);
  }
});

test("cleanup clears authentication and expiration timers", async (t) => {
  const { app, wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN, {
    WS_AUTH_TIMEOUT_MS: 10_000,
  });
  const { ws } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  await authenticateWebSocket(ws);
  await closeWebSocket(ws);
  await waitFor(() => app.webSocketRuntime.activeSessionCount === 0);

  assert.equal(app.webSocketRuntime.activeSessionCount, 0);
});

test("preserves ping/pong and session.end behavior", async (t) => {
  const { wsUrl } = await startTestServer(t, ALLOWED_PRODUCTION_ORIGIN);
  const { ws, firstMessage } = await connectWebSocket(wsUrl, ALLOWED_PRODUCTION_ORIGIN);

  try {
    assert.equal(firstMessage.type, "session.auth_required");
    const readyMessage = await authenticateWebSocket(ws);
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
