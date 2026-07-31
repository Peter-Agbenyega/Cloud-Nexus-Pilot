import assert from "node:assert/strict";
import { test } from "node:test";

import {
  disconnectPilotRealtimeForSignedOut,
  PilotRealtimeClient,
  type PilotRealtimeAuthProvider,
  type PilotRealtimeSocket,
  type PilotRealtimeStateSnapshot,
} from "../../lib/realtime/pilot-realtime-client";
import { serializePilotRealtimeClientMessage } from "../../lib/realtime/session-protocol";

type ListenerType = "open" | "message" | "close" | "error";

class MockSocket implements PilotRealtimeSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly listeners = new Map<ListenerType, Set<EventListener>>();
  readonly sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = this.CONNECTING;

  addEventListener(type: ListenerType, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: ListenerType, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = this.CLOSED;
  }

  emitOpen(): void {
    this.readyState = this.OPEN;
    this.emit("open", {});
  }

  emitMessage(message: unknown): void {
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }

  emitClose(code: number): void {
    this.readyState = this.CLOSED;
    this.emit("close", { code });
  }

  emitError(): void {
    this.emit("error", {});
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  private emit(type: ListenerType, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as unknown as Event);
    }
  }
}

function createAuthProvider(tokens: string[]): PilotRealtimeAuthProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getAccessToken() {
      const token = tokens.shift() ?? null;
      if (token !== null) {
        calls.push(token);
      }
      return token;
    },
  };
}

function createScheduler() {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    scheduledDelays: [] as number[],
    scheduler: {
      setTimeout(callback: () => void, delayMs: number) {
        const id = nextId;
        nextId += 1;
        timers.set(id, callback);
        this.scheduledDelays.push(delayMs);
        return id;
      },
      clearTimeout(timer: unknown) {
        timers.delete(timer as number);
      },
      scheduledDelays: [] as number[],
    },
    runNext() {
      const [id, callback] = timers.entries().next().value as [number, () => void];
      timers.delete(id);
      callback();
    },
    pendingCount() {
      return timers.size;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function authRequired(sessionId = "session-1") {
  return {
    type: "session.auth_required",
    sessionId,
    protocolVersion: "1.1",
    authTimeoutMs: 10_000,
  };
}

function ready(sessionId = "session-1") {
  return {
    type: "session.ready",
    sessionId,
    protocolVersion: "1.1",
    connectedAt: new Date(0).toISOString(),
    expiresAt: new Date(60_000).toISOString(),
  };
}

test("auth_required triggers session.authenticate", async () => {
  const sockets: MockSocket[] = [];
  const auth = createAuthProvider(["secret-token"]);
  const client = new PilotRealtimeClient({
    authProvider: auth,
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  client.connect();
  sockets[0]!.emitOpen();
  sockets[0]!.emitMessage(authRequired());
  await flushMicrotasks();

  assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), {
    type: "session.authenticate",
    accessToken: "secret-token",
  });
});

test("session.ready changes state to ready", async () => {
  const states: PilotRealtimeStateSnapshot[] = [];
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
    onStateChange: (snapshot) => states.push(snapshot),
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(authRequired("ready-session"));
  await flushMicrotasks();
  socket.emitMessage(ready("ready-session"));

  assert.equal(client.snapshot.state, "ready");
  assert.equal(states.at(-1)?.sessionId, "ready-session");
});

test("token never appears in logs, URL, or non-auth state", async () => {
  const sensitiveToken = "jwt-secret-value";
  const createdUrls: string[] = [];
  const states: PilotRealtimeStateSnapshot[] = [];
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider([sensitiveToken]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: (url) => {
      createdUrls.push(url);
      return socket;
    },
    onStateChange: (snapshot) => states.push(snapshot),
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(authRequired());
  await flushMicrotasks();

  assert.equal(createdUrls.join(" ").includes(sensitiveToken), false);
  assert.equal(JSON.stringify(states).includes(sensitiveToken), false);
  assert.equal(JSON.stringify(client.snapshot).includes(sensitiveToken), false);
});

test("authentication failure closes without reconnect", async () => {
  const scheduled = createScheduler();
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage({ type: "error", code: "authentication_failed", message: "Authentication failed." });

  assert.equal(client.snapshot.state, "error");
  assert.equal(client.snapshot.error, "authentication_failed");
  assert.equal(scheduled.pendingCount(), 0);
});

test("1008 does not reconnect", () => {
  const scheduled = createScheduler();
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitClose(1008);

  assert.equal(client.snapshot.state, "error");
  assert.equal(scheduled.pendingCount(), 0);
});

test("1012 reconnects", () => {
  const scheduled = createScheduler();
  const sockets: MockSocket[] = [];
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["first", "second"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
  });

  client.connect();
  sockets[0]!.emitOpen();
  sockets[0]!.emitClose(1012);

  assert.equal(client.snapshot.state, "reconnecting");
  assert.equal(scheduled.pendingCount(), 1);
  scheduled.runNext();
  assert.equal(sockets.length, 2);
});

test("reconnect obtains a fresh token", async () => {
  const scheduled = createScheduler();
  const sockets: MockSocket[] = [];
  const auth = createAuthProvider(["first-token", "fresh-token"]);
  const client = new PilotRealtimeClient({
    authProvider: auth,
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
  });

  client.connect();
  sockets[0]!.emitOpen();
  sockets[0]!.emitMessage(authRequired("first-session"));
  await flushMicrotasks();
  sockets[0]!.emitMessage(ready("first-session"));
  sockets[0]!.emitClose(1012);
  scheduled.runNext();
  sockets[1]!.emitOpen();
  sockets[1]!.emitMessage(authRequired("second-session"));
  await flushMicrotasks();

  assert.deepEqual(auth.calls, ["first-token", "fresh-token"]);
  assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), {
    type: "session.authenticate",
    accessToken: "fresh-token",
  });
});

