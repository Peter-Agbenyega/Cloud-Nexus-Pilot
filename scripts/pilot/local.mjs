#!/usr/bin/env node
// Scoped local launcher: no database setup, migration, seed, or remote mutation.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const pilot = resolve(root, "apps/cloud-nexus-pilot");
const realtime = resolve(root, "apps/pilot-realtime-api");
const requirePilot = createRequire(resolve(pilot, "package.json"));
const requireRealtime = createRequire(resolve(realtime, "package.json"));
const mode = process.argv[2] ?? "start";
if (!["build", "start"].includes(mode)) throw new Error("Use local.mjs build or start.");
if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Select the verified Node22 runtime before starting.");
const local = (value) => {
  try { const u = new URL(value); return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); } catch { return false; }
};
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "PILOT_DATA_API_URL", "OPENAI_BASE_URL"]) {
  if (process.env[name] && !local(process.env[name])) throw new Error(`This isolated launcher requires a loopback ${name}. Use the reviewed hosted runbook for other targets.`);
}
if (mode === "start" && (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY)) throw new Error("Realtime requires configured compatible identity. No authentication bypass is enabled.");
if (process.env.DEEPGRAM_API_KEY || (process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL)) throw new Error("This isolated launcher requires a loopback provider fixture or no provider credentials.");
if (process.env.OPENAI_API_KEY && process.env.NEXT_PUBLIC_PILOT_TEST_FIXTURE !== "1") throw new Error("Local fixture runs must display their synthetic test banner.");
const logDir = mode === "start" ? mkdtempSync(join(tmpdir(), "pilot-runtime-")) : null;
if (logDir) console.log(`Scoped process logs: ${logDir}`);
const children = new Set();
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 5000);
  timer.unref();
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
function run(args, cwd, extra = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: mode === "start" ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...extra } });
    children.add(child);
    const log = logDir ? createWriteStream(join(logDir, `${cwd === pilot ? "frontend" : "realtime"}-${child.pid}.log`), { mode: 0o600 }) : null;
    child.stdout?.on("data", (chunk) => { process.stdout.write(chunk); log?.write(chunk); });
    child.stderr?.on("data", (chunk) => { process.stderr.write(chunk); log?.write(chunk); });
    child.once("exit", () => log?.end());
    child.once("error", reject);
    child.once("exit", (code, signal) => { children.delete(child); if (code === 0 || stopping) resolveRun(); else reject(new Error(`Scoped process failed: ${code ?? signal}`)); });
  });
}
try {
  if (mode === "build") {
    await run([requirePilot.resolve("next/dist/bin/next"), "build"], pilot, { NODE_ENV: "production" });
    await run([requireRealtime.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], realtime);
  } else {
    if (!existsSync(resolve(pilot, ".next/BUILD_ID")) || !existsSync(resolve(realtime, "dist/server.js"))) throw new Error("Run the scoped build first.");
    const frontPort = process.env.PILOT_LOCAL_FRONTEND_PORT || "3100";
    const apiPort = process.env.PILOT_LOCAL_REALTIME_PORT || "3310";
    for (const port of [frontPort, apiPort]) if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("Invalid local port.");
    console.log(`Pilot http://127.0.0.1:${frontPort}; realtime http://127.0.0.1:${apiPort}. Ctrl-C stops both owned processes.`);
    await Promise.all([
      run([requirePilot.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", frontPort], pilot, { NODE_ENV: "production" }),
      run([resolve(realtime, "dist/server.js")], realtime, { HOST: "127.0.0.1", PORT: apiPort, CORS_ORIGIN: `http://127.0.0.1:${frontPort}`, NODE_ENV: "test" }),
    ]);
  }
} catch (error) { console.error(error.message); stop(); process.exitCode = 1; }
