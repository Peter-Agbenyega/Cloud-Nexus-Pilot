import { z } from "zod";
import { isIP } from "node:net";

function isTrustedProxyEntry(value: string): boolean {
  const [address, prefix, extra] = value.split("/");

  if (address === undefined || address.length === 0 || extra !== undefined || isIP(address) === 0) {
    return false;
  }

  if (prefix === undefined) {
    return true;
  }

  if (!/^\d+$/.test(prefix)) {
    return false;
  }

  const prefixLength = Number(prefix);
  const maxPrefixLength = isIP(address) === 4 ? 32 : 128;
  return prefixLength >= 0 && prefixLength <= maxPrefixLength;
}

const TrustedProxyCidrsSchema = z.preprocess((value) => {
  if (value === undefined || value === "") {
    return [];
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return value;
}, z.array(z.string().refine(isTrustedProxyEntry, "Must be an IP address or CIDR range.")).default([]));

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
  WS_TRUSTED_PROXY_CIDRS: TrustedProxyCidrsSchema,
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

export function getEnvironment(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): AppEnvironment {
  const result = EnvironmentSchema.safeParse(source);

  if (!result.success) {
    console.error("Invalid environment configuration:", result.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }

  return result.data;
}
