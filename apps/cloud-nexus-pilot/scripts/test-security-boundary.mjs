import assert from "node:assert/strict";
import { test, after } from "node:test";
import { sourceLoader } from "./route-test-loader.mjs";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { assert.fail("Real network/provider access forbidden in security regressions"); };
after(() => { globalThis.fetch = originalFetch; });
const url = "https://pilot.test/api/transcribe";
function wav() {
  const buffer = new ArrayBuffer(48); const b = new Uint8Array(buffer); const v = new DataView(buffer);
  for (const [offset,text] of [[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]]) b.set(new TextEncoder().encode(text),offset);
  v.setUint32(4,40,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,4,true);return b;
}
function audio(body=wav(),headers={},signal) { return new Request(url,{method:"POST",body,duplex:"half",signal,headers:{"content-type":"audio/wav",...headers}}); }
function harness({owner="a",quota=1_000_000,provider}={}) {
  const state={providerCalls:0,reads:0,commits:0,operations:new Map(),sessionOwner:"a",stopped:false,quota};
  let boundary;
  const repo={
    async create(auth){return {sessionId:"s",status:"active",createdAt:1,events:[],owner:auth.userId};},
    async read(auth,id){state.reads++;if(id!=="s"||auth.userId!==state.sessionOwner)throw new boundary.RequestBoundaryError(404,"transcript_stream_session_missing","Session unavailable.");return {sessionId:id,status:state.stopped?"ended":"active",createdAt:1,events:[]};},
    async stop(auth,id){await repo.read(auth,id);state.stopped=true;},
    async delete(auth,id){await repo.read(auth,id);state.stopped=true;},
    async reserve(auth,input){
      const key=auth.userId+":"+input.operationId;const previous=state.operations.get(key);
      if(previous){if(previous.hash!==input.requestHash)throw new boundary.RequestBoundaryError(409,"operation_conflict","Conflict");return {acquired:false,state:previous.state,result:previous.result};}
      if(state.quota<input.maxUnits)return {acquired:false,state:"quota_exhausted"};
      state.quota-=input.maxUnits;state.operations.set(key,{state:"reserved",hash:input.requestHash});return {acquired:true,state:"reserved"};
    },
    async complete(auth,input){const op=state.operations.get(auth.userId+":"+input.operationId);if(op.state==="reserved"){state.commits++;op.state=input.outcome;op.result=input.result;}return {state:op.state,result:op.result};},
  };
  const load=sourceLoader({
    "@/lib/server/provider-auth":{requireProviderUser:async()=>owner?{userId:owner}:{response:Response.json({error:{code:"authentication_required"}},{status:401})}},
    "@/lib/server/processing-repository":{processingRepository:repo},
    "@/lib/transcription/deepgram-transcribe":{isDeepgramTranscriptionConfigured:()=>false},
    "@/lib/transcription/openai-transcribe":{async transcribeWithOpenAi(input){state.providerCalls++;if(provider)return provider(input);return {text:"Synthetic reference transcript",source:"microphone",chunkIndex:Number(input.chunkIndexHeader),contentType:input.requestContentType,durationMs:1,speakerId:null};}},
  });
  boundary=load("@/lib/server/request-boundary");
  return {state,boundary,repo,load,route:(name="transcribe")=>load(`@/app/api/${name}/route`)};
}
const context={params:Promise.resolve({sessionId:"s"})};
test("unauthenticated transcription rejects before reading or provider work",async()=>{
 const h=harness({owner:null});const response=await h.route().POST(audio());assert.equal(response.status,401);assert.equal(h.state.providerCalls,0);assert.equal(h.state.operations.size,0);
});
for(const action of ["chunk","stop","events"]){test(`foreign user cannot ${action} an owned session`,async()=>{
 const h=harness({owner:"b"});const route=h.route(`transcribe/stream/session/[sessionId]/${action}`);const response=await(route.POST??route.GET)(audio(),context);assert.equal(response.status,404);assert.equal(h.state.providerCalls,0);assert.equal(h.state.operations.size,0);
});}
for(const action of ["GET","DELETE"]){test(`foreign user cannot ${action} saved records/export`,async()=>{const h=harness({owner:"b"});const r=await h.route("transcribe/stream/session/[sessionId]")[action](new Request(url+"?format=export",{method:action}),context);assert.equal(r.status,404);assert.equal(h.state.providerCalls,0);});}
test("oversize without Content-Length stops stream consumption and never invokes provider",async()=>{
 const h=harness();let pulls=0,cancelled=false;const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(512_000));},cancel(){cancelled=true;}});const r=await h.route().POST(audio(stream));assert.equal(r.status,413);assert.ok(pulls<8);assert.equal(cancelled,true);assert.equal(h.state.providerCalls,0);
});
test("misleading Content-Length cannot bypass measured-byte bound",async()=>{const h=harness();const r=await h.route().POST(audio(new Uint8Array(2_000_001),{"content-length":"48"}));assert.equal(r.status,413);assert.equal(h.state.providerCalls,0);});
test("malformed audio, invalid index, cross-origin requests and length mismatch are rejected",async()=>{
 for(const [body,headers,status] of [[new Uint8Array([1,2]),{},415],[wav(),{"x-chunk-index":"NaN"},400],[wav(),{origin:"https://evil.test"},403],[wav(),{"content-length":"47"},400]]){const h=harness();assert.equal((await h.route().POST(audio(body,headers))).status,status);assert.equal(h.state.providerCalls,0);}
});
test("exhausted quota rejects valid audio with no provider work",async()=>{const h=harness({quota:0});assert.equal((await h.route().POST(audio())).status,429);assert.equal(h.state.providerCalls,0);});
test("authorized valid audio reaches provider and commits once; retry replays saved result",async()=>{
 const h=harness();const a=await h.route().POST(audio());assert.equal(a.status,200);assert.equal((await a.json()).text,"Synthetic reference transcript");const b=await h.route().POST(audio());assert.equal(b.status,200);assert.equal(h.state.providerCalls,1);assert.equal(h.state.commits,1);
});
test("chunk retry is owner/idempotency-bound and changed bytes conflict",async()=>{
 const h=harness();const route=h.route("transcribe/stream/session/[sessionId]/chunk");assert.equal((await route.POST(audio(),context)).status,202);assert.equal((await route.POST(audio(),context)).status,200);const changed=wav();changed[47]=7;assert.equal((await route.POST(audio(changed),context)).status,409);assert.equal(h.state.providerCalls,1);assert.equal(h.state.commits,1);
});
test("parallel retry cannot start a second provider call",async()=>{
 let finish;const h=harness({provider:()=>new Promise(r=>{finish=r;})});const first=h.route().POST(audio());while(!finish)await new Promise(r=>setTimeout(r,1));assert.equal((await h.route().POST(audio())).status,409);finish({text:"once",source:"microphone",chunkIndex:0,contentType:"audio/wav",durationMs:1,speakerId:null});assert.equal((await first).status,200);assert.equal(h.state.providerCalls,1);assert.equal(h.state.commits,1);
});
test("interrupted body is cancelled with zero provider invocation",async()=>{
 const h=harness();const abort=new AbortController();let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});const pending=h.route().POST(audio(stream,{},abort.signal));setTimeout(()=>abort.abort(),10);assert.equal((await pending).status,408);assert.equal(cancelled,true);assert.equal(h.state.providerCalls,0);
});
test("provider cancellation settles unknown, keeps bounded reservation, forbids automatic replay",async()=>{
 const abort=new AbortController();let started;const seen=new Promise(r=>{started=r;});const h=harness({provider:async(input)=>{started();assert.equal(input.signal.aborted,false);return new Promise(()=>{});}});const pending=h.route().POST(audio(wav(),{},abort.signal));await seen;abort.abort();assert.equal((await pending).status,408);assert.equal((await h.route().POST(audio())).status,409);assert.equal(h.state.providerCalls,1);assert.equal([...h.state.operations.values()][0].state,"unknown");
});
test("provider exception details never escape the boundary",async()=>{const h=harness({provider:async()=>{throw new Error("secret-token private-stack");}});const r=await h.route().POST(audio());assert.equal(r.status,500);assert.doesNotMatch(await r.text(),/secret-token|private-stack/);});
test("stopped session cannot restart processing and stop is idempotent",async()=>{const h=harness();const stop=h.route("transcribe/stream/session/[sessionId]/stop");assert.equal((await stop.POST(audio(),context)).status,200);assert.equal((await stop.POST(audio(),context)).status,200);assert.equal((await h.route("transcribe/stream/session/[sessionId]/chunk").POST(audio(),context)).status,409);assert.equal(h.state.providerCalls,0);});
test("JSON reader bounds actual bytes and rejects non-object/malformed content",async()=>{const h=harness();for(const body of ['null','[]','{bad','"text"'])await assert.rejects(h.boundary.readBoundedJson(new Request(url,{method:"POST",body,headers:{"content-type":"application/json"}})));await assert.rejects(h.boundary.readBoundedJson(new Request(url,{method:"POST",body:JSON.stringify({x:"x".repeat(70_000)}),headers:{"content-type":"application/json"}})),{status:413});});

