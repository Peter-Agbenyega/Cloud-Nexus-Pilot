import { getPostgresClient, getSqliteClient, resolveDbConfig } from "./client.js";
import { createPostgresProductQueries, createSqliteProductQueries } from "./queries/products.js";

export * from "./types.js";
export { closeDbClients, resolveDbConfig } from "./client.js";

export function createDb() {
  const config = resolveDbConfig();

  if (config.provider === "postgres") {
    if (!config.postgresUrl) {
      throw new Error("DB_PROVIDER=postgres requires DATABASE_URL");
    }

    const pool = getPostgresClient(config.postgresUrl);
    return {
      provider: config.provider,
      products: createPostgresProductQueries(pool)
    };
  }

  const sqlitePath = config.sqliteFile;
  if (!sqlitePath) {
    throw new Error("DB_PROVIDER=sqlite requires SQLITE_FILE");
  }

  const sqlite = getSqliteClient(sqlitePath);
  return {
    provider: config.provider,
    products: createSqliteProductQueries(sqlite)
  };
}
