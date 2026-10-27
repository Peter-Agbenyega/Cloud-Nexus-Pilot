// Compiled-app acceptance with REAL local GoTrue/PostgREST/PostgreSQL and a
// synthetic provider protocol fixture. This is not live speech recognition.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const require = createRequire(resolve(root, "apps/cloud-nexus-pilot/package.json"));
const { createServerClient } = require("@supabase/ssr");
const localRoot = "/private/tmp/cnp-pilot-local-stack";
const configuration = JSON.parse(await readFile(`${localRoot}/private.json`, "utf8"));
const app = process.env.PILOT_JOURNEY_URL ?? "http://127.0.0.1:3100";
assert.ok(["http://127.0.0.1:3100", "http://127.0.0.1:43101"].includes(app), "Only the two isolated local acceptance instances are supported");
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "PILOT_DATA_API_URL", "OPENAI_BASE_URL"]) {
  const value = process.env[key];
  assert.ok(value && new URL(value).hostname === "127.0.0.1", `Local-only ${key} required`);
}
const mode = process.argv[2] ?? "exercise";
const steps = [];
async function login(email) {
  const jar = new Map();
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (items) => { for (const item of items) jar.set(item.name, item.value); } },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: configuration.user_password });
  assert.ok(!error && data.user && data.session, "Synthetic local account sign-in must succeed");
  return { cookie: [...jar].map(([key,value]) => `${key}=${value}`).join("; ") };
}
async function call(user,path,init={}) {
  return fetch(app+path,{...init,headers:{origin:app,cookie:user?.cookie??"",...init.headers},signal:AbortSignal.timeout(45_000)});
}
function wav() {
 const data = new Uint8Array(32044), view = new DataView(data.buffer);
 for(const[offset,text]of[[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]])data.set(new TextEncoder().encode(text),offset);
 view.setUint32(4,data.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,data.length-44,true);
 for(let i=0;i<16000;i++)view.setInt16(44+i*2,Math.round(Math.sin(2*Math.PI*440*i/16000)*4000),true);
 return data;
}
const a = await login(configuration.email_a), b = await login(configuration.email_b);
steps.push("two real local account logins with SSR cookies");
if (mode === "exercise") {
 const before = await(await fetch("http://127.0.0.1:58093/fixture-status")).json();
 assert.equal((await call(null,"/api/transcribe",{method:"POST",body:wav(),headers:{"content-type":"audio/wav"}})).status,401);
 const created = await call(a,"/api/transcribe/stream/session",{method:"POST"});assert.equal(created.status,201,`Session create failed: ${await created.clone().text()}`);const {sessionId} = await created.json();assert.match(sessionId,/^[a-f0-9-]{36}$/);
 const base = `/api/transcribe/stream/session/${sessionId}`;
 for(const index of [0,1]){const reply=await call(a,base+"/chunk",{method:"POST",body:wav(),headers:{"content-type":"audio/wav","x-chunk-index":String(index),"x-transcript-source":"microphone"}});assert.equal(reply.status,202);const body=await reply.json();assert.equal(body.saved,true);assert.equal(body.response.chunkIndex,index);}
 steps.push("owned session; first and later valid PCM/WAV chunks through compiled route and synthetic provider");
 const replay=await call(a,base+"/chunk",{method:"POST",body:wav(),headers:{"content-type":"audio/wav","x-chunk-index":"00"}});assert.equal(replay.status,200);
 for(const[action,method]of[["","GET"],["","DELETE"],["/events","GET"],["/stop","POST"],["/chunk","POST"]])assert.equal((await call(b,base+action,{method,...(action==="/chunk"?{body:wav(),headers:{"content-type":"audio/wav"}}:{})})).status,404);
 const guidanceBody={sessionId,question:"What is infrastructure as code?",questionId:"fixture-turn-1",transcriptRevision:"fixture-revision-1",resumeText:"Synthetic candidate: studied Terraform. No claimed professional deployment experience."};
 const guidance=await call(a,"/api/generate-guidance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(guidanceBody)});assert.equal(guidance.status,200);const events=(await guidance.text()).trim().split("\n\n").map(x=>JSON.parse(x.replace(/^data: /,"")));assert.ok(events.some(e=>e.type==="final"));assert.equal(events.at(-1).type,"done");
 const saved=await(await call(a,base)).json();assert.equal(saved.saved,true);assert.equal(saved.events.length,2);assert.equal(saved.guidance.filter(g=>g.state==="succeeded").length,1);assert.equal(saved.guidance[0].result.questionId,"fixture-turn-1");
 for(let i=0;i<2;i++)assert.equal((await call(a,base+"/stop",{method:"POST"})).status,200);
 const after=await(await fetch("http://127.0.0.1:58093/fixture-status")).json();assert.equal(after.transcriptionCalls-before.transcriptionCalls,2);assert.equal(after.guidanceCalls-before.guidanceCalls,1);
 await writeFile(`${localRoot}/journey-session.json`,JSON.stringify({sessionId,steps,created_at:new Date().toISOString()})+"\n",{mode:0o600});
 steps.push("cross-account denial; replay has no extra provider call; guidance saved with source association; idempotent stop");
} else if(mode === "recover") {
 const {sessionId}=JSON.parse(await readFile(`${localRoot}/journey-session.json`,"utf8"));const base=`/api/transcribe/stream/session/${sessionId}`;
 const restored=await call(a,base);assert.equal(restored.status,200);const body=await restored.json();assert.equal(body.events.length,2);assert.equal(body.status,"ended");assert.ok(body.guidance.some(g=>g.state==="succeeded"));
 const exported=await call(a,base+"?format=export");assert.equal(exported.status,200);assert.match(exported.headers.get("content-disposition"),/attachment/);assert.equal((await exported.json()).events.length,2);
 assert.equal((await call(b,base,{method:"DELETE"})).status,404);assert.equal((await call(a,base,{method:"DELETE"})).status,200);assert.equal((await call(a,base)).status,404);
 steps.push("recover after application restart; complete bounded export; cross-account deletion denial; owned deletion confirmed");
} else throw new Error("Use exercise or recover");
console.log(JSON.stringify({passed:true,mode,layer:"compiled local app + real local identity/database + synthetic provider; no microphone or paid provider",steps},null,2));
