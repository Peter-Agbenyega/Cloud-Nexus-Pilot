export const PILOT_REALTIME_PROTOCOL_VERSION = "1.1" as const;

export type PilotRealtimeClientMessage =
  | {
      type: "session.authenticate";
      accessToken: string;
    }
  | {
      type: "session.reauthenticate";
      accessToken: string;
    }
  | {
      type: "ping";
      sentAt?: string;
    }
  | {
      type: "session.end";
      reason?: string;
    };

export type PilotRealtimeServerMessage =
  | {
      type: "session.auth_required";
      sessionId: string;
      protocolVersion: typeof PILOT_REALTIME_PROTOCOL_VERSION;
      authTimeoutMs: number;
    }
  | {
      type: "session.ready";
      sessionId: string;
      protocolVersion: typeof PILOT_REALTIME_PROTOCOL_VERSION;
      connectedAt: string;
      expiresAt: string;
    }
  | {
      type: "session.auth_refreshed";
      sessionId: string;
      expiresAt: string;
    }
  | {
      type: "pong";
      receivedAt: string;
    }
  | {
      type: "session.ended";
      sessionId: string;
      endedAt: string;
    }
  | {
      type: "error";
      code: "authentication_failed" | "invalid_json" | "invalid_message";
      message: string;
    };

export function parsePilotRealtimeServerMessage(rawMessage: unknown): PilotRealtimeServerMessage | null {
  if (typeof rawMessage !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }

  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "session.auth_required":
      if (
        typeof message.sessionId === "string" &&
        message.protocolVersion === PILOT_REALTIME_PROTOCOL_VERSION &&
        typeof message.authTimeoutMs === "number"
      ) {
        return message as PilotRealtimeServerMessage;
      }
      return null;
    case "session.ready":
      if (
        typeof message.sessionId === "string" &&
        message.protocolVersion === PILOT_REALTIME_PROTOCOL_VERSION &&
        typeof message.connectedAt === "string" &&
        typeof message.expiresAt === "string"
      ) {
        return message as PilotRealtimeServerMessage;
      }
      return null;
    case "session.auth_refreshed":
      if (typeof message.sessionId === "string" && typeof message.expiresAt === "string") {
        return message as PilotRealtimeServerMessage;
      }
      return null;
    case "pong":
      if (typeof message.receivedAt === "string") {
        return message as PilotRealtimeServerMessage;
      }
      return null;
    case "session.ended":
      if (typeof message.sessionId === "string" && typeof message.endedAt === "string") {
        return message as PilotRealtimeServerMessage;
      }
      return null;
    case "error":
      if (
        (message.code === "authentication_failed" ||
          message.code === "invalid_json" ||
          message.code === "invalid_message") &&
        typeof message.message === "string"
      ) {
        return message as PilotRealtimeServerMessage;
      }
      return null;
    default:
      return null;
  }
}

export function serializePilotRealtimeClientMessage(message: PilotRealtimeClientMessage): string {
  return JSON.stringify(message);
}
