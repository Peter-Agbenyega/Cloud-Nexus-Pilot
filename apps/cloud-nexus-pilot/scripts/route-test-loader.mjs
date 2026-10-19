import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const requireDependency = createRequire(new URL("../package.json", import.meta.url));

// Execute the actual route source with per-test dependency doubles. No provider
// requests, Next request context or production credentials are needed.
export function sourceLoader(mocks = {}, globals = {}) {
  const cache = new Map();
  function load(specifier, parent = appRoot) {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
      return requireDependency(specifier);
    }
    let path = specifier.startsWith("@/")
      ? resolve(appRoot, specifier.slice(2))
      : resolve(parent, specifier);
    if (!existsSync(path)) path += ".ts";
    if (cache.has(path)) return cache.get(path).exports;
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const loadedModule = { exports: {} };
    cache.set(path, loadedModule);
    const run = new Function("require", "module", "exports", "process", "console", "fetch", compiled.outputText);
    run((name) => load(name, dirname(path)), loadedModule, loadedModule.exports,
      globals.process ?? process, globals.console ?? console, globals.fetch ?? globalThis.fetch);
    return loadedModule.exports;
  }
  return (specifier) => load(specifier);
}

export function routeLoader(mocks = {}, globals = {}) {
  const load = sourceLoader(mocks, globals);
  return (route) => load(`@/app/api/${route}/route`);
}
