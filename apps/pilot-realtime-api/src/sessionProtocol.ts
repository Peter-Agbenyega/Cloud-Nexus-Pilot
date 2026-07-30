import { z } from "zod";

export const WEBSOCKET_PROTOCOL_VERSION = "1.1" as const;

const AccessTokenSchema = z.string().trim().min(1).max(8_192);

const AuthenticateMessageSchema = z
  .object({
    type: z.literal("session.authenticate"),
    accessToken: AccessTokenSchema,
  })
  .strict();

const ReauthenticateMessageSchema = z
  .object({
    type: z.literal("session.reauthenticate"),
    accessToken: AccessTokenSchema,
  })
  .strict();

const PingMessageSchema = z
  .object({
    type: z.literal("ping"),
    sentAt: z.string().datetime().optional(),
  })
  .strict();

const EndSessionMessageSchema = z
  .object({
    type: z.literal("session.end"),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  AuthenticateMessageSchema,
  ReauthenticateMessageSchema,
  PingMessageSchema,
  EndSessionMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | {
      type: "session.auth_required";
      sessionId: string;
      protocolVersion: typeof WEBSOCKET_PROTOCOL_VERSION;
      authTimeoutMs: number;
    }
  | {
      type: "session.ready";
      sessionId: string;
      protocolVersion: typeof WEBSOCKET_PROTOCOL_VERSION;
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

export type ClientMessageParseResult =
  | {
      success: true;
      message: ClientMessage;
    }
  | {
      success: false;
      error: ServerMessage;
    };

export function parseClientMessage(rawMessage: string): ClientMessageParseResult {
  let parsedMessage: unknown;

  try {
    parsedMessage = JSON.parse(rawMessage);
  } catch {
    return {
      success: false,
      error: {
        type: "error",
        code: "invalid_json",
        message: "Message must contain valid JSON.",
      },
    };
  }

  const result = ClientMessageSchema.safeParse(parsedMessage);

  if (!result.success) {
    return {
      success: false,
      error: {
        type: "error",
        code: "invalid_message",
        message: "Message does not match the supported WebSocket protocol.",
      },
    };
  }

  return {
    success: true,
    message: result.data,
  };
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
