import { z } from "zod";
export declare const ProductV3Schema: z.ZodObject<{
    id: z.ZodString;
    supplierSku: z.ZodString;
    supplierId: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    price: z.ZodObject<{
        amount: z.ZodNumber;
        currency: z.ZodLiteral<"USD">;
        supplierCost: z.ZodNumber;
        suggestedRetail: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        amount: number;
        currency: "USD";
        supplierCost: number;
        suggestedRetail: number | null;
    }, {
        amount: number;
        currency: "USD";
        supplierCost: number;
        suggestedRetail: number | null;
    }>;
    images: z.ZodArray<z.ZodString, "many">;
    categories: z.ZodArray<z.ZodString, "many">;
    shipping: z.ZodObject<{
        minDays: z.ZodNumber;
        maxDays: z.ZodNumber;
        cost: z.ZodNumber;
        countries: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        minDays: number;
        maxDays: number;
        cost: number;
        countries: string[];
    }, {
        minDays: number;
        maxDays: number;
        cost: number;
        countries: string[];
    }>;
    qualitySignals: z.ZodObject<{
        reviewCount: z.ZodNumber;
        avgRating: z.ZodNullable<z.ZodNumber>;
        returnRate: z.ZodNullable<z.ZodNumber>;
        supplierReliability: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        reviewCount: number;
        avgRating: number | null;
        returnRate: number | null;
        supplierReliability: number;
    }, {
        reviewCount: number;
        avgRating: number | null;
        returnRate: number | null;
        supplierReliability: number;
    }>;
    metadata: z.ZodObject<{
        sourceUrl: z.ZodNullable<z.ZodString>;
        weight: z.ZodNullable<z.ZodNumber>;
        dimensions: z.ZodNullable<z.ZodObject<{
            l: z.ZodNumber;
            w: z.ZodNumber;
            h: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            l: number;
            w: number;
            h: number;
        }, {
            l: number;
            w: number;
            h: number;
        }>>;
        variants: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            values: z.ZodArray<z.ZodString, "many">;
        }, "strip", z.ZodTypeAny, {
            values: string[];
            name: string;
        }, {
            values: string[];
            name: string;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        variants: {
            values: string[];
            name: string;
        }[];
        sourceUrl: string | null;
        weight: number | null;
        dimensions: {
            l: number;
            w: number;
            h: number;
        } | null;
    }, {
        variants: {
            values: string[];
            name: string;
        }[];
        sourceUrl: string | null;
        weight: number | null;
        dimensions: {
            l: number;
            w: number;
            h: number;
        } | null;
    }>;
    timestamps: z.ZodObject<{
        firstSeen: z.ZodString;
        lastUpdated: z.ZodString;
        lastEnriched: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        firstSeen: string;
        lastUpdated: string;
        lastEnriched: string | null;
    }, {
        firstSeen: string;
        lastUpdated: string;
        lastEnriched: string | null;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    title: string;
    description: string;
    images: string[];
    categories: string[];
    supplierSku: string;
    supplierId: string;
    price: {
        amount: number;
        currency: "USD";
        supplierCost: number;
        suggestedRetail: number | null;
    };
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
        variants: {
            values: string[];
            name: string;
        }[];
        sourceUrl: string | null;
        weight: number | null;
        dimensions: {
            l: number;
            w: number;
            h: number;
        } | null;
    };
    timestamps: {
        firstSeen: string;
        lastUpdated: string;
        lastEnriched: string | null;
    };
}, {
    id: string;
    title: string;
    description: string;
    images: string[];
    categories: string[];
    supplierSku: string;
    supplierId: string;
    price: {
        amount: number;
        currency: "USD";
        supplierCost: number;
        suggestedRetail: number | null;
    };
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
        variants: {
            values: string[];
            name: string;
        }[];
        sourceUrl: string | null;
        weight: number | null;
        dimensions: {
            l: number;
            w: number;
            h: number;
        } | null;
    };
    timestamps: {
        firstSeen: string;
        lastUpdated: string;
        lastEnriched: string | null;
    };
}>;
export declare const ProductListQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    pageSize: z.ZodDefault<z.ZodNumber>;
    supplierId: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    q: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    page: number;
    pageSize: number;
    supplierId?: string | undefined;
    category?: string | undefined;
    q?: string | undefined;
}, {
    supplierId?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
    category?: string | undefined;
    q?: string | undefined;
}>;
export declare const ProductSearchQuerySchema: z.ZodObject<{
    q: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    pageSize: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    page: number;
    pageSize: number;
    q: string;
}, {
    q: string;
    page?: number | undefined;
    pageSize?: number | undefined;
}>;
//# sourceMappingURL=product.schema.d.ts.map