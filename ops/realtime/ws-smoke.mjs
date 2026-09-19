import WebSocket from "ws";

const url = process.env.REALTIME_WS_URL ?? "wss://realtime.cloudnexuspilot.com/ws/session";
const token = process.env.REALTIME_SMOKE_JWT;
const origin = process.env.REALTIME_SMOKE_ORIGIN ?? "https://cloudnexuspilot.com";
if (!token) throw new Error("REALTIME_SMOKE_JWT is required");

const ws = new WebSocket(url, { origin });
const timeout = setTimeout(() => ws.terminate(), 15_000);
ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === "session.auth_required") {
    ws.send(JSON.stringify({ type: "session.authenticate", accessToken: token }));
  } else if (message.type === "session.ready") {
    clearTimeout(timeout);
    console.log("Authenticated WebSocket smoke check passed");
    ws.close(1000);
  } else if (message.type === "error") {
    throw new Error(`WebSocket smoke check failed: ${message.code ?? "unknown error"}`);
  }
});
ws.on("error", (error) => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
ws.on("close", () => { clearTimeout(timeout); if (process.exitCode) process.exit(process.exitCode); });
