import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Pool } from "pg";
import type { ProductListFilters, ProductRecord } from "../types.js";

export interface ProductQueries {
  listProducts(filters: ProductListFilters): Promise<{ items: ProductRecord[]; total: number }>;
  getProductById(id: string): Promise<ProductRecord | null>;
  searchProducts(query: string, page: number, pageSize: number): Promise<{ items: ProductRecord[]; total: number }>;
}

function mapSqliteProduct(row: Record<string, unknown>): ProductRecord {
  return {
    id: String(row.id),
    supplierId: String(row.supplier_id),
    supplierSku: String(row.supplier_sku),
    title: String(row.title),
    description: String(row.description ?? ""),
    priceAmount: Number(row.price_amount ?? 0),
    supplierCost: Number(row.supplier_cost ?? 0),
    suggestedRetail: row.suggested_retail == null ? null : Number(row.suggested_retail),
    images: JSON.parse(String(row.images ?? "[]")) as string[],
    categories: JSON.parse(String(row.categories ?? "[]")) as string[],
    shippingMinDays: row.shipping_min_days == null ? null : Number(row.shipping_min_days),
    shippingMaxDays: row.shipping_max_days == null ? null : Number(row.shipping_max_days),
    shippingCost: Number(row.shipping_cost ?? 0),
    shippingCountries: JSON.parse(String(row.shipping_countries ?? "[]")) as string[],
    reviewCount: Number(row.review_count ?? 0),
    avgRating: row.avg_rating == null ? null : Number(row.avg_rating),
    returnRate: row.return_rate == null ? null : Number(row.return_rate),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    weightGrams: row.weight_grams == null ? null : Number(row.weight_grams),
    variants: JSON.parse(String(row.variants ?? "[]")) as Array<{ name: string; values: string[] }>,
    firstSeenAt: String(row.first_seen_at),
    lastUpdatedAt: String(row.last_updated_at)
  };
}

function mapPostgresProduct(row: Record<string, unknown>): ProductRecord {
  return {
    id: String(row.id),
    supplierId: String(row.supplier_id),
    supplierSku: String(row.supplier_sku),
    title: String(row.title),
    description: String(row.description ?? ""),
    priceAmount: Number(row.price_amount ?? 0),
    supplierCost: Number(row.supplier_cost ?? 0),
    suggestedRetail: row.suggested_retail == null ? null : Number(row.suggested_retail),
    images: (row.images as string[]) ?? [],
    categories: (row.categories as string[]) ?? [],
    shippingMinDays: row.shipping_min_days == null ? null : Number(row.shipping_min_days),
    shippingMaxDays: row.shipping_max_days == null ? null : Number(row.shipping_max_days),
    shippingCost: Number(row.shipping_cost ?? 0),
    shippingCountries: (row.shipping_countries as string[]) ?? [],
    reviewCount: Number(row.review_count ?? 0),
    avgRating: row.avg_rating == null ? null : Number(row.avg_rating),
    returnRate: row.return_rate == null ? null : Number(row.return_rate),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    weightGrams: row.weight_grams == null ? null : Number(row.weight_grams),
    variants: (row.variants as Array<{ name: string; values: string[] }>) ?? [],
    firstSeenAt: String(row.first_seen_at),
    lastUpdatedAt: String(row.last_updated_at)
  };
}

export function createSqliteProductQueries(db: SqliteDatabase): ProductQueries {
  return {
    async listProducts(filters) {
      const offset = (filters.page - 1) * filters.pageSize;
      const where: string[] = [];
      const params: unknown[] = [];

      if (filters.supplierId) {
        where.push("supplier_id = ?");
        params.push(filters.supplierId);
      }

      if (filters.query) {
        where.push("(title LIKE ? OR description LIKE ?)");
        params.push(`%${filters.query}%`, `%${filters.query}%`);
      }

      if (filters.category) {
        where.push("categories LIKE ?");
        params.push(`%${filters.category}%`);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM products ${whereClause} ORDER BY last_updated_at DESC LIMIT ? OFFSET ?`
        )
        .all(...params, filters.pageSize, offset) as Array<Record<string, unknown>>;
      const total = db
        .prepare(`SELECT COUNT(*) AS count FROM products ${whereClause}`)
        .get(...params) as { count: number };

      return { items: rows.map(mapSqliteProduct), total: total.count };
    },

    async getProductById(id) {
      const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;

      return row ? mapSqliteProduct(row) : null;
    },

    async searchProducts(query, page, pageSize) {
      return this.listProducts({ page, pageSize, query });
    }
  };
}

export function createPostgresProductQueries(pool: Pool): ProductQueries {
  return {
    async listProducts(filters) {
      const offset = (filters.page - 1) * filters.pageSize;
      const values: unknown[] = [];
      const where: string[] = [];

      if (filters.supplierId) {
        values.push(filters.supplierId);
        where.push(`supplier_id = $${values.length}`);
      }

      if (filters.query) {
        values.push(`%${filters.query}%`);
        where.push(`(title ILIKE $${values.length} OR description ILIKE $${values.length})`);
      }

      if (filters.category) {
        values.push(filters.category);
        where.push(`$${values.length} = ANY(categories)`);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const listSql = `SELECT * FROM products ${whereClause} ORDER BY last_updated_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
      values.push(filters.pageSize, offset);

      const [itemsResult, countResult] = await Promise.all([
        pool.query(listSql, values),
        pool.query(`SELECT COUNT(*)::int AS count FROM products ${whereClause}`, values.slice(0, values.length - 2))
      ]);

      return {
        items: itemsResult.rows.map((row) => mapPostgresProduct(row as Record<string, unknown>)),
        total: countResult.rows[0]?.count ?? 0
      };
    },

    async getProductById(id) {
      const result = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapPostgresProduct(row) : null;
    },

    async searchProducts(query, page, pageSize) {
      return this.listProducts({ page, pageSize, query });
    }
  };
}
