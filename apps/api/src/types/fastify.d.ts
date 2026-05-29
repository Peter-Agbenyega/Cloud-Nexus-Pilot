import "fastify";
import type { AuthContext } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}
