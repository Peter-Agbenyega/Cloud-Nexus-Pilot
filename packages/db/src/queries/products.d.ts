import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Pool } from "pg";
import type { ProductListFilters, ProductRecord } from "../types.js";
export interface ProductQueries {
    listProducts(filters: ProductListFilters): Promise<{
        items: ProductRecord[];
        total: number;
    }>;
    getProductById(id: string): Promise<ProductRecord | null>;
    searchProducts(query: string, page: number, pageSize: number): Promise<{
        items: ProductRecord[];
        total: number;
    }>;
}
export declare function createSqliteProductQueries(db: SqliteDatabase): ProductQueries;
export declare function createPostgresProductQueries(pool: Pool): ProductQueries;
//# sourceMappingURL=products.d.ts.map