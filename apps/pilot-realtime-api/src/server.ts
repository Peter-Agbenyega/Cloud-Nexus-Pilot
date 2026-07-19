import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import { getEnvironment } from "./env.js";

async function buildServer() {
  const env = getEnvironment();

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
  });

  await app.register(cors, {
    origin:
      env.CORS_ORIGIN === "*"
        ? true
        : env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true,
  });

  await app.register(websocket);

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

async function startServer() {
  const env = getEnvironment();
  const app = await buildServer();

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
    app.log.error(error, "Unable to start realtime API");
    process.exit(1);
  }
}

void startServer();
