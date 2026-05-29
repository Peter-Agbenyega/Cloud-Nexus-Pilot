import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Pool } from "pg";
import type { DbConfig } from "./types.js";

let sqlite: Database.Database | null = null;
let postgres: Pool | null = null;

function defaultSqliteFile(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  return path.resolve(currentDir, "..", ".data", "dev.db");
}

export function resolveDbConfig(): DbConfig {
  const provider = (process.env.DB_PROVIDER ?? "sqlite") as "postgres" | "sqlite";

  if (provider === "postgres") {
    return { provider, postgresUrl: process.env.DATABASE_URL };
  }

  const sqliteFile = process.env.SQLITE_FILE ?? defaultSqliteFile();
  return { provider, sqliteFile };
}

export function getSqliteClient(filePath: string): Database.Database {
  if (sqlite) {
    return sqlite;
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

export function getPostgresClient(connectionString: string): Pool {
  if (postgres) {
    return postgres;
  }

  postgres = new Pool({ connectionString });
  return postgres;
}

export async function closeDbClients(): Promise<void> {
  if (postgres) {
    await postgres.end();
    postgres = null;
  }

  if (sqlite) {
    sqlite.close();
    sqlite = null;
  }
}
