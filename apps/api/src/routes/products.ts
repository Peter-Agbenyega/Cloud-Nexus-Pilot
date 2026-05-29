import { createDb } from "@cloudnexus/db";
import { ProductListQuerySchema, ProductSearchQuerySchema } from "@cloudnexus/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";

const ProductDetailParamSchema = z.object({
  id: z.string().min(1)
});

export const productsRoutes: FastifyPluginAsync = async (app) => {
  const db = createDb();

  app.get("/api/products", { preHandler: requireAuth }, async (request, reply) => {
    const queryResult = ProductListQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      reply.status(400).send({
        error: "invalid_query",
        details: queryResult.error.flatten()
      });
      return;
    }

    const query = queryResult.data;
    const result = await db.products.listProducts({
      page: query.page,
      pageSize: query.pageSize,
      supplierId: query.supplierId,
      category: query.category,
      query: query.q
    });

    reply.send({
      items: result.items,
      page: query.page,
      pageSize: query.pageSize,
      total: result.total
    });
  });

  app.get("/api/products/search", { preHandler: requireAuth }, async (request, reply) => {
    const queryResult = ProductSearchQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      reply.status(400).send({
        error: "invalid_query",
        details: queryResult.error.flatten()
      });
      return;
    }

    const query = queryResult.data;

    // Phase 1 scaffold: semantic vector search will be added in Phase 3.
    const result = await db.products.searchProducts(query.q, query.page, query.pageSize);

    reply.send({
      items: result.items,
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
      mode: "keyword-scaffold"
    });
  });

  app.get("/api/products/:id", { preHandler: requireAuth }, async (request, reply) => {
    const paramsResult = ProductDetailParamSchema.safeParse(request.params);
    if (!paramsResult.success) {
      reply.status(400).send({ error: "invalid_params", details: paramsResult.error.flatten() });
      return;
    }

    const product = await db.products.getProductById(paramsResult.data.id);
    if (!product) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    reply.send({
      item: product,
      enrichment: null,
      comparisons: []
    });
  });
};