test("guidance quota denial invokes no model, permitted path persists validated final once",async()=>{
 const output=JSON.stringify({headline:"General explanation",speakNow:"Terraform defines infrastructure as code. This is a general explanation, not a personal achievement.",keyPoints:["Review changes"],full_answer:"Terraform defines infrastructure as code."});
 for(const allowed of [false,true]){
  let calls=0,commits=0;
  const load=sourceLoader({
   "@/lib/server/provider-auth":{requireProviderUser:async()=>({userId:"a"})},
   "@/lib/server/processing-repository":{processingRepository:{reserve:async()=>({acquired:allowed,state:allowed?"reserved":"quota_exhausted"}),complete:async()=>{commits++;return{state:"succeeded"};}}},
   "@/lib/llm-providers":{selectConfiguredLLMProvider:()=>({async *streamText(){calls++;yield output;}})},
  });
  const response=await load("@/app/api/generate-guidance/route").POST(new Request(url,{method:"POST",body:JSON.stringify({question:"What is Terraform?"}),headers:{"content-type":"application/json"}}));
  assert.equal(response.status,allowed?200:429);const text=await response.text();assert.equal(calls,allowed?1:0);assert.equal(commits,allowed?1:0);if(allowed){assert.match(text,/"type":"final"/);assert.doesNotMatch(text,/"type":"token"/);}
 }
});
test("guidance malformed or oversized body causes zero model invocations",async()=>{
 let calls=0;const load=sourceLoader({"@/lib/server/provider-auth":{requireProviderUser:async()=>({userId:"a"})},"@/lib/llm-providers":{selectConfiguredLLMProvider:()=>({async *streamText(){calls++;yield "private";}})}});
 for(const body of ["{bad",JSON.stringify({question:"x".repeat(70_000)})]){const r=await load("@/app/api/generate-guidance/route").POST(new Request(url,{method:"POST",body,headers:{"content-type":"application/json"}}));assert.equal(r.status,400);}assert.equal(calls,0);
});
test("server provider endpoint cannot be overridden by body and rejects unsafe schemes/credentials",()=>{
 const endpoint=sourceLoader()("@/lib/server/provider-endpoint").openAiEndpoint;
 assert.equal(endpoint("audio/transcriptions","http://127.0.0.1:58093/v1"),"http://127.0.0.1:58093/v1/audio/transcriptions");
 assert.equal(endpoint("audio/transcriptions","https://api.openai.com/v1"),"https://api.openai.com/v1/audio/transcriptions");
 for(const value of ["http://example.test/v1","https://secret@example.test/v1","file:///tmp/provider","https://api.openai.com/v1?credential=x"])assert.throws(()=>endpoint("chat/completions",value));
});

