import Database from "better-sqlite3";
import { Pool } from "pg";
import type { DbConfig } from "./types.js";
export declare function resolveDbConfig(): DbConfig;
export declare function getSqliteClient(filePath: string): Database.Database;
export declare function getPostgresClient(connectionString: string): Pool;
export declare function closeDbClients(): Promise<void>;
//# sourceMappingURL=client.d.ts.map