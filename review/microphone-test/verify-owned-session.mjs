// Only reads synthetic local-account configuration; never prints credentials/text.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const root='/private/tmp/cnp-quality-gates',privateRoot='/private/tmp/cnp-pilot-local-stack';
const baseline=JSON.parse(await readFile(root+'/review/microphone-test/baseline.json','utf8'));
const snapshot=process.argv[2]??'after';assert.ok(['after','waiting'].includes(snapshot));
const after=JSON.parse(await readFile(root+'/review/microphone-test/'+snapshot+'.json','utf8'));
const previous=new Set(baseline.database.sessions.map(s=>s.id));
const created=after.database.sessions.filter(s=>!previous.has(s.id));
const processing=created.filter(s=>s.operations>0||s.events>0);
if(!processing.length){console.log(JSON.stringify({status:'NOT_VERIFIED',reason:'No new processed microphone session has been observed.'}));process.exit(2);}
assert.equal(processing.length,1,'More than one processing session created by a single capture');
const session=processing[0];assert.match(session.id,/^[0-9a-f-]{36}$/);
assert.equal(session.status,'ended','Owned processing session has not ended');assert.equal(session.pending,0,'Processing is still pending');assert.equal(session.events,session.unique_event_ids,'Duplicate or unidentified final events found');
assert.ok(after.fixture.audio.nonSilentChunks>baseline.fixture.audio.nonSilentChunks,'No non-silent PCM signal reached the intended local provider path');
const config=JSON.parse(await readFile(privateRoot+'/private.json','utf8'));
const values={};for(const line of(await readFile(privateRoot+'/pilot.env','utf8')).split('\n')){if(line.includes('=')&&!line.startsWith('#')){const index=line.indexOf('=');values[line.slice(0,index)]=line.slice(index+1).replace(/^['"]|['"]$/g,'');}}
assert.equal(new URL(values.NEXT_PUBLIC_SUPABASE_URL).hostname,'127.0.0.1');
const require=createRequire(root+'/apps/cloud-nexus-pilot/package.json');const {createServerClient}=require('@supabase/ssr');const jar=new Map();
const client=createServerClient(values.NEXT_PUBLIC_SUPABASE_URL,values.NEXT_PUBLIC_SUPABASE_ANON_KEY,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:items=>items.forEach(({name,value})=>jar.set(name,value))}});
const login=await client.auth.signInWithPassword({email:config.email_b,password:config.user_password});assert.ok(!login.error&&login.data.user,'Local second-account verification failed');
const cookie=[...jar].map(([k,v])=>k+'='+v).join('; '),app='http://127.0.0.1:3100',base='/api/transcribe/stream/session/'+session.id;
const before=await(await fetch('http://127.0.0.1:58093/fixture-status')).json();const denials=[];
for(const[path,method]of[[base,'GET'],[base+'?format=export','GET'],[base+'/events','GET'],[base+'/stop','POST'],[base,'DELETE'],[base+'/chunk','POST']]){
 const response=await fetch(app+path,{method,headers:{cookie,origin:app,...(path.endsWith('/chunk')?{'content-type':'audio/wav'}:{})},...(path.endsWith('/chunk')?{body:new Uint8Array(0)}:{}),signal:AbortSignal.timeout(8000)});
 assert.equal(response.status,404,'Second account reached an owned session operation');await response.body?.cancel();denials.push({operation:method+' '+path.replace(session.id,'SESSION'),status:response.status});
}
const final=await(await fetch('http://127.0.0.1:58093/fixture-status')).json();assert.equal(final.transcriptionCalls,before.transcriptionCalls);assert.equal(final.guidanceCalls,before.guidanceCalls);
const result={status:'LOCAL_SIGNAL_TRANSPORT_AND_OWNERSHIP_VERIFIED',sessionId:session.id,createdSessionRows:created.length,sessionDuplicationReviewRequired:created.length!==1,processingSessions:processing.length,extraMetadataRows:created.filter(s=>s.id!==session.id).map(s=>({id:s.id,status:s.status})),finalEvents:session.events,pendingOperations:session.pending,secondAccountDenials:denials,providerCallsDuringDenials:0,remaining:'Physical permission/meter and track release require browser observation; positive recovery must be exercised in the signed-in browser. Synthetic responses do not establish speech recognition or live-provider availability.'};
await writeFile(root+'/review/microphone-test/owned-session-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
