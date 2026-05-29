export type AIJobType = "niche-analysis" | "description-rewrite" | "seo-generation" | "embedding-generate" | "score-calculate" | "supplier-compare";
export interface AIJob {
    id: string;
    type: AIJobType;
    productId: string;
    payload: Record<string, unknown>;
    priority: "high" | "normal" | "low";
    attempts: number;
    maxAttempts: 3;
    createdAt: string;
}
export interface AIJobResult {
    jobId: string;
    productId: string;
    type: AIJobType;
    status: "success" | "failed" | "fallback" | "deferred";
    result: Record<string, unknown>;
    model: string;
    tokensUsed: number;
    costUsd: number;
    durationMs: number;
}
//# sourceMappingURL=ai-job.d.ts.map