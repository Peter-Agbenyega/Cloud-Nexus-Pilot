import type { FastifyPluginAsync } from "fastify";

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "api",
      version: "0.1.0",
      uptime: process.uptime(),
      dbProvider: process.env.DB_PROVIDER ?? "sqlite",
      aiProviders: {
        openai: process.env.OPENAI_API_KEY ? "configured" : "mock"
      }
    };
  });
};
