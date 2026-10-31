import assert from 'node:assert/strict';
import test from 'node:test';
import {sourceLoader} from './route-test-loader.mjs';
const fixtureEnv={OPENAI_API_KEY:'SECRET_SENTINEL',OPENAI_BASE_URL:'http://127.0.0.1:59093/v1',NEXT_PUBLIC_PILOT_TEST_FIXTURE:'1'};
test('capability disclosure labels the actual fixture, not live OpenAI recognition',async()=>{
 const load=sourceLoader({'@/lib/server/provider-auth':{requireProviderUser:async()=>({userId:'synthetic-owner'})}},{process:{env:fixtureEnv}});
 const response=await load('@/app/api/processing-capabilities/route').GET(new Request('https://pilot.test/api/processing-capabilities'));
 const body=await response.json();assert.equal(body.transcriptionProvider,'Synthetic fixture');assert.equal(body.guidanceProvider,'Synthetic fixture');assert.equal(body.speechRecognitionConfigured,false);assert.equal(body.questionSpecificGuidanceConfigured,false);assert.doesNotMatch(JSON.stringify(body),/SECRET_SENTINEL|59093/);
});
test('official configuration is not reported as an authenticated health result',async()=>{
 const load=sourceLoader({'@/lib/server/provider-auth':{requireProviderUser:async()=>({userId:'synthetic-owner'})}},{process:{env:{...fixtureEnv,NEXT_PUBLIC_PILOT_TEST_FIXTURE:'0',OPENAI_BASE_URL:'https://api.openai.com/v1'}}});
 const body=await(await load('@/app/api/processing-capabilities/route').GET(new Request('https://pilot.test'))).json();assert.equal(body.transcriptionProvider,'OpenAI');assert.equal(body.syntheticFixture,false);assert.match(body.note,/availability is not certified/);
});
test('Deepgram selection remains independent of fixture guidance',async()=>{
 const load=sourceLoader({'@/lib/server/provider-auth':{requireProviderUser:async()=>({userId:'synthetic-owner'})}},{process:{env:{...fixtureEnv,DEEPGRAM_API_KEY:'SECOND_SECRET'}}});
 const body=await(await load('@/app/api/processing-capabilities/route').GET(new Request('https://pilot.test'))).json();assert.equal(body.transcriptionProvider,'Deepgram');assert.equal(body.guidanceProvider,'Synthetic fixture');assert.equal(body.speechRecognitionConfigured,true);assert.equal(body.questionSpecificGuidanceConfigured,false);
});
test('answer latency excludes an hour of idle time',()=>{
 const {recordGuidanceTiming,formatGuidanceTiming}=sourceLoader()('@/lib/guidance-latency');
 let state={completed:0,totalMs:0};assert.equal(formatGuidanceTiming(state),'--');state=recordGuidanceTiming(state,100,300);state=recordGuidanceTiming(state,3600000,3600400);assert.equal(formatGuidanceTiming(state),'0.3s');assert.deepEqual(recordGuidanceTiming(state,5,4),state);
});
test('a saved guidance acknowledgement does not relabel failed audio',()=>{
 const {describeSaveAcknowledgement}=sourceLoader()('@/lib/guidance-latency');const text=describeSaveAcknowledgement('saved','Processing allowance exhausted','');assert.match(text,/Processing issue/);assert.doesNotMatch(text,/acknowledgement: saved/);assert.match(text,/guidance is tracked separately/);
});
test('Kubernetes question survives the real prompt builder and mocked transport',async()=>{
 const load=sourceLoader();const {buildInterviewUserPrompt}=load('@/lib/interview-intelligence/natural-speaking');const prompt=buildInterviewUserPrompt({question:'What is Kubernetes?',packedContext:'Synthetic test context',mode:'kubernetes',category:'technical'});assert.match(prompt,/What is Kubernetes\?/);
 const {createOpenAiProvider}=load('@/lib/llm-providers');let requested;
 const provider=createOpenAiProvider({apiKey:'TEST_ONLY',model:'explicit-test-model',fetchImpl:async(_url,init)=>{requested=JSON.parse(init.body);return new Response('data: {"choices":[{"delta":{"content":"MOCK_ONLY"}}]}\n\ndata: [DONE]\n\n');}});
 let output='';for await(const token of provider.streamText({messages:[{role:'user',content:prompt}],maxTokens:420,temperature:0.3,responseFormat:'json',signal:new AbortController().signal}))output+=token;
 assert.equal(requested.model,'explicit-test-model');assert.match(requested.messages[0].content,/What is Kubernetes\?/);assert.equal(output,'MOCK_ONLY');
});
