import fs from "node:fs";
import path from "node:path";
import { getPostgresClient, getSqliteClient, resolveDbConfig } from "./client.js";

async function run(): Promise<void> {
  const config = resolveDbConfig();
  const migrationsRoot = path.resolve(process.cwd(), "migrations", config.provider);
  const files = fs
    .readdirSync(migrationsRoot)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log(`[db:migrate] no migrations found in ${migrationsRoot}`);
    return;
  }

  if (config.provider === "postgres") {
    if (!config.postgresUrl) {
      throw new Error("DATABASE_URL is required for postgres migrations");
    }

    const pool = getPostgresClient(config.postgresUrl);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsRoot, file), "utf8");
      console.log(`[db:migrate] applying postgres migration ${file}`);
      await pool.query(sql);
    }
    await pool.end();
    console.log("[db:migrate] postgres migrations complete");
    return;
  }

  const sqlitePath = config.sqliteFile;
  if (!sqlitePath) {
    throw new Error("SQLITE_FILE is required for sqlite migrations");
  }

  const sqlite = getSqliteClient(sqlitePath);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsRoot, file), "utf8");
    console.log(`[db:migrate] applying sqlite migration ${file}`);
    sqlite.exec(sql);
  }
  sqlite.close();
  console.log("[db:migrate] sqlite migrations complete");
}

run().catch((error) => {
  console.error("[db:migrate] failed", error);
  process.exit(1);
});
