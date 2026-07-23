import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  parseClientMessage,
  serializeServerMessage,
  WEBSOCKET_PROTOCOL_VERSION,
} from "./sessionProtocol.js";

export function registerSessionRoute(app: FastifyInstance): void {
  app.get(
    "/ws/session",
    {
      websocket: true,
    },
    (socket, request) => {
      const sessionId = randomUUID();
      const connectedAt = new Date().toISOString();

      request.log.info(
        {
          sessionId,
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

            socket.close(1000, "Session ended by client");
            break;
        }
      });

      socket.on("close", (code) => {
        request.log.info(
          {
            sessionId,
            closeCode: code,
          },
          "Realtime WebSocket session disconnected"
        );
      });

      socket.on("error", (error) => {
        request.log.error(
          {
            sessionId,
            error,
          },
          "Realtime WebSocket session error"
        );
      });
    }
  );
}
