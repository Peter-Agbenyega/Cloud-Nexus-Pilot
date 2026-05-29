import { createRequire } from "node:module";
import { FlatCompat } from "@eslint/eslintrc";

const require = createRequire(import.meta.url);

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  resolvePluginsRelativeTo: import.meta.dirname,
});

// Resolve the CJS config to an absolute path with explicit .js extension
// so Node ESM on Vercel doesn't strip it during module resolution.
const nextCoreWebVitals = require("eslint-config-next/core-web-vitals.js");

export default [
  ...compat.config(nextCoreWebVitals),
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
];
