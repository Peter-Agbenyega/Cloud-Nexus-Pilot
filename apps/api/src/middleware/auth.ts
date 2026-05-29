import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "../types/auth.js";

function parseMockRole(authHeader: string | undefined): AuthUser["role"] {
  if (!authHeader) {
    return "admin";
  }

  if (authHeader.includes("analyst")) {
    return "analyst";
  }

  if (authHeader.includes("user")) {
    return "user";
  }

  return "admin";
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authMode = process.env.AUTH_MODE ?? "mock";
  const authHeader = request.headers.authorization;

  if (authMode === "mock") {
    request.auth = {
      user: {
        id: "local-dev-user",
        role: parseMockRole(authHeader)
      }
    };
    return;
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.status(401).send({
      error: "unauthorized",
      message: "Missing bearer token"
    });
    return;
  }

  // Phase 1 scaffold: Supabase JWT verification wiring will be completed with real key validation.
  const token = authHeader.slice("Bearer ".length);
  if (!token) {
    reply.status(401).send({ error: "unauthorized", message: "Invalid bearer token" });
    return;
  }

  request.auth = {
    user: {
      id: "supabase-user-scaffold",
      role: "user"
    }
  };
}
