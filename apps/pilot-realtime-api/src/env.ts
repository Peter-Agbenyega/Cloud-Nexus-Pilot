import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3010),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  DEEPGRAM_API_KEY: z.string().optional(),
});

export type AppEnvironment = z.infer<typeof EnvironmentSchema>;

export function getEnvironment(): AppEnvironment {
  const result = EnvironmentSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment configuration:", result.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }

  return result.data;
}
