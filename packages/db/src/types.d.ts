export type DatabaseProvider = "postgres" | "sqlite";
export interface DbConfig {
    provider: DatabaseProvider;
    postgresUrl?: string;
    sqliteFile?: string;
}
export interface ProductListFilters {
    page: number;
    pageSize: number;
    supplierId?: string;
    category?: string;
    query?: string;
}
export interface ProductRecord {
    id: string;
    supplierId: string;
    supplierSku: string;
    title: string;
    description: string;
    priceAmount: number;
    supplierCost: number;
    suggestedRetail: number | null;
    images: string[];
    categories: string[];
    shippingMinDays: number | null;
    shippingMaxDays: number | null;
    shippingCost: number;
    shippingCountries: string[];
    reviewCount: number;
    avgRating: number | null;
    returnRate: number | null;
    sourceUrl: string | null;
    weightGrams: number | null;
    variants: Array<{
        name: string;
        values: string[];
    }>;
    firstSeenAt: string;
    lastUpdatedAt: string;
}
//# sourceMappingURL=types.d.ts.map