test("explicit disconnect prevents reconnect", () => {
  const scheduled = createScheduler();
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  client.disconnect();
  socket.emitClose(1012);

  assert.equal(client.snapshot.state, "closed");
  assert.equal(scheduled.pendingCount(), 0);
});

test("token refresh sends session.reauthenticate", async () => {
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["initial-token", "refresh-token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(authRequired());
  await flushMicrotasks();
  socket.emitMessage(ready());
  client.reauthenticate();
  await flushMicrotasks();

  assert.deepEqual(JSON.parse(socket.sent[1]!), {
    type: "session.reauthenticate",
    accessToken: "refresh-token",
  });
});

test("duplicate refresh is prevented", async () => {
  let resolveToken: (token: string) => void = () => {};
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: {
      async getAccessToken() {
        return await new Promise<string>((resolve) => {
          resolveToken = resolve;
        });
      },
    },
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(authRequired());
  resolveToken("initial-token");
  await flushMicrotasks();
  socket.emitMessage(ready());
  client.reauthenticate();
  client.reauthenticate();
  resolveToken("refresh-token");
  await flushMicrotasks();

  const refreshMessages = socket.sent
    .map((message) => JSON.parse(message) as { type: string })
    .filter((message) => message.type === "session.reauthenticate");
  assert.equal(refreshMessages.length, 1);
});

test("auth_refreshed clears refresh-in-flight state", async () => {
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["initial-token", "refresh-one", "refresh-two"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(authRequired());
  await flushMicrotasks();
  socket.emitMessage(ready());
  client.reauthenticate();
  await flushMicrotasks();
  socket.emitMessage({ type: "session.auth_refreshed", sessionId: "session-1", expiresAt: new Date(120_000).toISOString() });
  client.reauthenticate();
  await flushMicrotasks();

  const refreshMessages = socket.sent
    .map((message) => JSON.parse(message) as { type: string })
    .filter((message) => message.type === "session.reauthenticate");
  assert.equal(refreshMessages.length, 2);
});

test("cleanup removes listeners and timers", () => {
  const scheduled = createScheduler();
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitClose(1012);
  assert.equal(scheduled.pendingCount(), 1);
  client.cleanup();

  assert.equal(socket.listenerCount(), 0);
  assert.equal(scheduled.pendingCount(), 0);
});

test("Strict Mode-style setup and cleanup does not create duplicate live sockets", () => {
  const sockets: MockSocket[] = [];
  const createClient = () =>
    new PilotRealtimeClient({
      authProvider: createAuthProvider(["token"]),
      url: "ws://localhost:3010/ws/session",
      socketFactory: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      },
    });

  const firstClient = createClient();
  firstClient.connect();
  firstClient.cleanup();
  const secondClient = createClient();
  secondClient.connect();

  const liveSockets = sockets.filter((socket) => socket.readyState !== socket.CLOSED);
  assert.equal(sockets.length, 2);
  assert.equal(liveSockets.length, 1);
});

test("ping, session.end, and clean disconnect use protocol messages safely", () => {
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(ready());
  client.ping();
  client.endSession("done");
  client.disconnect();

  assert.equal((JSON.parse(socket.sent[0]!) as { type: string }).type, "ping");
  assert.equal(socket.sent[1], serializePilotRealtimeClientMessage({ type: "session.end", reason: "done" }));
  assert.equal(client.snapshot.state, "closed");
});

test("session.end prevents reconnect when the server close arrives first", () => {
  const scheduled = createScheduler();
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(ready());
  client.endSession("done");
  socket.emitClose(1000);

  assert.equal(client.snapshot.state, "closed");
  assert.equal(scheduled.pendingCount(), 0);
});

test("SIGNED_OUT closes the active WebSocket", () => {
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(ready());
  disconnectPilotRealtimeForSignedOut(client);

  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.closeCalls[0]?.code, 1000);
  assert.equal(client.snapshot.state, "closed");
});

