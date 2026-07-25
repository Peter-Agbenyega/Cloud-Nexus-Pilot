import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";
import { pathToFileURL } from "node:url";

import { getEnvironment } from "./env.js";
import type { AppEnvironment } from "./env.js";
import { getCorsOriginOption, parseOriginPolicy } from "./originPolicy.js";
import { registerSessionRoute } from "./sessionRoute.js";
import { WebSocketRuntime } from "./wsRuntime.js";

declare module "fastify" {
  interface FastifyInstance {
    webSocketRuntime: WebSocketRuntime;
  }
}

export type BuildServerOptions = {
  env?: AppEnvironment;
};

export function getTrustProxyOption(env: Pick<AppEnvironment, "WS_TRUSTED_PROXY_CIDRS">): false | string[] {
  return env.WS_TRUSTED_PROXY_CIDRS.length === 0 ? false : env.WS_TRUSTED_PROXY_CIDRS;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const env = options.env ?? getEnvironment();
  const originPolicy = parseOriginPolicy(env.CORS_ORIGIN);
  const runtime = new WebSocketRuntime(env);

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
    logController: new LogController({
      disableRequestLogging: true,
    }),
    trustProxy: getTrustProxyOption(env),
  });

  app.decorate("webSocketRuntime", runtime);

  await app.register(cors, {
    origin: getCorsOriginOption(originPolicy),
    credentials: true,
  });

  await app.register(websocket, {
    options: {
      maxPayload: env.WS_MAX_PAYLOAD_BYTES,
    },
    errorHandler(error, socket, request) {
      request.log.error({ err: error }, "Realtime WebSocket handler error");
      socket.terminate();
    },
  });

  registerSessionRoute(app, originPolicy, runtime);

  app.get("/health", async () => {
    return {
      ok: true,
      service: "cloud-nexus-pilot-realtime-api",
      environment: env.NODE_ENV,
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
      providers: {
        deepgram: env.DEEPGRAM_API_KEY ? "configured" : "missing",
        openai: env.OPENAI_API_KEY ? "configured" : "missing",
      },
    };
  });

  return app;
}

export async function shutdownServer(app: Awaited<ReturnType<typeof buildServer>>, graceMs?: number): Promise<void> {
  await app.webSocketRuntime.shutdown(app, graceMs);
}

async function startServer() {
  const env = getEnvironment();
  const app = await buildServer({ env });
  let shutdownStarted = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    app.log.info({ signal }, "Realtime API received shutdown signal");
    shutdownServer(app)
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Realtime API graceful shutdown failed");
        process.exit(1);
      });
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);

  try {
    await app.listen({
      host: env.HOST,
      port: env.PORT,
    });

    app.log.info(
      {
        host: env.HOST,
        port: env.PORT,
      },
      "Cloud Nexus Pilot realtime API started"
    );
  } catch (error) {
    app.log.error({ err: error }, "Unable to start realtime API");
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer();
}
