import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Pool } from "pg";
let sqlite = null;
let postgres = null;
export function resolveDbConfig() {
    const provider = (process.env.DB_PROVIDER ?? "sqlite");
    if (provider === "postgres") {
        return { provider, postgresUrl: process.env.DATABASE_URL };
    }
    const sqliteFile = process.env.SQLITE_FILE ?? path.resolve(process.cwd(), ".data/dev.db");
    return { provider, sqliteFile };
}
export function getSqliteClient(filePath) {
    if (sqlite) {
        return sqlite;
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    sqlite = new Database(filePath);
    sqlite.pragma("journal_mode = WAL");
    return sqlite;
}
export function getPostgresClient(connectionString) {
    if (postgres) {
        return postgres;
    }
    postgres = new Pool({ connectionString });
    return postgres;
}
export async function closeDbClients() {
    if (postgres) {
        await postgres.end();
        postgres = null;
    }
    if (sqlite) {
        sqlite.close();
        sqlite = null;
    }
}
//# sourceMappingURL=client.js.map