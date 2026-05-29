export interface ProductV3 {
  id: string;
  supplierSku: string;
  supplierId: string;
  title: string;
  description: string;
  price: {
    amount: number;
    currency: "USD";
    supplierCost: number;
    suggestedRetail: number | null;
  };
  images: string[];
  categories: string[];
  shipping: {
    minDays: number;
    maxDays: number;
    cost: number;
    countries: string[];
  };
  qualitySignals: {
    reviewCount: number;
    avgRating: number | null;
    returnRate: number | null;
    supplierReliability: number;
  };
  metadata: {
    sourceUrl: string | null;
    weight: number | null;
    dimensions: { l: number; w: number; h: number } | null;
    variants: Array<{ name: string; values: string[] }>;
  };
  timestamps: {
    firstSeen: string;
    lastUpdated: string;
    lastEnriched: string | null;
  };
}
