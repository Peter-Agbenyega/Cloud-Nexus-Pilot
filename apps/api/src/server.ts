import cors from "@fastify/cors";
import Fastify from "fastify";
import { healthRoute } from "./routes/health.js";
import { productsRoutes } from "./routes/products.js";
import { getEnv } from "./lib/env.js";

async function buildServer() {
  const env = getEnv();
  const app = Fastify({
    logger: {
      level: env.nodeEnv === "development" ? "debug" : "info"
    }
  });

  await app.register(cors, {
    origin: env.corsOrigin === "*"
      ? true
      : env.corsOrigin
        ? env.corsOrigin.split(",").map((o) => o.trim())
        : false,
    credentials: true
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const message = error instanceof Error ? error.message : "Unknown error";

    reply.status(500).send({
      error: "internal_error",
      message: env.nodeEnv === "development" ? message : "Internal server error"
    });
  });

  await app.register(healthRoute);
  await app.register(productsRoutes);

  return app;
}

async function start() {
  const env = getEnv();
  const app = await buildServer();

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    app.log.info(`api listening on :${env.port}`);
  } catch (error: unknown) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
