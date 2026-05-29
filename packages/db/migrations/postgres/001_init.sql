CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_base_url TEXT,
  is_active BOOLEAN DEFAULT true,
  reliability_score NUMERIC(5,2) DEFAULT 50.0,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  supplier_sku TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_amount NUMERIC(10,2) NOT NULL,
  supplier_cost NUMERIC(10,2) NOT NULL,
  suggested_retail NUMERIC(10,2),
  images TEXT[] NOT NULL DEFAULT '{}',
  categories TEXT[] NOT NULL DEFAULT '{}',
  shipping_min_days INT,
  shipping_max_days INT,
  shipping_cost NUMERIC(10,2) DEFAULT 0,
  shipping_countries TEXT[] DEFAULT '{US}',
  review_count INT DEFAULT 0,
  avg_rating NUMERIC(3,2),
  return_rate NUMERIC(5,4),
  source_url TEXT,
  weight_grams NUMERIC(10,2),
  variants JSONB DEFAULT '[]',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(supplier_id, supplier_sku)
);

CREATE TABLE IF NOT EXISTS product_enrichments (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  discovery_score NUMERIC(5,2),
  score_margin NUMERIC(5,2),
  score_trend NUMERIC(5,2),
  score_competition NUMERIC(5,2),
  score_shipping NUMERIC(5,2),
  score_quality NUMERIC(5,2),
  ai_description TEXT,
  niche_analysis TEXT,
  seo_keywords TEXT[] DEFAULT '{}',
  embedding vector(1536),
  enrichment_status TEXT DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'partial', 'complete', 'failed')),
  enriched_at TIMESTAMPTZ,
  model_used TEXT,
  enrichment_cost_usd NUMERIC(8,6) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_job_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_type TEXT NOT NULL,
  product_id UUID REFERENCES products(id),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'fallback', 'deferred')),
  tokens_used INT DEFAULT 0,
  cost_usd NUMERIC(8,6) DEFAULT 0,
  duration_ms INT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_categories ON products USING GIN(categories);
CREATE INDEX IF NOT EXISTS idx_ai_job_log_created ON ai_job_log(created_at DESC);
