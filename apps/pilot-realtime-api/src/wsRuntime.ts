import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import type { AppEnvironment } from "./env.js";

export const WS_CLOSE_CODES = {
  normal: 1000,
  policyViolation: 1008,
  goingAway: 1001,
  messageTooLarge: 1009,
  serviceRestart: 1012,
  tryAgainLater: 1013,
} as const;

export type WebSocketRuntimeConfig = Pick<
  AppEnvironment,
  | "WS_MAX_CONNECTIONS"
  | "WS_MAX_CONNECTIONS_PER_IP"
  | "WS_HEARTBEAT_INTERVAL_MS"
  | "WS_IDLE_TIMEOUT_MS"
  | "WS_SHUTDOWN_GRACE_MS"
>;

export type SessionRegistration =
  | {
      accepted: true;
      sessionId: string;
      clientIp: string;
      cleanup: () => void;
      noteValidClientActivity: () => void;
      onShutdownStart: (callback: () => void) => () => void;
      setAuthenticatedUser: (userId: string, expiresAtEpochSeconds: number) => void;
    }
  | {
      accepted: false;
    };

type ManagedSession = {
  clientIp: string;
  isAlive: boolean;
  heartbeatTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  socket: WebSocket;
  shutdownCallbacks: Set<() => void>;
  tokenExpiresAtEpochSeconds?: number;
  userId?: string;
};

export class WebSocketRuntime {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly sessionsByIp = new Map<string, number>();
  private readonly shutdownDrainWaiters = new Set<() => void>();
  private shuttingDown = false;

  constructor(private readonly config: WebSocketRuntimeConfig) {}

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  canAcceptHttpUpgrade(): boolean {
    return !this.shuttingDown;
  }

  registerSession(socket: WebSocket, request: FastifyRequest, sessionId: string): SessionRegistration {
    const clientIp = request.ip;

    if (this.shuttingDown) {
      request.log.info({ sessionId, clientIp }, "Rejected WebSocket session during shutdown");
      socket.close(WS_CLOSE_CODES.serviceRestart, "Service restarting");
      return { accepted: false };
    }

    if (this.sessions.size >= this.config.WS_MAX_CONNECTIONS) {
      request.log.warn(
        {
          sessionId,
          clientIp,
          activeSessions: this.sessions.size,
          limit: this.config.WS_MAX_CONNECTIONS,
          closeCode: WS_CLOSE_CODES.tryAgainLater,
        },
        "Rejected WebSocket session because global connection limit was reached"
      );
      socket.close(WS_CLOSE_CODES.tryAgainLater, "Connection limit reached");
      return { accepted: false };
    }

    const activeForIp = this.sessionsByIp.get(clientIp) ?? 0;
    if (activeForIp >= this.config.WS_MAX_CONNECTIONS_PER_IP) {
      request.log.warn(
        {
          sessionId,
          clientIp,
          activeSessionsForIp: activeForIp,
          limit: this.config.WS_MAX_CONNECTIONS_PER_IP,
          closeCode: WS_CLOSE_CODES.tryAgainLater,
        },
        "Rejected WebSocket session because per-IP connection limit was reached"
      );
      socket.close(WS_CLOSE_CODES.tryAgainLater, "Connection limit reached");
      return { accepted: false };
    }

    const heartbeatTimer = setInterval(() => {
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        return;
      }

      if (!session.isAlive) {
        request.log.warn({ sessionId, clientIp, closeCode: 1006 }, "Terminating stale WebSocket session after missed heartbeat");
        socket.terminate();
        return;
      }

      session.isAlive = false;
      socket.ping();
    }, this.config.WS_HEARTBEAT_INTERVAL_MS);

    const idleTimer = setTimeout(() => {
      request.log.info({ sessionId, clientIp, closeCode: WS_CLOSE_CODES.goingAway }, "Closing idle WebSocket session");
      socket.close(WS_CLOSE_CODES.goingAway, "Session idle timeout");
    }, this.config.WS_IDLE_TIMEOUT_MS);

    const session: ManagedSession = {
      clientIp,
      heartbeatTimer,
      idleTimer,
      isAlive: true,
      shutdownCallbacks: new Set(),
      socket,
    };

