import { z } from "zod";

export const WEBSOCKET_PROTOCOL_VERSION = "1.1" as const;

const AccessTokenSchema = z.string().trim().min(1).max(8_192);
const ClientEventIdSchema = z.string().trim().min(1).max(120).optional();
const TimestampSchema = z.string().datetime().optional();

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

const TranscriptPartialMessageSchema = z
  .object({
    type: z.literal("transcript.partial"),
    clientEventId: ClientEventIdSchema,
    text: z.string().trim().min(1).max(8_000),
    source: z.enum(["microphone", "system-audio", "screen", "manual"]).default("manual"),
    timestamp: TimestampSchema,
  })
  .strict();

const TranscriptFinalMessageSchema = z
  .object({
    type: z.literal("transcript.final"),
    clientEventId: ClientEventIdSchema,
    text: z.string().trim().min(1).max(16_000),
    source: z.enum(["microphone", "system-audio", "screen", "manual"]).default("manual"),
    timestamp: TimestampSchema,
  })
  .strict();

const QuestionDetectedMessageSchema = z
  .object({
    type: z.literal("question.detected"),
    clientEventId: ClientEventIdSchema,
    questionId: z.string().trim().min(1).max(160),
    normalizedQuestion: z.string().trim().min(1).max(2_000),
    category: z.string().trim().min(1).max(80),
    confidence: z.number().min(0).max(1),
    timestamp: TimestampSchema,
  })
  .strict();

const ScreenContextMessageSchema = z
  .object({
    type: z.literal("screen.context"),
    clientEventId: ClientEventIdSchema,
    sourceType: z.string().trim().min(1).max(80),
    extractedText: z.string().trim().max(8_000),
    timestamp: TimestampSchema,
  })
  .strict();

const GuidanceMetricMessageSchema = z
  .object({
    type: z.literal("session.metrics"),
    clientEventId: ClientEventIdSchema,
    metrics: z
      .object({
        capture_to_server_ms: z.number().nonnegative().optional(),
        stt_first_partial_ms: z.number().nonnegative().optional(),
        question_detect_ms: z.number().nonnegative().optional(),
        context_retrieval_ms: z.number().nonnegative().optional(),
        llm_first_token_ms: z.number().nonnegative().optional(),
        guidance_first_render_ms: z.number().nonnegative().optional(),
        total_first_guidance_ms: z.number().nonnegative().optional(),
      })
      .strict(),
    timestamp: TimestampSchema,
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  AuthenticateMessageSchema,
  ReauthenticateMessageSchema,
  PingMessageSchema,
  EndSessionMessageSchema,
  TranscriptPartialMessageSchema,
  TranscriptFinalMessageSchema,
  QuestionDetectedMessageSchema,
  ScreenContextMessageSchema,
  GuidanceMetricMessageSchema,
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
      type: "event.ack";
      sessionId: string;
      clientEventId?: string;
      receivedType:
        | "transcript.partial"
        | "transcript.final"
        | "question.detected"
        | "screen.context"
        | "session.metrics";
      receivedAt: string;
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
