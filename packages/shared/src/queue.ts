import type { AIJobType } from "./types/ai-job.js";

export function buildAiJobDedupKey(productId: string, jobType: AIJobType, windowDate = new Date()): string {
  const dayBucket = windowDate.toISOString().slice(0, 10);
  return `${productId}:${jobType}:${dayBucket}`;
}
