import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { AuthVerificationError, type AuthVerifier, type VerifiedAuthToken } from "./authVerifier.js";
import type { AppEnvironment } from "./env.js";
import { isWebSocketOriginAllowed, type OriginPolicy } from "./originPolicy.js";
import {
  parseClientMessage,
  serializeServerMessage,
  WEBSOCKET_PROTOCOL_VERSION,
} from "./sessionProtocol.js";
import { WS_CLOSE_CODES, type WebSocketRuntime } from "./wsRuntime.js";

const AUTHENTICATION_ERROR = {
  type: "error",
  code: "authentication_failed",
  message: "Authentication failed.",
} as const;

function expirationIso(expiresAtEpochSeconds: number): string {
  return new Date(expiresAtEpochSeconds * 1000).toISOString();
}

function millisecondsUntilExpiry(expiresAtEpochSeconds: number): number {
  return Math.max(0, expiresAtEpochSeconds * 1000 - Date.now());
}

export function registerSessionRoute(
  app: FastifyInstance,
  originPolicy: OriginPolicy,
  runtime: WebSocketRuntime,
  authVerifier: AuthVerifier,
  env: Pick<AppEnvironment, "WS_AUTH_TIMEOUT_MS">
): void {
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
      let authenticatedUser: VerifiedAuthToken | undefined;
      let authInFlight = false;
      let expirationTimer: NodeJS.Timeout | undefined;
      let authGeneration = 0;
      let expirationGeneration = 0;
      let authenticationFailed = false;
      let sessionOpen = true;
      let activeAuthController: AbortController | undefined;

      if (!registration.accepted) {
        return;
      }

      const abortActiveAuthController = (): void => {
        activeAuthController?.abort("authentication attempt cancelled");
        activeAuthController = undefined;
      };

      const clearExpirationTimer = (): void => {
        expirationGeneration += 1;
        if (expirationTimer !== undefined) {
          clearTimeout(expirationTimer);
          expirationTimer = undefined;
        }
      };

      const closeForPolicyViolation = (): void => {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          socket.close(WS_CLOSE_CODES.policyViolation, "Policy violation");
        }
      };

      const failAuthentication = (category: string): void => {
        authenticationFailed = true;
        authGeneration += 1;
        abortActiveAuthController();
        clearTimeout(authTimeout);
        clearExpirationTimer();
        request.log.warn(
          {
            sessionId,
            clientIp: registration.clientIp,
            userId: authenticatedUser?.userId,
            authErrorCategory: category,
            closeCode: WS_CLOSE_CODES.policyViolation,
          },
          "Realtime WebSocket authentication failed"
        );
        if (socket.readyState === socket.OPEN) {
          socket.send(serializeServerMessage(AUTHENTICATION_ERROR));
        }
        closeForPolicyViolation();
      };

      const scheduleExpirationClose = (verifiedToken: VerifiedAuthToken): void => {
        clearExpirationTimer();
        expirationGeneration += 1;
        const capturedExpirationGeneration = expirationGeneration;
        const capturedUserId = verifiedToken.userId;
        const capturedExpiresAt = verifiedToken.expiresAtEpochSeconds;

        // The close is scheduled exactly at the JWT exp value. It is not padded
        // for clock skew because doing so would extend an already expired token.
        expirationTimer = setTimeout(() => {
          if (
            !sessionOpen ||
            socket.readyState !== socket.OPEN ||
            capturedExpirationGeneration !== expirationGeneration ||
            authenticatedUser?.userId !== capturedUserId ||
            authenticatedUser.expiresAtEpochSeconds !== capturedExpiresAt
          ) {
            return;
          }

          request.log.info(
            {
              sessionId,
              clientIp: registration.clientIp,
              userId: capturedUserId,
              closeCode: WS_CLOSE_CODES.policyViolation,
            },
            "Closing WebSocket session because authentication token expired"
          );
          closeForPolicyViolation();
        }, millisecondsUntilExpiry(verifiedToken.expiresAtEpochSeconds));
      };

      const authTimeout = setTimeout(() => {
        authenticationFailed = true;
        authGeneration += 1;
        abortActiveAuthController();
        request.log.warn(
          {
            sessionId,
            clientIp: registration.clientIp,
            closeCode: WS_CLOSE_CODES.policyViolation,
          },
          "Closing WebSocket session because authentication timed out"
        );
        closeForPolicyViolation();
      }, env.WS_AUTH_TIMEOUT_MS);

      const beginAuthentication = (): { controller: AbortController; generation: number } => {
        abortActiveAuthController();
        const controller = new AbortController();
        activeAuthController = controller;
        authInFlight = true;
        authGeneration += 1;
        return { controller, generation: authGeneration };
      };

      const clearActiveAuthController = (controller: AbortController): void => {
        if (activeAuthController === controller) {
          activeAuthController = undefined;
        }
      };

      const canApplyAuthResult = (capturedAuthGeneration: number): boolean => {
        return (
          sessionOpen &&
          socket.readyState === socket.OPEN &&
          !authenticationFailed &&
          !runtime.isShuttingDown &&
          capturedAuthGeneration === authGeneration
        );
      };

      request.log.info(
        {
          sessionId,
          clientIp: registration.clientIp,
        },
        "Realtime WebSocket session connected"
      );

      socket.send(
        serializeServerMessage({
          type: "session.auth_required",
          sessionId,
          protocolVersion: WEBSOCKET_PROTOCOL_VERSION,
          authTimeoutMs: env.WS_AUTH_TIMEOUT_MS,
        })
      );

      const unregisterShutdownAbort = registration.onShutdownStart(() => {
        authGeneration += 1;
        abortActiveAuthController();
      });

      socket.on("message", (rawData, isBinary) => {
        if (isBinary) {
          if (authenticatedUser === undefined) {
            socket.send(serializeServerMessage(AUTHENTICATION_ERROR));
            closeForPolicyViolation();
            return;
          }

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

        if (authenticatedUser === undefined && result.message.type !== "session.authenticate") {
          failAuthentication("pre_auth_message");
          return;
        }

        switch (result.message.type) {
          case "session.authenticate": {
            if (authenticatedUser !== undefined || authInFlight) {
              failAuthentication("duplicate_authentication");
              return;
            }

            const { controller, generation: capturedAuthGeneration } = beginAuthentication();
            authVerifier
              .verifyAccessToken(result.message.accessToken, controller.signal)
              .then((verifiedToken) => {
                if (!canApplyAuthResult(capturedAuthGeneration)) {
                  return;
                }

                authenticatedUser = verifiedToken;
                registration.setAuthenticatedUser(verifiedToken.userId, verifiedToken.expiresAtEpochSeconds);
                clearTimeout(authTimeout);
                scheduleExpirationClose(verifiedToken);
                registration.noteValidClientActivity();
                request.log.info(
                  {
                    sessionId,
                    clientIp: registration.clientIp,
                    userId: verifiedToken.userId,
                  },
                  "Realtime WebSocket session authenticated"
                );
                socket.send(
                  serializeServerMessage({
                    type: "session.ready",
                    sessionId,
                    protocolVersion: WEBSOCKET_PROTOCOL_VERSION,
                    connectedAt,
                    expiresAt: expirationIso(verifiedToken.expiresAtEpochSeconds),
                  })
                );
              })
              .catch((error: unknown) => {
                const category = error instanceof AuthVerificationError ? error.category : "verifier_exception";
                if (canApplyAuthResult(capturedAuthGeneration)) {
                  failAuthentication(category);
                }
              })
              .finally(() => {
                clearActiveAuthController(controller);
                if (capturedAuthGeneration === authGeneration) {
                  authInFlight = false;
                }
              });
            break;
          }

          case "session.reauthenticate": {
            if (authInFlight) {
              failAuthentication("concurrent_authentication");
              return;
            }

            const { controller, generation: capturedAuthGeneration } = beginAuthentication();
            authVerifier
              .verifyAccessToken(result.message.accessToken, controller.signal)
              .then((verifiedToken) => {
                if (!canApplyAuthResult(capturedAuthGeneration)) {
                  return;
                }

                if (authenticatedUser === undefined || verifiedToken.userId !== authenticatedUser.userId) {
                  failAuthentication("identity_switch");
                  return;
                }

                authenticatedUser = verifiedToken;
                registration.setAuthenticatedUser(verifiedToken.userId, verifiedToken.expiresAtEpochSeconds);
                scheduleExpirationClose(verifiedToken);
                registration.noteValidClientActivity();
                socket.send(
                  serializeServerMessage({
                    type: "session.auth_refreshed",
                    sessionId,
                    expiresAt: expirationIso(verifiedToken.expiresAtEpochSeconds),
                  })
                );
              })
              .catch((error: unknown) => {
                const category = error instanceof AuthVerificationError ? error.category : "verifier_exception";
                if (canApplyAuthResult(capturedAuthGeneration)) {
                  failAuthentication(category);
                }
              })
              .finally(() => {
                clearActiveAuthController(controller);
                if (capturedAuthGeneration === authGeneration) {
                  authInFlight = false;
                }
              });
            break;
          }

          case "ping":
            registration.noteValidClientActivity();
            socket.send(
              serializeServerMessage({
                type: "pong",
                receivedAt: new Date().toISOString(),
              })
            );
            break;

          case "session.end":
            registration.noteValidClientActivity();
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
        sessionOpen = false;
        authGeneration += 1;
        abortActiveAuthController();
        clearTimeout(authTimeout);
        clearExpirationTimer();
        unregisterShutdownAbort();
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
        sessionOpen = false;
        authGeneration += 1;
        abortActiveAuthController();
        clearTimeout(authTimeout);
        clearExpirationTimer();
        unregisterShutdownAbort();
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
