import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { isWebSocketOriginAllowed, type OriginPolicy } from "./originPolicy.js";
import {
  parseClientMessage,
  serializeServerMessage,
  WEBSOCKET_PROTOCOL_VERSION,
} from "./sessionProtocol.js";
import { WS_CLOSE_CODES, type WebSocketRuntime } from "./wsRuntime.js";

export function registerSessionRoute(app: FastifyInstance, originPolicy: OriginPolicy, runtime: WebSocketRuntime): void {
  app.get(
    "/ws/session",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!runtime.canAcceptHttpUpgrade()) {
          request.log.info("Rejected WebSocket session while server is shutting down");
          await reply.code(503).send({ error: "Service Unavailable" });
          return;
        }

        if (isWebSocketOriginAllowed(request.headers.origin, originPolicy)) {
          return;
        }

        request.log.warn("Rejected WebSocket session from unauthorized origin");
        await reply.code(403).send({ error: "Forbidden" });
      },
    },
    (socket, request) => {
      const sessionId = randomUUID();
      const connectedAt = new Date().toISOString();
      const registration = runtime.registerSession(socket, request, sessionId);

      if (!registration.accepted) {
        return;
      }

      request.log.info(
        {
          sessionId,
          clientIp: registration.clientIp,
        },
        "Realtime WebSocket session connected"
      );

      socket.send(
        serializeServerMessage({
          type: "session.ready",
          sessionId,
          protocolVersion: WEBSOCKET_PROTOCOL_VERSION,
          connectedAt,
        })
      );

      socket.on("message", (rawData, isBinary) => {
        if (isBinary) {
          socket.send(
            serializeServerMessage({
              type: "error",
              code: "invalid_message",
              message: "Binary messages are not supported.",
            })
          );

          return;
        }

        const result = parseClientMessage(rawData.toString());

        if (!result.success) {
          socket.send(serializeServerMessage(result.error));
          return;
        }

        registration.noteValidClientActivity();

        switch (result.message.type) {
          case "ping":
            socket.send(
              serializeServerMessage({
                type: "pong",
                receivedAt: new Date().toISOString(),
              })
            );
            break;

          case "session.end":
            socket.send(
              serializeServerMessage({
                type: "session.ended",
                sessionId,
                endedAt: new Date().toISOString(),
              })
            );

            socket.close(WS_CLOSE_CODES.normal, "Session ended by client");
            break;
        }
      });

      socket.on("close", (code) => {
        registration.cleanup();
        request.log.info(
          {
            sessionId,
            clientIp: registration.clientIp,
            closeCode: code,
          },
          "Realtime WebSocket session disconnected"
        );
      });

      socket.on("error", (error) => {
        registration.cleanup();
        request.log.error(
          {
            sessionId,
            clientIp: registration.clientIp,
            err: error,
          },
          "Realtime WebSocket session error"
        );
      });
    }
  );
}
