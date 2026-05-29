import type { ProductV3 } from "./product.js";

export interface EnrichedProduct extends ProductV3 {
  discoveryScore: number;
  scoreBreakdown: {
    margin: number;
    trend: number;
    competition: number;
    shipping: number;
    quality: number;
  };
  aiDescription: string | null;
  nicheAnalysis: string | null;
  seoKeywords: string[];
  embedding: number[] | null;
  supplierComparisons: SupplierComparison[];
  enrichmentStatus: "pending" | "partial" | "complete" | "failed";
}

export interface SupplierComparison {
  supplierId: string;
  supplierName: string;
  price: number;
  shippingDays: number;
  shippingCost: number;
  reliabilityScore: number;
  isPreferred: boolean;
}
