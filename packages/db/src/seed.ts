import crypto from "node:crypto";
import { getSqliteClient, resolveDbConfig } from "./client.js";

function runSqliteSeed(sqliteFile: string): void {
  const db = getSqliteClient(sqliteFile);

  const supplierInsert = db.prepare(
    `INSERT OR IGNORE INTO suppliers (id, name, api_base_url, is_active, reliability_score)
     VALUES (@id, @name, @apiBaseUrl, @isActive, @reliabilityScore)`
  );

  supplierInsert.run({
    id: "cj",
    name: "CJ Dropshipping",
    apiBaseUrl: "https://developers.cjdropshipping.com/api2.0",
    isActive: 1,
    reliabilityScore: 70
  });

  const now = new Date().toISOString();

  const productInsert = db.prepare(
    `INSERT OR REPLACE INTO products (
      id, supplier_id, supplier_sku, title, description, price_amount, supplier_cost,
      suggested_retail, images, categories, shipping_min_days, shipping_max_days,
      shipping_cost, shipping_countries, review_count, avg_rating, return_rate,
      source_url, weight_grams, variants, first_seen_at, last_updated_at
    ) VALUES (
      @id, @supplierId, @supplierSku, @title, @description, @priceAmount, @supplierCost,
      @suggestedRetail, @images, @categories, @shippingMinDays, @shippingMaxDays,
      @shippingCost, @shippingCountries, @reviewCount, @avgRating, @returnRate,
      @sourceUrl, @weightGrams, @variants, @firstSeenAt, @lastUpdatedAt
    )`
  );

  const products = [
    {
      id: crypto.randomUUID(),
      supplierId: "cj",
      supplierSku: "CJ-EMPIRE-001",
      title: "Portable Laptop Stand",
      description: "Foldable aluminum laptop stand for remote workers.",
      priceAmount: 24.99,
      supplierCost: 9.8,
      suggestedRetail: 39.99,
      images: JSON.stringify(["https://example.com/images/laptop-stand.jpg"]),
      categories: JSON.stringify(["office", "productivity"]),
      shippingMinDays: 5,
      shippingMaxDays: 10,
      shippingCost: 4.5,
      shippingCountries: JSON.stringify(["US", "CA"]),
      reviewCount: 120,
      avgRating: 4.5,
      returnRate: 0.04,
      sourceUrl: "https://example.com/cj/laptop-stand",
      weightGrams: 850,
      variants: JSON.stringify([{ name: "Color", values: ["Silver", "Black"] }]),
      firstSeenAt: now,
      lastUpdatedAt: now
    },
    {
      id: crypto.randomUUID(),
      supplierId: "cj",
      supplierSku: "CJ-EMPIRE-002",
      title: "Smart LED Desk Lamp",
      description: "USB-powered adjustable desk lamp with touch controls.",
      priceAmount: 29.5,
      supplierCost: 12.25,
      suggestedRetail: 44.99,
      images: JSON.stringify(["https://example.com/images/desk-lamp.jpg"]),
      categories: JSON.stringify(["home", "office"]),
      shippingMinDays: 6,
      shippingMaxDays: 12,
      shippingCost: 5.75,
      shippingCountries: JSON.stringify(["US"]),
      reviewCount: 84,
      avgRating: 4.3,
      returnRate: 0.05,
      sourceUrl: "https://example.com/cj/desk-lamp",
      weightGrams: 1200,
      variants: JSON.stringify([{ name: "Plug", values: ["US"] }]),
      firstSeenAt: now,
      lastUpdatedAt: now
    }
  ];

  for (const product of products) {
    productInsert.run(product);
  }

  db.close();
  console.log(`[db:seed] seeded ${products.length} products for supplier cj into ${sqliteFile}`);
}

async function run(): Promise<void> {
  const config = resolveDbConfig();

  if (config.provider !== "sqlite") {
    console.log("[db:seed] postgres seeding is intentionally skipped in Phase 1");
    return;
  }

  if (!config.sqliteFile) {
    throw new Error("SQLITE_FILE is required for sqlite seeding");
  }

  runSqliteSeed(config.sqliteFile);
}

run().catch((error) => {
  console.error("[db:seed] failed", error);
  process.exit(1);
});
