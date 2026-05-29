import { defineConfig, globalIgnores } from "eslint/config";
import { FlatCompat } from "@eslint/eslintrc";
import nextVitals from "eslint-config-next/core-web-vitals.js";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const nextVitalsConfig = Array.isArray(nextVitals)
  ? nextVitals
  : compat.config(nextVitals);

export default defineConfig([
  ...nextVitalsConfig,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);
