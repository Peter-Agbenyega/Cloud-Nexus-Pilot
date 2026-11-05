// Explicit bounded live test: one generated speech upload, digital silence, and one answer.
// No physical microphone. Never logs provider/authentication credentials.
import assert from 'node:assert/strict';
import {readFile,writeFile,open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
// Timing is observed at the HTTP client, not microphone capture or browser paint.
// Forty decoded characters distinguish a readable opening from a one-word preview.
async function readTimedGuidance(response,startedAt,now=()=>performance.now()) {
 assert.ok(response.body,'Guidance body missing');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 const events=[],timing={firstAnswerTextMs:null,firstAnswerEvent:null,firstReadableAnswerMs:null,firstReadableAnswerEvent:null,finalAnswerMs:null,streamDoneMs:null,previewEvents:0,firstPreviewCharacters:null};
 let buffer='',bytes=0,done=false;
 const elapsed=()=>Math.round((now()-startedAt)*100)/100;
 const record=raw=>{
  const text=raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
  if(!text)return;
  const event=JSON.parse(text);events.push(event);
  let answer='';
  if(event.type==='preview'&&typeof event.speakNow==='string'){
   answer=event.speakNow.trim();timing.previewEvents++;
   if(answer&&timing.firstPreviewCharacters===null)timing.firstPreviewCharacters=answer.length;
  }
  if(event.type==='final'&&typeof event.content==='string'){
   const payload=JSON.parse(event.content);
   answer=String(payload.speakNow||payload.gist||payload.full_answer||'').trim();
   if(timing.finalAnswerMs===null)timing.finalAnswerMs=elapsed();
  }
  if(answer&&timing.firstAnswerTextMs===null){timing.firstAnswerTextMs=elapsed();timing.firstAnswerEvent=event.type;}
  if(answer.length>=40&&timing.firstReadableAnswerMs===null){timing.firstReadableAnswerMs=elapsed();timing.firstReadableAnswerEvent=event.type;}
  if(event.type==='done'){done=true;timing.streamDoneMs=elapsed();}
 };
 try {
  while(!done){
   const part=await reader.read();bytes+=part.value?.byteLength??0;
   assert.ok(bytes<=262144,'Guidance stream exceeded timing harness limit');
   buffer+=decoder.decode(part.value??new Uint8Array(),{stream:!part.done});
   buffer=buffer.replace(/\r\n/g,'\n');
   let boundary=buffer.indexOf('\n\n');
   while(boundary>=0){record(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);boundary=buffer.indexOf('\n\n');}
   if(part.done){assert.ok(done,'Guidance stream ended before done');break;}
  }
  return {events,timing};
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

async function timingSelfTest(){
 let clock=0;
 const event=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';
 const final={type:'final',content:JSON.stringify({speakNow:'Kubernetes manages containerized applications across hosts.'})};
 function mock(chunks){return new Response(new ReadableStream({pull(controller){const part=chunks.shift();if(!part){controller.close();return;}clock=part[0];controller.enqueue(new TextEncoder().encode(part[1]));}},{highWaterMark:0}));}
 let result=await readTimedGuidance(mock([[5,event({type:'start'})],[25,event(final)],[27,event({type:'done'})]]),0,()=>clock);
 assert.equal(result.timing.firstAnswerEvent,'final');assert.equal(result.timing.firstAnswerTextMs,25);assert.equal(result.timing.finalAnswerMs,25);assert.equal(result.timing.streamDoneMs,27);assert.equal(result.timing.previewEvents,0);
 clock=0;
 const preview=event({type:'preview',speakNow:'Kubernetes manages containerized applications across hosts.',draft:true});
 result=await readTimedGuidance(mock([[3,event({type:'start'})],[8,event({type:'preview',speakNow:'Kubernetes',draft:true})],[12,preview.slice(0,35)],[15,preview.slice(35)],[30,event(final)],[32,event({type:'done'})]]),0,()=>clock);
 assert.equal(result.timing.firstAnswerTextMs,8);assert.equal(result.timing.firstAnswerEvent,'preview');assert.equal(result.timing.firstReadableAnswerMs,15);assert.equal(result.timing.firstReadableAnswerEvent,'preview');assert.equal(result.timing.finalAnswerMs,30);assert.equal(result.timing.previewEvents,2);assert.equal(result.timing.firstPreviewCharacters,10);
 await assert.rejects(()=>readTimedGuidance(mock([[1,event({type:'start'})]]),0,()=>clock),/ended before done/);
 console.log('Guidance timing self-tests passed: final-only, progressive split SSE, truncated stream. No network requests.');
}
if(process.argv[2]==='--self-test'){await timingSelfTest();process.exit(0);}
assert.equal(process.argv[2],'--execute-once');
assert.ok(process.argv.length <= 4);
const attemptId=process.argv[3] ?? '20261101';
assert.match(attemptId,/^[a-zA-Z0-9_-]{1,64}$/);
const require=createRequire(new URL('../../apps/cloud-nexus-pilot/package.json',import.meta.url));
const {createServerClient}=require('@supabase/ssr');
const p=resolve(homedir(),'.local/share/cloud-nexus-pilot/recovery-test');
const app='http://127.0.0.1:43102', gateway='http://127.0.0.1:59090', fixture='http://127.0.0.1:59093';
const report={at:new Date().toISOString(),liveProvider:true,physicalMicrophone:false,audioSource:'macOS generated Kubernetes speech',transcriptionRequests:0,guidanceRequests:0,passed:false};
const reportPath=resolve(p,'live-acceptance-'+attemptId+'.json');
let sessionBase,request;
try {
 const page=await fetch(app+'/auth/login',{signal:AbortSignal.timeout(10000)});
 assert.equal(page.status,200,'Live sign-in page unavailable');
 const html=await page.text();
 assert.ok(html.includes('LIVE PROVIDER TEST'),'Live disclosure missing');
 const cfg=JSON.parse(await readFile(resolve(p,'private.json'),'utf8'));
 const jar=new Map();
 const client=createServerClient(gateway,cfg.anon_key,{cookieOptions:{name:'sb-pilot-recovery-test-auth-token'},cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:items=>items.forEach(x=>jar.set(x.name,x.value))}});
 const {data,error}=await client.auth.signInWithPassword({email:cfg.email_browser,password:cfg.user_password});
 assert.ok(!error&&data.session,'Local test account authentication failed');
 request=(path,init={})=>fetch(app+path,{...init,headers:{origin:app,cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...init.headers},redirect:'error',signal:AbortSignal.timeout(45000)});
 const counter=async()=>await(await fetch(fixture+'/fixture-status',{signal:AbortSignal.timeout(5000)})).json();
 const usage=async()=>{
  const r=await fetch(gateway+'/rest/v1/pilot_usage_accounts?select=consumed_units,reserved_units,granted_units',{headers:{apikey:cfg.anon_key,authorization:'Bearer '+data.session.access_token},signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,200);const rows=await r.json();assert.equal(rows.length,1);return rows[0];
 };
 const before=await counter(), usageBefore=await usage();
 const wav=await readFile(resolve(p,'investigation-kubernetes/kubernetes-spoken.wav'));
 assert.ok(usageBefore.granted_units-usageBefore.consumed_units-usageBefore.reserved_units>=wav.length+Math.max(wav.length,1000),'Insufficient local test allowance');
 assert.ok(wav.length>1000&&wav.toString('ascii',0,4)==='RIFF','Speech WAV missing');
 // Durable one-shot marker prevents accidental paid reruns.
 const marker=await open(resolve(p,'live-acceptance-'+attemptId+'.attempt'),'wx',0o600);
 await marker.writeFile(report.at+'\n');await marker.close();
 const created=await request('/api/transcribe/stream/session',{method:'POST'});
 const createdBody=await created.json();
 assert.equal(created.status,201,'Session creation failed: '+(createdBody.error?.code||created.status));
 report.sessionId=createdBody.sessionId;
 sessionBase='/api/transcribe/stream/session/'+report.sessionId;
 report.transcriptionRequests++;
 const transcriptionStartedAt=performance.now();
 const uploaded=await request(sessionBase+'/chunk',{method:'POST',body:wav,headers:{'content-type':'audio/wav','x-chunk-index':'0','x-transcript-source':'microphone'}});
 const chunk=await uploaded.json();
 report.timing={clock:'performance.now (monotonic)',scope:'HTTP transport; excludes microphone chunk accumulation, frontend detection, browser paint, and test silence requests',captureAndEndpointingIncluded:false,browserPaintIncluded:false,transcriptionResponseMs:Math.round((performance.now()-transcriptionStartedAt)*100)/100};
 report.transcriptionStatus=uploaded.status;
 if(chunk.error) report.transcriptionErrorCode=chunk.error.code;
 assert.equal(uploaded.status,202,'Transcription failed');
 assert.equal(chunk.saved,true);
 const transcript=chunk.response?.text;
 report.transcript=transcript;
 assert.match(transcript,/kubernetes/i,'Transcript does not match generated speech');
 // Silence is acknowledged and replayable without provider usage or transcript rows.
 const silent=Buffer.from(wav);
 let offset=12, zeroed=false;
 while(offset+8<=silent.length){
  const size=silent.readUInt32LE(offset+4), start=offset+8;
  assert.ok(start+size<=silent.length,'Invalid test WAV');
  if(silent.toString('ascii',offset,offset+4)==='data'){silent.fill(0,start,start+size);zeroed=true;}
  offset=start+size+(size%2);
 }
 assert.ok(zeroed,'No PCM data found');
 const silenceBefore=await usage();
 report.silentChunkRequests=0;
 for(const index of [1,2,2]){
  const response=await request(sessionBase+'/chunk',{method:'POST',body:silent,headers:{'content-type':'audio/wav','x-chunk-index':String(index),'x-transcript-source':'microphone'}});
  const body=await response.json();report.silentChunkRequests++;
  assert.equal(response.status,report.silentChunkRequests===3?200:202);assert.equal(body.saved,true);assert.equal(body.response?.text,'');
  if(report.silentChunkRequests===3)assert.equal(body.replay,true);
 }
 const silenceAfter=await usage();
 assert.equal(silenceAfter.consumed_units,silenceBefore.consumed_units,'Silence must not consume provider units');
 assert.equal(silenceAfter.reserved_units,0);
 const afterSilence=await request(sessionBase);assert.equal(afterSilence.status,200);
 const preserved=await afterSilence.json();assert.equal(preserved.events.length,1);
 report.silenceUsageDelta=0;report.silencePreservedTranscript=true;report.silenceReplayVerified=true;
 const questionId=randomUUID(),transcriptRevision='live-acceptance-1';
 report.guidanceRequests++;
 const guidanceStartedAt=performance.now();
 const answerResponse=await request('/api/generate-guidance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:report.sessionId,question:transcript,questionId,transcriptRevision,interviewMode:'kubernetes'})});
 report.guidanceStatus=answerResponse.status;
 report.timing.guidanceHeadersMs=Math.round((performance.now()-guidanceStartedAt)*100)/100;
 const {events,timing}=await readTimedGuidance(answerResponse,guidanceStartedAt);
 report.timing.guidance=timing;
 report.timing.readableAnswerThresholdCharacters=40;
 const failure=events.find(x=>x.type==='error');if(failure)report.guidanceErrorCode=failure.code;
 assert.equal(answerResponse.status,200);
 assert.ok(!failure,'Guidance provider failed');
 const final=events.find(x=>x.type==='final');assert.ok(final,'No final guidance');
 const answer=JSON.parse(final.content);
 report.answer=answer;
 assert.match(JSON.stringify(answer),/kubernetes/i);
 assert.match(JSON.stringify(answer),/container|orchestrat/i);
 assert.ok(!JSON.stringify(answer).includes('Synthetic local fixture'));
 const savedResponse=await request(sessionBase);assert.equal(savedResponse.status,200);
 const saved=await savedResponse.json();
 assert.equal(saved.events.length,1);
 const matching=(saved.guidance||[]).find(x=>x.state==='succeeded'&&x.result?.questionId===questionId);
 assert.ok(matching,'Matching saved guidance missing');
 assert.equal(matching.result.question,transcript);
 report.savedTranscriptAndGuidance=true;
 const stop=await request(sessionBase+'/stop',{method:'POST'});assert.equal(stop.status,200);
 const exported=await request(sessionBase+'?format=export');assert.equal(exported.status,200);
 const persisted=await exported.json();assert.equal(persisted.status,'ended');
 assert.equal(persisted.events.length,1);assert.ok(persisted.guidance.some(x=>x.result?.questionId===questionId));
 report.exportVerified=true;
 const after=await counter(),usageAfter=await usage();
 assert.equal(after.transcriptionCalls,before.transcriptionCalls);
 assert.equal(after.guidanceCalls,before.guidanceCalls);
 assert.equal(usageAfter.reserved_units,0);
 assert.ok(usageAfter.consumed_units>usageBefore.consumed_units);
 report.syntheticDispatchDelta=0;
 report.usageDelta=usageAfter.consumed_units-usageBefore.consumed_units;
 report.reservedUnits=usageAfter.reserved_units;
 report.passed=true;
} catch(error) {
 report.failure=error instanceof assert.AssertionError?error.message:'Test stopped: '+error.name;
 process.exitCode=1;
} finally {
 if(sessionBase&&request)try {await request(sessionBase+'/stop',{method:'POST'});}catch{}
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report,null,2));
}