test("spoofed or inconsistent WAV containers never invoke the provider",async()=>{
 const missing=new Uint8Array(44);missing.set(new TextEncoder().encode("RIFF"));new DataView(missing.buffer).setUint32(4,36,true);missing.set(new TextEncoder().encode("WAVE"),8);
 const variants=[missing];
 for(const [offset,value,size] of [[20,3,2],[22,0,2],[24,0,4],[28,1,4],[32,1,2],[34,8,2],[40,999,4]]){const b=wav();const v=new DataView(b.buffer);if(size===2)v.setUint16(offset,value,true);else v.setUint32(offset,value,true);variants.push(b);}
 for(const body of variants){const h=harness();assert.equal((await h.route().POST(audio(body))).status,415);assert.equal(h.state.providerCalls,0);}
});
test("invalid provider shape is not saved as a final transcript",async()=>{const h=harness({provider:async()=>({text:7,chunkIndex:0,source:"microphone"})});const r=await h.route().POST(audio());assert.equal(r.status,502);assert.equal([...h.state.operations.values()][0].state,"unknown");assert.equal(h.state.commits,1);});

test("leading-zero chunk-index aliases replay the same saved operation",async()=>{const h=harness();const route=h.route("transcribe/stream/session/[sessionId]/chunk");assert.equal((await route.POST(audio(wav(),{"x-chunk-index":"0"}),context)).status,202);assert.equal((await route.POST(audio(wav(),{"x-chunk-index":"00"}),context)).status,200);assert.equal(h.state.providerCalls,1);assert.equal(h.state.commits,1);});
test("durable repository false deletion cannot be acknowledged as deleted",async()=>{
 const load=sourceLoader({}, {process:{env:{PILOT_DATA_API_URL:"http://127.0.0.1:58090",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic"}},fetch:async()=>Response.json(false)});
 const repo=load("@/lib/server/processing-repository").processingRepository;
 await assert.rejects(repo.delete({userId:"a",accessToken:"synthetic"},"foreign",new AbortController().signal),{status:404});
});

test("identity verification is interrupted without accepting a stale cookie principal",async()=>{
 const abort=new AbortController();
 const load=sourceLoader({
  "@supabase/ssr":{createServerClient:()=>({auth:{getUser:()=>new Promise(()=>{}),getSession:()=>assert.fail("Unverified cookie must not be used")}})},
  "next/headers":{cookies:async()=>({getAll:()=>[],set(){}})},
 },{process:{env:{NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:58090",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-public-key"}}});
 const pending=load("@/lib/server/provider-auth").requireProviderUser(new Request(url,{signal:abort.signal}));
 setTimeout(()=>abort.abort(),10);const auth=await pending;assert.equal(auth.response.status,503);assert.equal(auth.userId,undefined);
});

test("per-runtime ingress bounds concurrent buffers before reading another owned request",async()=>{
 const h=harness();const controllers=[new AbortController(),new AbortController()];
 const waiting=controllers.map(c=>h.route().POST(audio(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){}}),{},c.signal)));
 await new Promise(r=>setTimeout(r,5));assert.equal((await h.route().POST(audio())).status,429);assert.equal(h.state.providerCalls,0);
 for(const c of controllers)c.abort();await Promise.all(waiting);assert.equal((await h.route().POST(audio())).status,200);assert.equal(h.state.providerCalls,1);
});

test("origin verification uses configured public origin rather than internal Next/proxy host",()=>{
 const load=sourceLoader({}, {process:{env:{NEXT_PUBLIC_SITE_URL:"http://127.0.0.1:3100"}}});const verify=load("@/lib/server/request-boundary").assertSameOrigin;
 assert.doesNotThrow(()=>verify(new Request("http://localhost:3100/api/test",{headers:{origin:"http://127.0.0.1:3100",cookie:"synthetic=1"}})));
 assert.throws(()=>verify(new Request("http://localhost:3100/api/test",{headers:{origin:"https://evil.test","x-forwarded-host":"evil.test"}})),{status:403});
 assert.throws(()=>verify(new Request("http://localhost:3100/api/test",{headers:{cookie:"synthetic=1"}})),{status:403});
});

test("oversized file input is rejected before browser reads or provider fetches",async()=>{
 const service=sourceLoader()("@/features/transcription/transcript-service");let read=false;const file={name:"large.txt",type:"text/plain",size:2_000_001,text:async()=>{read=true;return"private";}};
 await assert.rejects(service.transcribeUploadedAsset(file),/2 MB/);assert.equal(read,false);
 assert.equal((await service.transcribeUploadedAsset(new File(["Synthetic transcript"],"reference.txt",{type:"text/plain"}))).transcript,"Synthetic transcript");
 const abort=new AbortController();abort.abort();await assert.rejects(service.transcribeUploadedAsset(new File(["fixture"],"reference.txt",{type:"text/plain"}),abort.signal));
});

test("account discovery uses verified owner and authenticated RLS credential, ignoring supplied owner IDs",async()=>{
 let requested;
 const load=sourceLoader({"@/lib/server/provider-auth":{requireProviderUser:async()=>({userId:"verified-a",accessToken:"synthetic-user-jwt"})}}, {process:{env:{PILOT_DATA_API_URL:"http://127.0.0.1:58090",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-public"}},fetch:async(input,init)=>{requested=new URL(input);assert.equal(new Headers(init.headers).get("authorization"),"Bearer synthetic-user-jwt");return Response.json([{id:"owned-session",status:"ended",created_at:"2026-10-27T00:00:00Z",updated_at:"2026-10-27T00:00:00Z"}]);}});
 const response=await load("@/app/api/transcribe/stream/session/route").GET(new Request(url+"?ownerId=foreign-b"));assert.equal(response.status,200);assert.equal(requested.searchParams.get("user_id"),"eq.verified-a");assert.equal((await response.json()).sessions[0].sessionId,"owned-session");
});
test("capability disclosure requires identity and never returns configured credential values",async()=>{
 for(const allowed of [false,true]){const load=sourceLoader({"@/lib/server/provider-auth":{requireProviderUser:async()=>allowed?{userId:"a"}:{response:Response.json({error:{code:"authentication_required"}},{status:401})}}},{process:{env:{OPENAI_API_KEY:"PRIVATE_SYNTHETIC_SENTINEL",NEXT_PUBLIC_PILOT_TEST_FIXTURE:"1"}}});const r=await load("@/app/api/processing-capabilities/route").GET(new Request(url));assert.equal(r.status,allowed?200:401);const text=await r.text();assert.doesNotMatch(text,/PRIVATE_SYNTHETIC_SENTINEL/);if(allowed)assert.equal(JSON.parse(text).transcriptionProvider,"OpenAI");}
});

test("profile upload authenticates before any file parsing",async()=>{let parsed=0;const load=sourceLoader({"@/lib/server/provider-auth":{requireProviderUser:async()=>({response:Response.json({error:{code:"authentication_required"}},{status:401})})},"@/lib/interview-intelligence/file-ingestion":{ingestProfileFile:async()=>{parsed++;}}});const r=await load("@/app/api/ingest-profile/route").POST(new Request(url,{method:"POST",body:"untrusted"}));assert.equal(r.status,401);assert.equal(parsed,0);});
test("authorized bounded text profile upload still reaches the file adapter",async()=>{let parsed=0;const load=sourceLoader({"@/lib/server/provider-auth":{requireProviderUser:async()=>({userId:"a"})},"@/lib/interview-intelligence/file-ingestion":{ingestProfileFile:async(input)=>{parsed++;assert.equal(input.data.toString(),"Synthetic resume text");return{extractedText:"Synthetic resume text"};}}});const form=new FormData();form.set("file",new File(["Synthetic resume text"],"resume.txt",{type:"text/plain"}));const r=await load("@/app/api/ingest-profile/route").POST(new Request(url,{method:"POST",body:form}));assert.equal(r.status,200);assert.equal(parsed,1);});
