export * from "./types.js";
export { closeDbClients, resolveDbConfig } from "./client.js";
export declare function createDb(): {
    provider: "postgres";
    products: import("./queries/products.js").ProductQueries;
} | {
    provider: "sqlite";
    products: import("./queries/products.js").ProductQueries;
};
//# sourceMappingURL=index.d.ts.map