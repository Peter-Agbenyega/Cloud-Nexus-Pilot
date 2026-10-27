"""Read-only numeric microphone-test observations. No audio/text/token output."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys,urllib.request
root=Path('/private/tmp/cnp-quality-gates');private=Path('/private/tmp/cnp-pilot-local-stack')
label=sys.argv[1]
assert label.replace('-','').isalnum()
state=json.loads((private/'stack.json').read_text());cid=state['container_ids']['db']
purpose=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "cloudnexus.purpose"}}',cid],text=True).strip()
assert purpose=='pilot-local-acceptance'
query="""BEGIN; SET TRANSACTION READ ONLY;
SELECT json_build_object('sessions',coalesce((SELECT json_agg(json_build_object('id',s.id,'status',s.status,'created_at',s.created_at,'updated_at',s.updated_at,'events',(SELECT count(*) FROM transcript_segments e WHERE e.interview_session_id=s.id),'unique_event_ids',(SELECT count(DISTINCT client_event_id) FROM transcript_segments e WHERE e.interview_session_id=s.id),'operations',(SELECT count(*) FROM pilot_processing_operations p WHERE p.session_id=s.id),'pending',(SELECT count(*) FROM pilot_processing_operations p WHERE p.session_id=s.id AND state='reserved'))) FROM interview_sessions s WHERE s.user_id=(SELECT id FROM auth.users WHERE email='pilot.browser@pilot.test')),'[]'::json));
COMMIT;"""
r=subprocess.run(['docker','exec','-i',cid,'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'],input=query,text=True,capture_output=True,timeout=10)
assert r.returncode==0,'Read-only observer failed; no private diagnostics emitted'
with urllib.request.urlopen('http://127.0.0.1:58093/fixture-status',timeout=5) as response:provider=json.load(response)
config={}
for line in (private/'pilot.env').read_text().splitlines():
 if '=' in line and not line.startswith('#'):
  key,value=line.split('=',1);config[key]=value.strip().strip('"').strip("'")
result={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'fixture':provider,'database':json.loads(r.stdout),'configuration':{'openai_key_present':bool(config.get('OPENAI_API_KEY')),'deepgram_key_present':bool(config.get('DEEPGRAM_API_KEY')),'provider_base_url':config.get('OPENAI_BASE_URL'),'transcription_model':config.get('OPENAI_TRANSCRIPTION_MODEL'),'guidance_model':config.get('OPENAI_MODEL'),'synthetic_banner':config.get('NEXT_PUBLIC_PILOT_TEST_FIXTURE')=='1'},'privacy':'Numeric signal/session metadata only. No raw audio, transcript, passwords, API keys, cookies or tokens.'}
(root/'review/microphone-test'/f'{label}.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
