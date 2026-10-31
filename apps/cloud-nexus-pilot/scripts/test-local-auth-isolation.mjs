import assert from 'node:assert/strict';
import test from 'node:test';
import {sourceLoader} from './route-test-loader.mjs';
function configured(url,allow='1',fixture='1') {
 let options;
 const load=sourceLoader({'@supabase/ssr':{createBrowserClient:(_url,_key,input)=>{options=input;return {syntheticClient:true};}}},{process:{env:{NEXT_PUBLIC_SUPABASE_URL:url,NEXT_PUBLIC_SUPABASE_ANON_KEY:'eyJsynthetic-local-test',NEXT_PUBLIC_PILOT_ALLOW_LOOPBACK:allow,NEXT_PUBLIC_PILOT_TEST_FIXTURE:fixture}}});
 return {module:load('@/lib/supabase'),options:()=>options};
}
test('recovery browser requires explicit loopback permission and isolates its session cookie',()=>{
 const c=configured('http://127.0.0.1:59090');assert.equal(c.module.supabaseConfigError,'');assert.equal(c.options().cookieOptions.name,'sb-pilot-recovery-test-auth-token');
});
test('original test stack retains its existing cookie namespace',()=>{
 const c=configured('http://127.0.0.1:58090');assert.equal(c.module.supabaseConfigError,'');assert.equal(c.options().cookieOptions,undefined);
});
test('loopback is still denied without explicit test configuration',()=>{
 const c=configured('http://127.0.0.1:59090','');assert.equal(c.module.supabase,null);assert.match(c.module.supabaseConfigError,/invalid/);
});
test('hosted identity does not inherit the local recovery cookie namespace',()=>{
 const c=configured('https://api.cloudnexuspilot.com');assert.equal(c.module.supabaseConfigError,'');assert.equal(c.options().cookieOptions,undefined);
});
