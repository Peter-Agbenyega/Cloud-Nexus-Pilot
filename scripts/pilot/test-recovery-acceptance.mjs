// Real loopback HTTP + durable new test database; synthetic provider, no microphone.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/cloud-nexus-pilot/package.json',import.meta.url));
const{createServerClient}=require('@supabase/ssr');
const privateRoot=resolve(homedir(),'.local/share/cloud-nexus-pilot/recovery-test');
const cfg=JSON.parse(await readFile(resolve(privateRoot,'private.json'),'utf8'));
assert.equal(process.env.PILOT_RECOVERY_STACK,'1');
assert.equal(process.env.PILOT_DATA_API_URL,'http://127.0.0.1:59090');
const app='http://127.0.0.1:43101',fixture='http://127.0.0.1:59093';
const jar=new Map();
const client=createServerClient(process.env.PILOT_DATA_API_URL,cfg.anon_key,{cookieOptions:{name:"sb-pilot-recovery-test-auth-token"},cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:items=>items.forEach(x=>jar.set(x.name,x.value))}});
const {data,error}=await client.auth.signInWithPassword({email:cfg.email_a,password:cfg.user_password});assert.ok(!error&&data.session);
const request=(path,init={})=>fetch(app+path,{...init,headers:{origin:app,cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...init.headers},signal:AbortSignal.timeout(45000)});
const counter=async()=>await(await fetch(fixture+'/fixture-status')).json();
const usage=async()=>{const r=await fetch(process.env.PILOT_DATA_API_URL+'/rest/v1/pilot_usage_accounts?select=consumed_units,reserved_units',{headers:{apikey:cfg.anon_key,authorization:'Bearer '+data.session.access_token}});assert.equal(r.status,200);return (await r.json())[0];};
function wav(){const b=new Uint8Array(32044),v=new DataView(b.buffer);for(const[o,s]of[[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])b.set(new TextEncoder().encode(s),o);v.setUint32(4,b.length-8,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,b.length-44,true);for(let i=0;i<16000;i++)v.setInt16(44+2*i,Math.round(4000*Math.sin(i/20)),true);return b;}
const chunk=base=>request(base+'/chunk',{method:'POST',body:wav(),headers:{'content-type':'audio/wav','x-chunk-index':'0','x-transcript-source':'microphone'}});
const mode=process.argv[2]??'normal';
let report={at:new Date().toISOString(),mode,synthetic:true,physicalMicrophone:false,liveProvider:false};
if(mode==='recover'){
 const prior=JSON.parse(await readFile(resolve(privateRoot,'acceptance-session.json'),'utf8'));
 const saved=await request('/api/transcribe/stream/session/'+prior.sessionId);assert.equal(saved.status,200);const body=await saved.json();assert.equal(body.status,'ended');assert.equal(body.events.length,1);assert.equal(body.saved,true);
 report={...report,persistedAfterAppRestart:true,eventCount:body.events.length};
}else{
 const created=await request('/api/transcribe/stream/session',{method:'POST'});assert.equal(created.status,201);const{sessionId}=await created.json();const base='/api/transcribe/stream/session/'+sessionId;
 const before=await counter(),usageBefore=await usage();
 const first=await chunk(base),body=await first.json();
 if(mode==='expired'){
  assert.equal(first.status,503);assert.equal(body.error.code,'processing_settlement_unavailable');
  const after=await counter();assert.equal(after.transcriptionCalls,before.transcriptionCalls);assert.deepEqual(await usage(),usageBefore);
  assert.equal((await(await request(base)).json()).events.length,0);
  report={...report,status:503,code:body.error.code,providerDispatchDelta:0,usageUnchanged:true,savedEvents:0};
 }else{
  assert.equal(first.status,202);assert.equal(body.saved,true);
  const charged=await usage();assert.ok(charged.consumed_units>usageBefore.consumed_units);assert.equal(charged.reserved_units,0);
  const replay=await chunk(base);assert.equal(replay.status,200);assert.equal((await replay.json()).saved,true);
  assert.deepEqual(await usage(),charged);const after=await counter();assert.equal(after.transcriptionCalls-before.transcriptionCalls,1);
  const saved=await(await request(base)).json();assert.equal(saved.events.length,1);
  await writeFile(resolve(privateRoot,'acceptance-session.json'),JSON.stringify({sessionId})+'\n',{mode:0o600});
  report={...report,firstStatus:202,replayStatus:200,acknowledged:true,eventCount:1,providerDispatchDelta:1,replayAdditionalUsage:0,reservedUnits:charged.reserved_units};
 }
 for(let i=0;i<2;i++)assert.equal((await request(base+'/stop',{method:'POST'})).status,200);
 report.idempotentStop=true;
}
await writeFile(resolve(privateRoot,`acceptance-${mode}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));
