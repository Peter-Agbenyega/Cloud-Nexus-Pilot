#!/usr/bin/env node
// Explicit opt-in; no startup, recording, or provider requests occur on import.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLiveProfile } from "./live-profile.mjs";
const mode = process.argv[2];
if (!["build", "start", "check"].includes(mode)) throw new Error("Use live-local.mjs build, check, or start.");
const privateRoot = resolve(homedir(), ".local/share/cloud-nexus-pilot/recovery-test");
function load(name) {
  const file = resolve(privateRoot, name);
  if (statSync(file).mode & 0o077) throw new Error("Pilot private configuration must have mode 0600.");
  return parseEnv(readFileSync(file, "utf8"));
}
const env = { ...process.env, ...load("pilot.env"), ...load("live-provider.env"),
  PILOT_LIVE_ACCEPTANCE: "1", NEXT_PUBLIC_PILOT_LIVE_ACCEPTANCE: "1",
  NEXT_PUBLIC_PILOT_TEST_FIXTURE: "0", NEXT_PUBLIC_PILOT_ALLOW_LOOPBACK: "1",
  PILOT_RECOVERY_STACK: "1", PILOT_LOCAL_FRONTEND_PORT: "43102",
  PILOT_LOCAL_REALTIME_PORT: "43311", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:43102",
  NEXT_PUBLIC_PILOT_REALTIME_WS_URL: "ws://127.0.0.1:43311/ws/session",
  PILOT_PUBLIC_ORIGIN: "http://127.0.0.1:43102", PILOT_JOURNEY_URL: "http://127.0.0.1:43102" };
if (mode === "build") env.OPENAI_API_KEY = ""; // Never expose the live provider key to the build.
validateLiveProfile(env, mode === "check" ? "start" : mode);
if (mode === "check") {
  console.log("Live profile configuration passes; provider authentication and allowance remain unverified.");
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./local.mjs", import.meta.url)), mode],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, stdio: "inherit" });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.once("SIGINT", () => child.kill("SIGINT"));
  child.once("error", () => { console.error("Live launcher failed."); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}
