import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3010),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  DEEPGRAM_API_KEY: z.string().optional(),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(64 * 1024),
  WS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(100),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(10),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  WS_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && environment.CORS_ORIGIN.split(",").map((origin) => origin.trim()).includes("*")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CORS_ORIGIN"],
      message: "Production CORS_ORIGIN must list explicit origins.",
    });
  }
});

export type AppEnvironment = z.infer<typeof EnvironmentSchema>;

export function getEnvironment(source: NodeJS.ProcessEnv | Record<string, string | number | undefined> = process.env): AppEnvironment {
  const result = EnvironmentSchema.safeParse(source);

  if (!result.success) {
    console.error("Invalid environment configuration:", result.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }

  return result.data;
}
