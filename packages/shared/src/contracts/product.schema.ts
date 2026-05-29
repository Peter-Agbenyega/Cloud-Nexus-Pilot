import { z } from "zod";

export const ProductV3Schema = z.object({
  id: z.string().uuid(),
  supplierSku: z.string().min(1),
  supplierId: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(10000),
  price: z.object({
    amount: z.number().positive(),
    currency: z.literal("USD"),
    supplierCost: z.number().nonnegative(),
    suggestedRetail: z.number().positive().nullable()
  }),
  images: z.array(z.string().url()).min(1),
  categories: z.array(z.string()).min(1),
  shipping: z.object({
    minDays: z.number().int().nonnegative(),
    maxDays: z.number().int().positive(),
    cost: z.number().nonnegative(),
    countries: z.array(z.string().length(2))
  }),
  qualitySignals: z.object({
    reviewCount: z.number().int().nonnegative(),
    avgRating: z.number().min(1).max(5).nullable(),
    returnRate: z.number().min(0).max(1).nullable(),
    supplierReliability: z.number().min(0).max(100)
  }),
  metadata: z.object({
    sourceUrl: z.string().url().nullable(),
    weight: z.number().positive().nullable(),
    dimensions: z
      .object({
        l: z.number().positive(),
        w: z.number().positive(),
        h: z.number().positive()
      })
      .nullable(),
    variants: z.array(
      z.object({
        name: z.string(),
        values: z.array(z.string())
      })
    )
  }),
  timestamps: z.object({
    firstSeen: z.string().datetime(),
    lastUpdated: z.string().datetime(),
    lastEnriched: z.string().datetime().nullable()
  })
});

export const ProductListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  supplierId: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  q: z.string().min(1).optional()
});

export const ProductSearchQuerySchema = z.object({
  q: z.string().min(1),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20)
});
