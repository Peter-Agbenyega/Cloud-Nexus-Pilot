import js from "@eslint/js";
import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

// Scope every preset to service TypeScript, including its tests. Generated
// JavaScript stays outside this gate; strict tsc remains a separate CI check.
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  { ...js.configs.recommended, files: ["src/**/*.ts"] },
  ...typescriptPlugin.configs["flat/recommended"].map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  },
];
