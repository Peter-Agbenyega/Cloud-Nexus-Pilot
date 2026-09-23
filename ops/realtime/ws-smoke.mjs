import { pathToFileURL } from "node:url";
import WebSocket from "ws";

export function runSmoke({ url, token, origin, timeoutMs = 15_000 }) {
  if (!token) return Promise.reject(new Error("REALTIME_SMOKE_JWT is required"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    let settled = false;
    let authenticated = false;
    let closeTimeout;
    const timeout = setTimeout(() => fail("Timed out before session.ready"), timeoutMs);
    function fail(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.terminate();
      reject(new Error(reason));
    }
    ws.on("message", (data) => {
      if (settled) return;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { fail("Invalid JSON received before session.ready"); return; }
      if (!message || typeof message !== "object") {
        fail("Invalid message received before session.ready");
      } else if (message.type === "session.auth_required") {
        authenticated = true;
        ws.send(JSON.stringify({ type: "session.authenticate", accessToken: token }));
      } else if (message.type === "session.ready") {
        if (!authenticated) { fail("Readiness received before authentication"); return; }
        settled = true;
        clearTimeout(timeout);
        ws.close(1000);
        // Bound shutdown even when a server ignores the closing handshake.
        closeTimeout = setTimeout(() => ws.terminate(), 1_000);
        closeTimeout.unref();
        resolve();
      } else if (message.type === "error") {
        fail("Server rejected WebSocket smoke check");
      }
    });
    // Never print payloads, tokens, or arbitrary server error text.
    ws.on("error", () => fail("WebSocket transport failed"));
    ws.on("close", () => {
      clearTimeout(closeTimeout);
      fail("WebSocket closed before session.ready");
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSmoke({
      url: process.env.REALTIME_WS_URL ?? "wss://realtime.cloudnexuspilot.com/ws/session",
      token: process.env.REALTIME_SMOKE_JWT,
      origin: process.env.REALTIME_SMOKE_ORIGIN ?? "https://cloudnexuspilot.com",
    });
    console.log("Authenticated WebSocket smoke check passed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
