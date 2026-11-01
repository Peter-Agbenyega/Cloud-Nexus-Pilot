import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { validateLiveProfile } from "./live-profile.mjs";
const token = (role, exp = Date.now()/1000+3600) => "test."+Buffer.from(JSON.stringify({role,exp})).toString("base64url")+".not-a-signature";
const valid = {
 PILOT_LIVE_ACCEPTANCE:"1", NEXT_PUBLIC_PILOT_LIVE_ACCEPTANCE:"1", NEXT_PUBLIC_PILOT_TEST_FIXTURE:"0",
 NEXT_PUBLIC_PILOT_ALLOW_LOOPBACK:"1", PILOT_RECOVERY_STACK:"1",
 NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:59090", SUPABASE_URL:"http://127.0.0.1:59090", PILOT_DATA_API_URL:"http://127.0.0.1:59090",
 OPENAI_BASE_URL:"https://api.openai.com/v1", OPENAI_MODEL:"gpt-4o-mini", OPENAI_TRANSCRIPTION_MODEL:"gpt-4o-mini-transcribe",
 PILOT_LOCAL_FRONTEND_PORT:"43102", PILOT_LOCAL_REALTIME_PORT:"43311",
 NEXT_PUBLIC_SITE_URL:"http://127.0.0.1:43102", PILOT_PUBLIC_ORIGIN:"http://127.0.0.1:43102",
 NEXT_PUBLIC_PILOT_REALTIME_WS_URL:"ws://127.0.0.1:43311/ws/session",
 SUPABASE_PUBLISHABLE_KEY:token("anon"), NEXT_PUBLIC_SUPABASE_ANON_KEY:token("anon"), PILOT_PROCESSING_SERVICE_KEY:token("service_role"),
 OPENAI_API_KEY:"TEST_SENTINEL_NOT_A_REAL_KEY",
};
test("explicit live configuration permits build and start without dispatching providers",()=>{
 assert.doesNotThrow(()=>validateLiveProfile(valid,"start"));
 assert.doesNotThrow(()=>validateLiveProfile({...valid,OPENAI_API_KEY:""},"build"));
});
test("live startup rejects missing and synthetic credentials without printing them",()=>{
 for(const key of ["","local-synthetic-only","replace-me","<key>"]) assert.throws(()=>validateLiveProfile({...valid,OPENAI_API_KEY:key},"start"),/authorized live/);
});
test("credentials cannot be redirected to a fixture, arbitrary host, or deceptive URL",()=>{
 for(const url of ["http://127.0.0.1:59093/v1","https://evil.example/v1","https://api.openai.com@evil.example/v1","https://api.openai.com/v1?x=1"])
  assert.throws(()=>validateLiveProfile({...valid,OPENAI_BASE_URL:url},"start"),/official/);
});
test("live profile refuses original data, mixed modes, and altered ports/origin/models",()=>{
 for(const [key,value] of Object.entries({PILOT_DATA_API_URL:"http://127.0.0.1:58090",NEXT_PUBLIC_SUPABASE_URL:"https://hosted.example",NEXT_PUBLIC_PILOT_TEST_FIXTURE:"1",PILOT_LOCAL_FRONTEND_PORT:"43101",PILOT_PUBLIC_ORIGIN:"https://old.example",OPENAI_MODEL:"synthetic-guidance",DEEPGRAM_API_KEY:"another-provider",PILOT_PROCESSING_SERVICE_KEY:""}))
  assert.throws(()=>validateLiveProfile({...valid,[key]:value},"start"));
});
test("default launcher rejects mixed live flags before reading build or spawning children",()=>{
 const result=spawnSync(process.execPath,[new URL("./local.mjs",import.meta.url).pathname,"start"],{encoding:"utf8",env:{...process.env,PILOT_LIVE_ACCEPTANCE:"0",NEXT_PUBLIC_PILOT_LIVE_ACCEPTANCE:"1"}});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Mixed live and synthetic/);
});
test("default fixture launcher still rejects official provider selection",()=>{
 const result=spawnSync(process.execPath,[new URL("./local.mjs",import.meta.url).pathname,"start"],{encoding:"utf8",env:{...process.env,PILOT_LIVE_ACCEPTANCE:"0",NEXT_PUBLIC_PILOT_LIVE_ACCEPTANCE:"0",OPENAI_BASE_URL:"https://api.openai.com/v1"}});
 assert.notEqual(result.status,0);assert.match(result.stderr,/loopback OPENAI_BASE_URL/);
});

test("expired or wrong-role settlement credentials cannot start a live provider",()=>{
 for(const value of [token("service_role",1),token("anon"),"invalid"]) assert.throws(()=>validateLiveProfile({...valid,PILOT_PROCESSING_SERVICE_KEY:value},"start"),/Recovery/);
});
test("runtime refuses an unbuilt or different public profile before spawning",()=>{
 const result=spawnSync(process.execPath,[new URL("./local.mjs",import.meta.url).pathname,"start"],{encoding:"utf8",env:{...process.env,...valid,NEXT_PUBLIC_PROFILE_TEST_NONCE:"unbuilt-profile"}});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Build profile differs|Run the scoped build first/);
});
