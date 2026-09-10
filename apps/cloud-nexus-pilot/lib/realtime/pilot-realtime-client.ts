import {
  parsePilotRealtimeServerMessage,
  serializePilotRealtimeClientMessage,
  type PilotRealtimeClientMessage,
  type PilotRealtimeServerMessage,
} from "./session-protocol";

export type PilotRealtimeConnectionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "ready"
  | "reconnecting"
  | "closed"
  | "error";

export type PilotRealtimeStateSnapshot = {
  state: PilotRealtimeConnectionState;
  sessionId: string | null;
  error: "authentication_failed" | "connection_failed" | "configuration_missing" | "closed" | null;
  reconnectAttempt: number;
};

export type PilotRealtimeAuthProvider = {
  getAccessToken: () => Promise<string | null>;
};

export type PilotRealtimeSocket = {
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  readonly readyState: number;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  addEventListener: (type: "open" | "message" | "close" | "error", listener: EventListener) => void;
  removeEventListener: (type: "open" | "message" | "close" | "error", listener: EventListener) => void;
};

export type PilotRealtimeSocketFactory = (url: string) => PilotRealtimeSocket;

export type PilotRealtimeTimerHandle = unknown;

export type PilotRealtimeScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => PilotRealtimeTimerHandle;
  clearTimeout: (timer: PilotRealtimeTimerHandle) => void;
};

export type PilotRealtimeClientOptions = {
  authProvider: PilotRealtimeAuthProvider;
  url: string;
  socketFactory?: PilotRealtimeSocketFactory;
  scheduler?: PilotRealtimeScheduler;
  maxReconnectAttempts?: number;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  onStateChange?: (snapshot: PilotRealtimeStateSnapshot) => void;
  onMessage?: (message: PilotRealtimeServerMessage) => void;
};

export type PilotRealtimeDisconnectClient = Pick<PilotRealtimeClient, "disconnect">;

const SERVICE_RESTART_CLOSE_CODE = 1012;
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const NORMAL_CLOSE_CODE = 1000;

function createBrowserSocket(url: string): PilotRealtimeSocket {
  return new WebSocket(url);
}

function createDefaultScheduler(): PilotRealtimeScheduler {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer as number),
  };
}

function isOpen(socket: PilotRealtimeSocket | null): boolean {
  return socket !== null && socket.readyState === socket.OPEN;
}

export function getPilotRealtimeWsUrl(): string {
  return process.env.NEXT_PUBLIC_PILOT_REALTIME_WS_URL?.trim() ?? "";
}

export function disconnectPilotRealtimeForSignedOut(client: PilotRealtimeDisconnectClient): void {
  client.disconnect("Supabase signed out");
}

export class PilotRealtimeClient {
  private readonly authProvider: PilotRealtimeAuthProvider;
  private readonly baseReconnectDelayMs: number;
  private readonly jitterRatio: number;
  private readonly maxReconnectAttempts: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onMessage?: (message: PilotRealtimeServerMessage) => void;
  private readonly onStateChange?: (snapshot: PilotRealtimeStateSnapshot) => void;
  private readonly random: () => number;
  private readonly scheduler: PilotRealtimeScheduler;
  private readonly socketFactory: PilotRealtimeSocketFactory;
  private readonly url: string;
  private currentReconnectAttempt = 0;
  private explicitDisconnect = false;
  private generation = 0;
  private reconnectTimer: PilotRealtimeTimerHandle | null = null;
  private reauthInFlight = false;
  private sessionId: string | null = null;
  private socketListenerCleanup: (() => void) | null = null;
  private socket: PilotRealtimeSocket | null = null;
  private state: PilotRealtimeConnectionState = "idle";
  private stateError: PilotRealtimeStateSnapshot["error"] = null;

  constructor(options: PilotRealtimeClientOptions) {
    this.authProvider = options.authProvider;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 250;
    this.jitterRatio = options.jitterRatio ?? 0.25;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 4;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 4_000;
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange;
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? createDefaultScheduler();
    this.socketFactory = options.socketFactory ?? createBrowserSocket;
    this.url = options.url.trim();
  }

  get snapshot(): PilotRealtimeStateSnapshot {
    return {
      state: this.state,
      sessionId: this.sessionId,
      error: this.stateError,
      reconnectAttempt: this.currentReconnectAttempt,
    };
  }

  connect(): void {
    if (!this.url) {
      this.setState("error", "configuration_missing");
      return;
    }

    if (this.state !== "idle" && this.state !== "closed" && this.state !== "error") {
      return;
    }

    if (this.socket !== null && this.socket.readyState !== this.socket.CLOSED) {
      return;
    }

    this.explicitDisconnect = false;
    this.clearReconnectTimer();
    this.currentReconnectAttempt = 0;
    this.openSocket();
  }

