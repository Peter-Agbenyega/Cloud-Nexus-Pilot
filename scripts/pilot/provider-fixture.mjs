// Synthetic local protocol fixture. It performs NO speech recognition/model
// inference and never contacts a provider. Do not deploy as a provider service.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { inspectFixtureWav } from "./audio-diagnostics.mjs";
const port = Number(process.env.PILOT_FIXTURE_PORT ?? 58093);
if (![58093, 59093].includes(port)) throw new Error("Unapproved local fixture port");
const liveAcceptance = process.env.PILOT_LIVE_ACCEPTANCE === "1";
if (liveAcceptance && (port !== 59093 || process.env.PILOT_RECOVERY_STACK !== "1"))
  throw new Error("Live fixture sign-in requires the recovery fixture port and stack.");
const loginTarget = liveAcceptance ? "http://127.0.0.1:43102/workspace" : "http://127.0.0.1:43101/workspace";
let transcriptionCalls = 0, guidanceCalls = 0;
const audio = { wavChunks: 0, nonSilentChunks: 0, wavBytes: 0, peak: 0, lastChunk: null };
const server = createServer(async (request, response) => {
  // Explicit recovery fixture only: authenticate a fresh synthetic test account,
  // set normal SSR cookies and redirect. Never available on the original fixture.
  if (port === 59093 && process.env.PILOT_RECOVERY_STACK === "1" && request.method === "GET" && request.url === "/fixture-login") {
    try {
      const config = JSON.parse(await readFile(resolve(homedir(), ".local/share/cloud-nexus-pilot/recovery-test/private.json"), "utf8"));
      const require = createRequire(new URL("../../apps/cloud-nexus-pilot/package.json", import.meta.url));
      const { createServerClient } = require("@supabase/ssr");
      const cookies = [];
      const client = createServerClient("http://127.0.0.1:59090", config.anon_key, { cookieOptions: { name: "sb-pilot-recovery-test-auth-token" }, cookies: { getAll: () => [], setAll: items => cookies.push(...items) } });
      const { data, error } = await client.auth.signInWithPassword({ email: config.email_browser, password: config.user_password });
      if (error || !data.user || !data.session) throw new Error("Synthetic sign-in failed");
      response.setHeader("Set-Cookie", cookies.map(({name,value,options}) => `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${options.maxAge ?? 3600}`));
      response.setHeader("cache-control", "no-store");
      response.writeHead(302, { location: loginTarget }).end();
    } catch { response.writeHead(503).end("Synthetic account sign-in unavailable"); }
    return;
  }
  if (request.method === "GET" && request.url === "/fixture-tone") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Pilot synthetic audio fixture</title><h1>Pilot synthetic tone — no people recorded</h1><p>Low-level test tone for explicit tab sharing. This is not speech or provider recognition.</p><button id="start">Start synthetic tone</button><button id="stop">Stop tone</button><p id="status">Stopped</p><script>let ctx,osc;document.getElementById('start').onclick=async()=>{if(ctx)return;ctx=new AudioContext();const gain=ctx.createGain();gain.gain.value=0.025;osc=ctx.createOscillator();osc.frequency.value=440;osc.connect(gain).connect(ctx.destination);osc.start();await ctx.resume();document.getElementById('status').textContent='Synthetic tone playing';};document.getElementById('stop').onclick=async()=>{if(ctx){osc.stop();await ctx.close();ctx=null;}document.getElementById('status').textContent='Stopped';};</script>`);
    return;
  }
  if (request.method === "GET" && request.url === "/fixture-status") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ synthetic: true, transcriptionCalls, guidanceCalls, audio })); return;
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of request) { size += chunk.length; if (size > 2_100_000) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    if (request.method !== "POST") { response.writeHead(404).end(); return; }
    if (request.url === "/v1/audio/transcriptions") {
      transcriptionCalls++;
      const measured = inspectFixtureWav(Buffer.concat(chunks));
      if (measured) {
        audio.wavChunks++; audio.wavBytes += measured.wavBytes;
        if (measured.rms > 0.001) audio.nonSilentChunks++;
        audio.peak = Math.max(audio.peak, measured.peak);
        audio.lastChunk = { ...measured, receivedAt: new Date().toISOString() };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "What is infrastructure as code?" })); return;
    }
    if (request.url === "/v1/chat/completions") {
      guidanceCalls++;
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const payload = { headline: "General technical explanation", speakNow: "Infrastructure as code defines resources in versioned configuration. Review a plan, test changes, and apply through an approved workflow.", keyPoints: ["Version changes", "Review plans", "Test before applying"], full_answer: "Infrastructure as code defines resources in versioned configuration. This is a general explanation, not a claim of personal work experience.", caution: "Synthetic local fixture; no live model was called.", example: "Hypothetical: a reviewed Terraform configuration creates a test network." };
      if (!input.stream) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: "What is infrastructure as code?" } }] })); return; }
      response.setHeader("content-type", "text/event-stream");
      const text = JSON.stringify(payload);
      for (const token of [text.slice(0, 65), text.slice(65)]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\r\n\r\n`);
      response.end("data: [DONE]\r\n\r\n"); return;
    }
    response.writeHead(404).end();
  } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Synthetic Pilot provider fixture at http://127.0.0.1:${port} (no inference, no external calls).`));
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
