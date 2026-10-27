import assert from "node:assert/strict";
import { createRequire } from "node:module";

const pilot = createRequire(new URL("../apps/cloud-nexus-pilot/package.json", import.meta.url));
const realtime = createRequire(new URL("../apps/pilot-realtime-api/package.json", import.meta.url));
const next = createRequire(pilot.resolve("next/package.json"));
const versions = {
  next: pilot("next/package.json").version,
  nextPostcss: next("postcss/package.json").version,
  pilotEslint: pilot("eslint/package.json").version,
  realtimeEslint: realtime("eslint/package.json").version,
  fastify: realtime("fastify/package.json").version,
  zod: realtime("zod/package.json").version,
};
assert.deepEqual(versions, {
  next: "15.5.28",
  nextPostcss: "8.5.32",
  pilotEslint: "10.13.0",
  realtimeEslint: "10.13.0",
  fastify: "5.12.7",
  zod: "4.6.7",
}, "Pilot dependency contract changed: review advisories and regenerate/validate the lockfile before updating this gate.");
console.log("Pilot installed dependency contract verified", versions);
