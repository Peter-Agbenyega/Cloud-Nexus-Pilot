export * from "./constants.js";
export { buildAiJobDedupKey } from "./queue.js";

export type { ProductV3 } from "./types/product.js";
export type { EnrichedProduct, SupplierComparison } from "./types/enriched-product.js";
export type { AIJob, AIJobResult, AIJobType } from "./types/ai-job.js";

export {
  ProductListQuerySchema,
  ProductSearchQuerySchema,
  ProductV3Schema
} from "./contracts/product.schema.js";
export { AIJobSchema, AIJobTypeSchema } from "./contracts/ai-job.schema.js";
