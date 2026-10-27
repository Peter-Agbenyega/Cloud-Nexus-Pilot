// Synthetic local protocol fixture. It performs NO speech recognition/model
// inference and never contacts a provider. Do not deploy as a provider service.
import { createServer } from "node:http";
import { inspectFixtureWav } from "./audio-diagnostics.mjs";
let transcriptionCalls = 0, guidanceCalls = 0;
const audio = { wavChunks: 0, nonSilentChunks: 0, wavBytes: 0, peak: 0, lastChunk: null };
const server = createServer(async (request, response) => {
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
server.listen(58093, "127.0.0.1", () => console.log("Synthetic Pilot provider fixture at http://127.0.0.1:58093 (no inference, no external calls)."));
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
