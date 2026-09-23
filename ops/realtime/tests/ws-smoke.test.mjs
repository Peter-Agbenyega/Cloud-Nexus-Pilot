import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { runSmoke } from "../ws-smoke.mjs";

async function server(t, onConnection) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  wss.on("connection", onConnection);
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
  });
  return `ws://127.0.0.1:${wss.address().port}`;
}
const options = { token: "synthetic-test-token", origin: "https://example.invalid", timeoutMs: 150 };

test("requires session.ready after sending authentication", async t => {
  let authenticated = false;
  const url = await server(t, ws => {
    ws.send(JSON.stringify({ type: "session.auth_required" }));
    ws.on("message", data => {
      authenticated = JSON.parse(data).accessToken === options.token;
      ws.send(JSON.stringify({ type: "session.ready" }));
    });
  });
  await runSmoke({ ...options, url }); assert.equal(authenticated, true);
});
for (const [name, behavior, message] of [
  ["silent timeout", () => {}, /Timed out/],
  ["premature close", ws => ws.close(), /closed before/],
  ["malformed JSON", ws => ws.send("{broken"), /Invalid JSON/],
  ["null JSON", ws => ws.send("null"), /Invalid message/],
  ["authentication rejection", ws => ws.send(JSON.stringify({ type: "error", code: options.token })), /Server rejected/],
  ["unsolicited readiness", ws => ws.send(JSON.stringify({ type: "session.ready" })), /before authentication/],
]) {
  test(`fails on ${name}`, async t => {
    const url = await server(t, behavior);
    await assert.rejects(runSmoke({ ...options, url }), message);
  });
}
test("CLI exits nonzero on premature close without printing credentials", async t => {
  const url = await server(t, ws => ws.close());
  const child = spawn(process.execPath, ["ops/realtime/ws-smoke.mjs"], { env: { ...process.env, REALTIME_WS_URL: url, REALTIME_SMOKE_JWT: options.token } });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const [code] = await once(child, "close");
  assert.equal(code, 1); assert.match(output, /closed before session.ready/);
  assert.ok(!output.includes(options.token)); assert.ok(!output.includes("passed"));
});
test("missing JWT fails before opening a connection", async () => {
  await assert.rejects(runSmoke({ url: "ws://127.0.0.1:1", token: "" }), /required/);
});
