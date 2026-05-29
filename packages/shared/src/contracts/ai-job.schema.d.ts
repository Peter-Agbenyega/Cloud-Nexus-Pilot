import { z } from "zod";
export declare const AIJobTypeSchema: z.ZodEnum<["niche-analysis", "description-rewrite", "seo-generation", "embedding-generate", "score-calculate", "supplier-compare"]>;
export declare const AIJobSchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodEnum<["niche-analysis", "description-rewrite", "seo-generation", "embedding-generate", "score-calculate", "supplier-compare"]>;
    productId: z.ZodString;
    payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    priority: z.ZodEnum<["high", "normal", "low"]>;
    attempts: z.ZodNumber;
    maxAttempts: z.ZodDefault<z.ZodNumber>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "niche-analysis" | "description-rewrite" | "seo-generation" | "embedding-generate" | "score-calculate" | "supplier-compare";
    productId: string;
    payload: Record<string, unknown>;
    priority: "high" | "normal" | "low";
    attempts: number;
    maxAttempts: number;
    createdAt: string;
}, {
    id: string;
    type: "niche-analysis" | "description-rewrite" | "seo-generation" | "embedding-generate" | "score-calculate" | "supplier-compare";
    productId: string;
    payload: Record<string, unknown>;
    priority: "high" | "normal" | "low";
    attempts: number;
    createdAt: string;
    maxAttempts?: number | undefined;
}>;
//# sourceMappingURL=ai-job.schema.d.ts.map