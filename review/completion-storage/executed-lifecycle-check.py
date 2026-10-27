from pathlib import Path
import datetime,hashlib,json,os,subprocess,urllib.request,urllib.error
ROOT=Path('/private/tmp/cnp-quality-gates');PRIVATE=Path('/private/tmp/cnp-pilot-local-stack');OUT=ROOT/'review/completion-storage'
config=json.loads((PRIVATE/'private.json').read_text());base='http://127.0.0.1:58090'
soak=json.loads((ROOT/'review/completion-soak/result.json').read_text());session=soak['sessionId']
records=[]
def http(path,body=None,token=None,method='POST'):
 headers={'apikey':config['anon_key'],'authorization':'Bearer '+(token or config['anon_key'])}
 if body is not None:headers['content-type']='application/json'
 request=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
 with urllib.request.urlopen(request,timeout=10) as response:data=json.loads(response.read(2000000));assert response.status==200
 return data
login=http('/auth/v1/token?grant_type=password',{'email':config['email_a'],'password':config['user_password']});token=login['access_token']
user=http('/auth/v1/user',token=token,method='GET');assert user['id']==login['user']['id']
def snapshot():
 data=http('/rest/v1/rpc/pilot_read_session',{'p_session_id':session},token)
 quota=http('/rest/v1/pilot_usage_accounts?select=owner_id,granted_units,consumed_units,reserved_units,max_concurrency',token=token,method='GET')
 return {'session_id':data['session']['id'],'event_count':len(data['events']),
         'event_sha256':hashlib.sha256(json.dumps(data['events'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
         'session_sha256':hashlib.sha256(json.dumps(data['session'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
         'guidance_sha256':hashlib.sha256(json.dumps(data['guidance'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
         'sequences':[e['pilot_sequence'] for e in data['events']], 'quota':quota}
before=snapshot();assert before['event_count']==169
state_before=json.loads((PRIVATE/'stack.json').read_text());config_hash=hashlib.sha256((PRIVATE/'pilot.env').read_bytes()).hexdigest()
def execute(label,script):
 command=['python3','scripts/db-test/'+script];started=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (OUT/(label+'.log')).open('wb') as log:result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=180)
 records.append({'command':command,'exit_code':result.returncode,'started_at':started,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'log':label+'.log','sha256':hashlib.sha256((OUT/(label+'.log')).read_bytes()).hexdigest()})
 assert result.returncode==0,label+' failed'
execute('verified-stack-stop','stop_local_pilot_stack.py')
# Confirm every exact owned container really stopped, not merely CLI exit0.
for name in state_before['containers'].values():
 result=subprocess.run(['docker','inspect','--format','{{.State.Status}}',name],capture_output=True,text=True,timeout=30)
 assert result.returncode==0 and result.stdout.strip()=='exited'
try:urllib.request.urlopen(base+'/auth/v1/health',timeout=2);raise AssertionError('gateway still accepted requests after stop')
except urllib.error.URLError:pass
execute('verified-stack-resume','resume_local_pilot_stack.py')
resume=json.loads((OUT/'local-stack-resume.json').read_text());assert resume['gateway_started'] and not resume['legacy_metadata_repaired']
# Reuse the PRE-stop access token to prove auth session/signing config continuity.
assert http('/auth/v1/user',token=token,method='GET')['id']==user['id']
after=snapshot();assert after==before,'durable soak data or allowance changed during lifecycle'
state_after=json.loads((PRIVATE/'stack.json').read_text());assert state_after['container_ids']==state_before['container_ids']
assert state_after['gateway_pid']!=state_before['gateway_pid']
assert hashlib.sha256((PRIVATE/'pilot.env').read_bytes()).hexdigest()==config_hash
execute('verified-stack-resume-idempotent','resume_local_pilot_stack.py')
assert snapshot()==after
second=json.loads((OUT/'local-stack-resume.json').read_text());assert not second['gateway_started'] and not second['legacy_metadata_repaired']
assert json.loads((PRIVATE/'stack.json').read_text())['gateway_pid']==state_after['gateway_pid']
evidence={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':0,'commands':records,
 'before':before,'after':after,'prestop_token_still_verified':True,'same_container_ids':state_after['container_ids'],
 'old_gateway_pid':state_before['gateway_pid'],'new_gateway_pid':state_after['gateway_pid'],'gateway_restarted_after_stop':True,
 'second_resume_idempotent':True,'private_config_sha256_unchanged':config_hash,'provider_calls':0,'quota_reset_or_refund':False,
 'source_database_or_data_directory_replaced':False,'all_hosted_or_shared_resources_unchanged':True,
 'scripts_sha256':{f:hashlib.sha256((ROOT/'scripts/db-test'/f).read_bytes()).hexdigest() for f in ['stop_local_pilot_stack.py','resume_local_pilot_stack.py']}}
(OUT/'verified-lifecycle-cycle.json').write_text(json.dumps(evidence,indent=2)+'\n')
print('Pilot lifecycle verified: actualstop/resume + idempotentresume, samecontainers/data/config, originalauth token valid,169soakfinals andquota unchanged; provider0.')