    this.sessions.set(sessionId, session);
    this.sessionsByIp.set(clientIp, activeForIp + 1);

    const cleanup = (): void => {
      const activeSession = this.sessions.get(sessionId);
      if (activeSession === undefined) {
        return;
      }

      clearInterval(activeSession.heartbeatTimer);
      clearTimeout(activeSession.idleTimer);
      activeSession.shutdownCallbacks.clear();
      this.sessions.delete(sessionId);

      const remainingForIp = (this.sessionsByIp.get(clientIp) ?? 1) - 1;
      if (remainingForIp <= 0) {
        this.sessionsByIp.delete(clientIp);
      } else {
        this.sessionsByIp.set(clientIp, remainingForIp);
      }

      this.notifyShutdownDrainWaiters();
    };

    const noteValidClientActivity = (): void => {
      const activeSession = this.sessions.get(sessionId);
      if (activeSession === undefined) {
        return;
      }

      activeSession.idleTimer.refresh();
    };

    const setAuthenticatedUser = (userId: string, expiresAtEpochSeconds: number): void => {
      const activeSession = this.sessions.get(sessionId);
      if (activeSession === undefined) {
        return;
      }

      activeSession.userId = userId;
      activeSession.tokenExpiresAtEpochSeconds = expiresAtEpochSeconds;
    };

    const onShutdownStart = (callback: () => void): (() => void) => {
      const activeSession = this.sessions.get(sessionId);
      if (activeSession === undefined) {
        return () => {};
      }

      activeSession.shutdownCallbacks.add(callback);
      return () => {
        activeSession.shutdownCallbacks.delete(callback);
      };
    };

    socket.on("pong", () => {
      const activeSession = this.sessions.get(sessionId);
      if (activeSession !== undefined) {
        activeSession.isAlive = true;
      }
    });

    return {
      accepted: true,
      sessionId,
      clientIp,
      cleanup,
      noteValidClientActivity,
      onShutdownStart,
      setAuthenticatedUser,
    };
  }

  private notifyShutdownDrainWaiters(): void {
    if (!this.shuttingDown || this.sessions.size > 0) {
      return;
    }

    const waiters = Array.from(this.shutdownDrainWaiters);
    this.shutdownDrainWaiters.clear();

    for (const waiter of waiters) {
      waiter();
    }
  }

  async shutdown(app: FastifyInstance, graceMs = this.config.WS_SHUTDOWN_GRACE_MS): Promise<void> {
    this.shuttingDown = true;
    app.log.info({ activeSessions: this.sessions.size, graceMs }, "Realtime API graceful shutdown started");

    for (const [sessionId, session] of this.sessions) {
      app.log.info({ sessionId, clientIp: session.clientIp, closeCode: WS_CLOSE_CODES.serviceRestart }, "Closing WebSocket session for shutdown");
      const shutdownCallbacks = Array.from(session.shutdownCallbacks);
      for (const callback of shutdownCallbacks) {
        try {
          callback();
        } catch {
          app.log.error(
            {
              sessionId,
              clientIp: session.clientIp,
              event: "shutdown_callback_failed",
            },
            "Realtime WebSocket shutdown callback failed"
          );
        }
      }
      session.socket.close(WS_CLOSE_CODES.serviceRestart, "Service restarting");
    }

    let graceExpired = false;
    await new Promise<void>((resolve) => {
      if (this.sessions.size === 0) {
        resolve();
        return;
      }

      let resolved = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (resolved) {
          return;
        }

        resolved = true;
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer);
        }
        this.shutdownDrainWaiters.delete(finish);
        resolve();
      };
      graceTimer = setTimeout(() => {
        graceExpired = true;
        finish();
      }, graceMs);

      this.shutdownDrainWaiters.add(finish);
      this.notifyShutdownDrainWaiters();
    });

    if (graceExpired) {
      for (const [sessionId, session] of this.sessions) {
        app.log.warn({ sessionId, clientIp: session.clientIp }, "Terminating WebSocket session after shutdown grace period");
        session.socket.terminate();
      }
    }

    await app.close();
    app.log.info("Realtime API graceful shutdown completed");
  }
}
