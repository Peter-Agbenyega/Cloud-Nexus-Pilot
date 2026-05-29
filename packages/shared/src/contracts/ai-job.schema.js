import { z } from "zod";
export const AIJobTypeSchema = z.enum([
    "niche-analysis",
    "description-rewrite",
    "seo-generation",
    "embedding-generate",
    "score-calculate",
    "supplier-compare"
]);
export const AIJobSchema = z.object({
    id: z.string().uuid(),
    type: AIJobTypeSchema,
    productId: z.string().uuid(),
    payload: z.record(z.unknown()),
    priority: z.enum(["high", "normal", "low"]),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive().default(3),
    createdAt: z.string().datetime()
});
//# sourceMappingURL=ai-job.schema.js.map