  disconnect(reason = "Client disconnected"): void {
    this.explicitDisconnect = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.detachSocketListeners();
    this.reauthInFlight = false;
    this.sessionId = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
      socket.close(NORMAL_CLOSE_CODE, reason);
    }
    this.setState("closed", "closed");
  }

  endSession(reason?: string): void {
    if (!isOpen(this.socket)) {
      this.disconnect("Session ended by client");
      return;
    }

    this.explicitDisconnect = true;
    this.clearReconnectTimer();
    this.socket?.send(serializePilotRealtimeClientMessage({ type: "session.end", reason }));
    this.disconnect("Session ended by client");
  }

  ping(): void {
    if (!isOpen(this.socket)) {
      return;
    }

    this.socket?.send(
      serializePilotRealtimeClientMessage({
        type: "ping",
        sentAt: new Date().toISOString(),
      })
    );
  }

  sendRuntimeEvent(
    message: Extract<
      PilotRealtimeClientMessage,
      {
        type:
          | "transcript.partial"
          | "transcript.final"
          | "question.detected"
          | "screen.context"
          | "session.metrics";
      }
    >
  ): boolean {
    if (!isOpen(this.socket) || this.state !== "ready") {
      return false;
    }

    this.socket?.send(serializePilotRealtimeClientMessage(message));
    return true;
  }

  reauthenticate(): void {
    if (!isOpen(this.socket) || this.state !== "ready" || this.reauthInFlight) {
      return;
    }

    this.reauthInFlight = true;
    const capturedGeneration = this.generation;
    void this.sendTokenMessage("session.reauthenticate", capturedGeneration).catch(() => {
      if (capturedGeneration !== this.generation) {
        return;
      }
      this.failAuthentication();
    });
  }

  cleanup(): void {
    this.disconnect("Realtime client cleanup");
  }

  private openSocket(): void {
    this.generation += 1;
    const capturedGeneration = this.generation;
    this.sessionId = null;
    this.reauthInFlight = false;
    this.setState(this.currentReconnectAttempt > 0 ? "reconnecting" : "connecting", null);

    let socket: PilotRealtimeSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.scheduleReconnectOrClose(SERVICE_RESTART_CLOSE_CODE);
      return;
    }

    this.socket = socket;

    const removeListeners = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("open", onOpen);
    };

    const onOpen: EventListener = (): void => {
      if (capturedGeneration !== this.generation) {
        return;
      }
      this.setState("connecting", null);
    };

    const onMessage: EventListener = (event): void => {
      if (capturedGeneration !== this.generation) {
        return;
      }
      void this.handleRawMessage((event as MessageEvent).data, capturedGeneration);
    };

    const onClose: EventListener = (event): void => {
      removeListeners();
      if (this.socketListenerCleanup === removeListeners) {
        this.socketListenerCleanup = null;
      }
      if (capturedGeneration !== this.generation) {
        return;
      }

      this.socket = null;
      const closeCode = typeof (event as CloseEvent).code === "number" ? (event as CloseEvent).code : 0;
      this.handleClose(closeCode);
    };

    const onError: EventListener = (): void => {
      if (capturedGeneration !== this.generation) {
        return;
      }
      this.setState("error", "connection_failed");
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    this.socketListenerCleanup = removeListeners;
  }

  private async handleRawMessage(rawMessage: unknown, capturedGeneration: number): Promise<void> {
    const message = parsePilotRealtimeServerMessage(rawMessage);
    if (message === null) {
      return;
    }

    this.onMessage?.(message);

    switch (message.type) {
      case "session.auth_required":
        this.sessionId = message.sessionId;
        this.setState("authenticating", null);
        try {
          await this.sendTokenMessage("session.authenticate", capturedGeneration);
        } catch {
          if (capturedGeneration === this.generation) {
            this.failAuthentication();
          }
        }
        break;
      case "session.ready":
        this.sessionId = message.sessionId;
        this.currentReconnectAttempt = 0;
        this.setState("ready", null);
        break;
      case "session.auth_refreshed":
        this.sessionId = message.sessionId;
        this.reauthInFlight = false;
        this.setState("ready", null);
        break;
      case "error":
        if (message.code === "authentication_failed") {
          this.failAuthentication();
        }
        break;
      case "session.ended":
        this.disconnect("Session ended");
        break;
      case "event.ack":
        break;
      case "pong":
        break;
    }
  }

  private async sendTokenMessage(type: "session.authenticate" | "session.reauthenticate", capturedGeneration: number): Promise<void> {
    const accessToken = await this.authProvider.getAccessToken();
    if (capturedGeneration !== this.generation || !isOpen(this.socket)) {
      return;
    }

    if (!accessToken) {
      throw new Error("access token unavailable");
    }

    this.socket?.send(serializePilotRealtimeClientMessage({ type, accessToken }));
  }

  private failAuthentication(): void {
    this.explicitDisconnect = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.detachSocketListeners();
    this.reauthInFlight = false;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
      socket.close(POLICY_VIOLATION_CLOSE_CODE, "Authentication failed");
    }
    this.setState("error", "authentication_failed");
  }

  private handleClose(closeCode: number): void {
    this.reauthInFlight = false;
    this.sessionId = null;

    if (this.explicitDisconnect || closeCode === POLICY_VIOLATION_CLOSE_CODE) {
      this.setState(closeCode === POLICY_VIOLATION_CLOSE_CODE ? "error" : "closed", closeCode === POLICY_VIOLATION_CLOSE_CODE ? "authentication_failed" : "closed");
      return;
    }

    this.scheduleReconnectOrClose(closeCode);
  }

  private scheduleReconnectOrClose(closeCode: number): void {
    if (this.explicitDisconnect || closeCode === POLICY_VIOLATION_CLOSE_CODE) {
      this.setState("error", "authentication_failed");
      return;
    }

    if (this.currentReconnectAttempt >= this.maxReconnectAttempts) {
      this.setState("error", "connection_failed");
      return;
    }

    this.currentReconnectAttempt += 1;
    this.setState("reconnecting", null);
    const exponentialDelay = Math.min(
      this.maxReconnectDelayMs,
      this.baseReconnectDelayMs * 2 ** (this.currentReconnectAttempt - 1)
    );
    const jitter = exponentialDelay * this.jitterRatio * this.random();
    const delayMs = Math.round(exponentialDelay + jitter);
    this.clearReconnectTimer();
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private detachSocketListeners(): void {
    this.socketListenerCleanup?.();
    this.socketListenerCleanup = null;
  }

  private setState(state: PilotRealtimeConnectionState, error: PilotRealtimeStateSnapshot["error"]): void {
    this.state = state;
    this.stateError = error;
    this.onStateChange?.(this.snapshot);
  }
}
