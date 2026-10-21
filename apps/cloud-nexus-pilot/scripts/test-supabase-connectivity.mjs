import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/supabase-connectivity.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { probeSupabaseConnectivity } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`
);
const origin = "https://configured-project.supabase.co";
const failWith = (error) => async () => { throw error; };

test("missing or invalid configuration does not issue a request", async () => {
  let requests = 0;
  const request = async () => { requests += 1; return new Response(); };
  for (const url of ["", "not a URL"]) {
    const result = await probeSupabaseConnectivity(url, request);
    assert.equal(result.reachable, false);
    assert.equal(result.status, null);
    assert.equal(result.latencyMs, 0);
  }
  assert.equal(requests, 0);
});

test("health probe uses only a credential-free GET and preserves HTTP success", async () => {
  const result = await probeSupabaseConnectivity(`${origin}/`, async (url, init) => {
    assert.equal(url, `${origin}/auth/v1/health`);
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(null, { status: 200 });
  });
  assert.equal(result.reachable, true);
  assert.equal(result.status, 200);
  assert.equal(result.error, "");
  assert.ok(result.latencyMs >= 0);
});

for (const status of [401, 503]) {
  test(`HTTP ${status} remains an HTTP failure, never a DNS claim`, async () => {
    const result = await probeSupabaseConnectivity(origin, async () => new Response(null, { status }));
    assert.equal(result.reachable, false);
    assert.equal(result.status, status);
    assert.equal(result.error, `HTTP ${status}`);
  });
}

for (const error of [new TypeError("Failed to fetch"), new TypeError("fetch failed"), "opaque failure"]) {
  test(`generic failure ${String(error)} keeps the cause unknown`, async () => {
    const result = await probeSupabaseConnectivity(origin, failWith(error));
    assert.equal(result.reachable, false);
    assert.equal(result.status, null);
    assert.match(result.error, /No HTTP response/);
    assert.match(result.error, /project status is unverified/);
    assert.doesNotMatch(result.error, /DNS lookup failed|paused|deleted/);
  });
}

for (const error of [
  Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }),
  new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
  new Error("net::ERR_NAME_NOT_RESOLVED"),
  Object.assign(new Error("temporary lookup failure"), { code: "EAI_AGAIN" }),
]) {
  test(`specific DNS evidence ${String(error)} identifies only lookup failure`, async () => {
    const result = await probeSupabaseConnectivity(origin, failWith(error));
    assert.equal(result.status, null);
    assert.match(result.error, /DNS lookup failed/);
    assert.match(result.error, /Project status is unverified/);
    assert.doesNotMatch(result.error, /paused|deleted/);
  });
}

for (const [name, expected] of [["TimeoutError", /timed out/], ["AbortError", /was canceled/]]) {
  test(`${name} is reported separately from DNS`, async () => {
    const result = await probeSupabaseConnectivity(origin, failWith(new DOMException("request ended", name)));
    assert.match(result.error, expected);
    assert.doesNotMatch(result.error, /DNS lookup failed|paused|deleted/);
  });
}
