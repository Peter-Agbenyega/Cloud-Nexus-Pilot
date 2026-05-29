# CloudNexus API (Phase 1 Foundation)

This service is the Phase 1 backend foundation for the ecommerce discovery architecture.

## Included in Phase 1

- Fastify API scaffold
- `GET /health`
- Auth middleware scaffold (`AUTH_MODE=mock` for local)
- Product endpoints scaffold:
  - `GET /api/products`
  - `GET /api/products/:id`
  - `GET /api/products/search`
- Local-safe queue adapter scaffold (in-memory)

## Local run

From repo root:

```bash
npm install
npm run dev
```

This will:
1. Build DB package
2. Run SQLite migrations
3. Seed CJ sample products
4. Build and start API on port `10000`

## Notes

- Semantic search is intentionally scaffold-only in Phase 1.
- Real JWT verification against Supabase is scaffolded and deferred.
- AI providers are not called in Phase 1; missing keys are treated as mock mode.