test("SIGNED_OUT prevents reconnect", () => {
  const scheduled = createScheduler();
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitClose(1012);
  assert.equal(scheduled.pendingCount(), 1);
  disconnectPilotRealtimeForSignedOut(client);

  assert.equal(client.snapshot.state, "closed");
  assert.equal(scheduled.pendingCount(), 0);
});

test("a later normal session start can connect again after SIGNED_OUT", () => {
  const sockets: MockSocket[] = [];
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["first-token", "second-token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  client.connect();
  sockets[0]!.emitOpen();
  disconnectPilotRealtimeForSignedOut(client);
  client.connect();

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0]!.readyState, sockets[0]!.CLOSED);
  assert.equal(sockets[1]!.readyState, sockets[1]!.CONNECTING);
});

test("first live session start connects", () => {
  const sockets: MockSocket[] = [];
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  client.connect();

  assert.equal(sockets.length, 1);
  assert.equal(client.snapshot.state, "connecting");
});

test("endSession closes the active WebSocket", () => {
  const socket = new MockSocket();
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => socket,
  });

  client.connect();
  socket.emitOpen();
  socket.emitMessage(ready());
  client.endSession("done");

  assert.equal(socket.sent[0], serializePilotRealtimeClientMessage({ type: "session.end", reason: "done" }));
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.closeCalls[0]?.code, 1000);
  assert.equal(client.snapshot.state, "closed");
});

test("starting a second live session reconnects after session.end", () => {
  const sockets: MockSocket[] = [];
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["first-token", "second-token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  client.connect();
  sockets[0]!.emitOpen();
  sockets[0]!.emitMessage(ready());
  client.endSession("done");
  client.connect();

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0]!.readyState, sockets[0]!.CLOSED);
  assert.equal(sockets[1]!.readyState, sockets[1]!.CONNECTING);
});

test("only one live WebSocket exists when connect is called repeatedly", () => {
  const sockets: MockSocket[] = [];
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  client.connect();
  client.connect();
  sockets[0]!.emitOpen();
  client.connect();

  const liveSockets = sockets.filter((socket) => socket.readyState !== socket.CLOSED);
  assert.equal(sockets.length, 1);
  assert.equal(liveSockets.length, 1);
});

test("connect does nothing while connecting, authenticating, ready, or reconnecting", () => {
  const scheduled = createScheduler();
  const sockets: MockSocket[] = [];
  const client = new PilotRealtimeClient({
    authProvider: createAuthProvider(["token"]),
    url: "ws://localhost:3010/ws/session",
    scheduler: scheduled.scheduler,
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  client.connect();
  client.connect();
  assert.equal(sockets.length, 1);

  sockets[0]!.emitOpen();
  sockets[0]!.emitMessage(authRequired());
  client.connect();
  assert.equal(sockets.length, 1);

  sockets[0]!.emitMessage(ready());
  client.connect();
  assert.equal(sockets.length, 1);

  sockets[0]!.emitClose(1012);
  client.connect();
  assert.equal(client.snapshot.state, "reconnecting");
  assert.equal(sockets.length, 1);
  assert.equal(scheduled.pendingCount(), 1);
});
