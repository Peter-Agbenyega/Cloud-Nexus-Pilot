const DEFAULT_PORT = 10000;

export function getEnv() {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    corsOrigin: process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === "production" ? "" : "*"),
    authMode: process.env.AUTH_MODE ?? "mock",
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    dbProvider: process.env.DB_PROVIDER ?? "sqlite"
  };
}
