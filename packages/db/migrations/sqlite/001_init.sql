CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_base_url TEXT,
  is_active INTEGER DEFAULT 1,
  reliability_score REAL DEFAULT 50.0,
  last_sync_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  supplier_sku TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_amount REAL NOT NULL,
  supplier_cost REAL NOT NULL,
  suggested_retail REAL,
  images TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  shipping_min_days INTEGER,
  shipping_max_days INTEGER,
  shipping_cost REAL DEFAULT 0,
  shipping_countries TEXT NOT NULL DEFAULT '["US"]',
  review_count INTEGER DEFAULT 0,
  avg_rating REAL,
  return_rate REAL,
  source_url TEXT,
  weight_grams REAL,
  variants TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, supplier_sku)
);

CREATE TABLE IF NOT EXISTS product_enrichments (
  product_id TEXT PRIMARY KEY,
  discovery_score REAL,
  score_margin REAL,
  score_trend REAL,
  score_competition REAL,
  score_shipping REAL,
  score_quality REAL,
  ai_description TEXT,
  niche_analysis TEXT,
  seo_keywords TEXT NOT NULL DEFAULT '[]',
  embedding TEXT,
  enrichment_status TEXT DEFAULT 'pending',
  enriched_at TEXT,
  model_used TEXT,
  enrichment_cost_usd REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_job_log (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  product_id TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_job_log_created ON ai_job_log(created_at DESC);
