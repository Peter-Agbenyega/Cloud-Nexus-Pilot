// Actual wall-clock synthetic soak of compiled routes + real local identity/data.
// This does not capture a microphone and the provider performs no inference.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
const root = resolve(import.meta.dirname, "../..");
const require = createRequire(resolve(root, "apps/cloud-nexus-pilot/package.json"));
const { createServerClient } = require("@supabase/ssr");
const exec = promisify(execFile);
const configuration = JSON.parse(await readFile("/private/tmp/cnp-pilot-local-stack/private.json", "utf8"));
const dest = resolve(root, "review/completion-soak");
const app = "http://127.0.0.1:3100", fixture = "http://127.0.0.1:58093";
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "PILOT_DATA_API_URL", "OPENAI_BASE_URL"]) {
  assert.equal(new URL(process.env[key]).hostname, "127.0.0.1", `${key} must be local`);
}
const DUR = 1_805_000, PERIOD = 10_000, DEADLINE = 12_000;
const startedAt = new Date().toISOString(), start = performance.now();
const records = [], saved = new Map(), chunkIndexes = new Set(), unknown = new Set(), timings = [], resources = [];
let cursor = 0, index = 0, active = 0, maxActive = 0, acknowledged = 0, interruptions = 0, recoveries = 0;
let wasInterrupted = false, sessionId;
async function record(type, fields = {}) {
  const row = { at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), type, ...fields };
  records.push(row); await appendFile(`${dest}/events.jsonl`, JSON.stringify(row) + "\n");
  if (["started", "progress", "interruption", "recovered", "completed", "failed"].includes(type)) console.log(JSON.stringify(row));
}
async function login(email) {
 const jar = new Map();
 const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
   cookies: { getAll: () => [...jar].map(([name,value]) => ({name,value})), setAll: items => { for(const item of items)jar.set(item.name,item.value); } },
 });
 const {data,error}=await client.auth.signInWithPassword({email,password:configuration.user_password});
 assert.ok(!error&&data.session&&data.user,"Real local synthetic account login failed");
 return {cookie:[...jar].map(([key,value])=>`${key}=${value}`).join("; ")};
}
async function call(user,path,init={}) {
 const began=performance.now();active++;maxActive=Math.max(active,maxActive);
 try {const r=await fetch(app+path,{...init,headers:{origin:app,cookie:user.cookie,...init.headers},signal:AbortSignal.timeout(DEADLINE)});return r;}
 finally{active--;timings.push(Math.round(performance.now()-began));}
}
function wav() {
 const data=new Uint8Array(32044),v=new DataView(data.buffer);
 for(const[offset,text]of[[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]])data.set(new TextEncoder().encode(text),offset);
 v.setUint32(4,32036,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,32000,true);
 for(let i=0;i<16000;i++)v.setInt16(44+2*i,Math.round(Math.sin(2*Math.PI*440*i/16000)*4000),true);
 return data;
}
const audio=wav(); // Only this one bounded 32,044-byte synthetic buffer is retained.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let a,b;
async function reconcile() {
 const response=await call(a,`/api/transcribe/stream/session/${sessionId}?cursor=${cursor}`);
 if(!response.ok)throw new Error(`read_status_${response.status}`);
 const body=await response.json();assert.equal(body.saved,true);assert.equal(body.audioRetained,false);assert.match(body.captureGap,/not recoverable/);
 let count=0;
 for(const event of body.events){
   const key=event.client_event_id;assert.equal(typeof key,"string");
   assert.ok(!saved.has(key),"Resume cursor must not return duplicate final identities");
   const chunk=event.provider_result?.chunkIndex;assert.ok(Number.isSafeInteger(chunk));
   assert.ok(!chunkIndexes.has(chunk),"Duplicate final chunk index");
   assert.ok(Number.isSafeInteger(event.sequence)&&event.sequence>cursor,"Final cursor must increase");
   cursor=Math.max(cursor,event.sequence);saved.set(key,{sequence:event.sequence,chunkIndex:chunk});chunkIndexes.add(chunk);unknown.delete(chunk);count++;
 }
 if(wasInterrupted){recoveries++;wasInterrupted=false;await record("recovered",{cursor,restoredEvents:count,unknownChunkIndexes:[...unknown]});}
 return body;
}
async function resourceSample() {
 const sample={at:new Date().toISOString(),clientRssBytes:process.memoryUsage().rss};
 try{const {stdout}=await exec("lsof",["-nP","-iTCP:3100","-sTCP:LISTEN","-t"],{timeout:2000});const pid=Number(stdout.trim().split("\n")[0]);
  const rss=await exec("ps",["-o","rss=","-p",String(pid)],{timeout:2000});sample.frontendPid=pid;sample.frontendRssBytes=Number(rss.stdout.trim())*1024;
 }catch{sample.frontendMetricUnavailable=true;}
 resources.push(sample);
 assert.ok(sample.clientRssBytes<256*1024*1024,"Synthetic client exceeded256MiB RSS bound");
 if(sample.frontendRssBytes)assert.ok(sample.frontendRssBytes<1536*1024*1024,"Compiled frontend exceeded1536MiB RSS bound");
}
async function providerStatus(){return(await fetch(fixture+"/fixture-status",{signal:AbortSignal.timeout(3000)})).json();}
try{
 a=await login(configuration.email_a);b=await login(configuration.email_b);
 const created=await call(a,"/api/transcribe/stream/session",{method:"POST"});assert.equal(created.status,201);({sessionId}=await created.json());
 const createdMono=performance.now();const base=`/api/transcribe/stream/session/${sessionId}`;
 await record("started",{sessionId,durationTargetMs:DUR,intervalMs:PERIOD,layer:"compiled localhost routes + real local GoTrue/PostgREST/PostgreSQL + synthetic provider; not capture or live recognition",audio:{format:"PCM16 WAV mono",sampleRate:16000,durationMs:1000,bufferBytes:audio.length},maxConcurrentRequests:1});
 const fixtureBefore=await providerStatus();let nextTick=createdMono,lastProgress=0;
 while(performance.now()-createdMono<DUR){
   const elapsed=performance.now()-createdMono;
   if(elapsed<1_790_000){
     const sent=index++;unknown.add(sent);
     try{
       const reply=await call(a,base+"/chunk",{method:"POST",body:audio,headers:{"content-type":"audio/wav","x-chunk-index":String(sent),"x-transcript-source":"microphone"}});
       if(reply.status===202){const value=await reply.json();assert.equal(value.saved,true);assert.equal(value.response.chunkIndex,sent);acknowledged++;await record("chunk_saved",{chunkIndex:sent});}
       else{const payload=await reply.json().catch(()=>({}));throw new Error(`chunk_status_${reply.status}_${payload.error?.code??"unknown"}`);}
       await reconcile();
     }catch(error){
       if(error?.code==="ERR_ASSERTION")throw error;
       interruptions++;wasInterrupted=true;await record("interruption",{chunkIndex:sent,reason:String(error.message).replace(/[^A-Za-z0-9_: .-]/g,"_").slice(0,180),action:"No audio replay; next chunk uses a new index; reconcile durable final cursor."});
       try{await reconcile();}catch{ /* Retry durable read at next scheduled tick. */ }
     }
   }
   if(elapsed-lastProgress>=60_000||lastProgress===0){
     await resourceSample();
     try{assert.equal((await call(b,base)).status,404);}catch(error){if(error?.code==="ERR_ASSERTION")throw error;}
     await record("progress",{acknowledged,savedFinals:saved.size,cursor,unknownChunkIndexes:[...unknown],interruptions,recoveries,clientRssBytes:resources.at(-1).clientRssBytes,frontendRssBytes:resources.at(-1).frontendRssBytes??null});lastProgress=elapsed;
   }
   nextTick+=PERIOD;await sleep(Math.max(1,nextTick-performance.now()));
 }
 assert.ok(performance.now()-createdMono>=1_800_000,"Soak wall-clock duration must reach30minutes");
 await reconcile();assert.equal((await call(b,base)).status,404);
 const beforeExpiry=await providerStatus();
 const expired=await call(a,base+"/chunk",{method:"POST",body:audio,headers:{"content-type":"audio/wav","x-chunk-index":String(index++),"x-transcript-source":"microphone"}});
 assert.equal(expired.status,409,"Expired session must reject processing");
 const expiryError=await expired.json();assert.equal(expiryError.error.code,"operation_not_replayable");
 const afterExpiry=await providerStatus();assert.equal(afterExpiry.transcriptionCalls,beforeExpiry.transcriptionCalls,"Expired session must invoke no provider");
 for(let n=0;n<2;n++)assert.equal((await call(a,base+"/stop",{method:"POST"})).status,200);
 const stopped=await reconcile();assert.equal(stopped.status,"ended");
 const all=await(await call(a,base)).json();assert.equal(all.events.length,saved.size);assert.equal(new Set(all.events.map(e=>e.provider_result.chunkIndex)).size,all.events.length);
 const replay=await call(a,base+"/chunk",{method:"POST",body:audio,headers:{"content-type":"audio/wav","x-chunk-index":"0"}});assert.equal(replay.status,409);
 await resourceSample();assert.equal(active,0);assert.equal(maxActive,1);assert.ok(saved.size>=150,"At least150 separately finalized chunks expected from180 scheduled slots");
 const sorted=timings.toSorted((a,b)=>a-b);const pidGroups=new Map();for(const r of resources)if(r.frontendPid){const values=pidGroups.get(r.frontendPid)??[];values.push(r.frontendRssBytes);pidGroups.set(r.frontendPid,values);}
 const growth=[...pidGroups].map(([pid,values])=>({pid,samples:values.length,firstRssBytes:values[0],lastRssBytes:values.at(-1),growthBytes:values.at(-1)-values[0]}));
 assert.ok(growth.length>0,"At least one actual frontend RSS sample is required");
 for(const g of growth)if(g.samples>=5)assert.ok(g.growthBytes<256*1024*1024,"Frontend RSS growth exceeded256MiB per observed runtime");
 const final={passed:true,sessionId,startedAt,finishedAt:new Date().toISOString(),actualSessionElapsedMs:Math.round(performance.now()-createdMono),layer:"30-minute SYNTHETIC service-path soak; not microphone, browser capture, speech recognition or live provider acceptance",scheduledChunks:index-1,acknowledgedChunks:acknowledged,distinctSavedFinals:saved.size,unknownChunkIndexes:[...unknown],interruptions,recoveries,cursor,maxConcurrentRequests:maxActive,clientAudioQueueBytes:audio.length,requestTimeoutMs:DEADLINE,requestLatencyMs:{samples:timings.length,p95:sorted[Math.floor((sorted.length-1)*.95)],max:sorted.at(-1)},expiry:{httpStatus:expired.status,code:expiryError.error.code,providerCallsDelta:afterExpiry.transcriptionCalls-beforeExpiry.transcriptionCalls},stopRequestsSucceeded:2,fixtureCounterObservation:{before:fixtureBefore,after:afterExpiry,note:"Global fixture counters may include lead tests; expiry paired sample must show zero new calls."},resourceSamples:resources,frontendGrowthByPid:growth,finalEvents:[...saved.values()]};
 await writeFile(`${dest}/result.json`,JSON.stringify(final,null,2)+"\n");await record("completed",{passed:true,actualSessionElapsedMs:final.actualSessionElapsedMs,distinctSavedFinals:saved.size,interruptions,recoveries,expiry:final.expiry});
}catch(error){await record("failed",{name:error?.name??"Error",code:error?.code??null,message:String(error?.message??"Unexpected failure").slice(0,300),sessionId:sessionId??null});process.exitCode=1;}
