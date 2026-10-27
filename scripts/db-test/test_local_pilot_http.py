#!/usr/bin/env python3
"""Exercise actual local GoTrue/PostgREST HTTP, using only synthetic identities."""
from pathlib import Path
import base64
import datetime
import hashlib
import json
import urllib.request
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = Path('/private/tmp/cnp-pilot-local-stack')
BASE = 'http://127.0.0.1:58090'


def main():
    config = json.loads((PRIVATE/'private.json').read_text())
    checks = []
    def call(path, body=None, token=None, method='POST'):
        headers = {'apikey':config['anon_key'],'authorization':'Bearer '+(token or config['anon_key'])}
        if body is not None: headers['content-type']='application/json'
        request = urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
        try:
            with urllib.request.urlopen(request,timeout=10) as response:
                data=response.read(2_100_000);status=response.status
        except urllib.error.HTTPError as error:
            data=error.read(65536);status=error.code
        return status,json.loads(data) if data else None
    def expect(name, condition):
        if not condition: raise RuntimeError('Local HTTP check failed: '+name)
        checks.append(name)
    tokens={}
    accounts=[('a',config['email_a'],config['user_password']),('b',config['email_b'],config['user_password']),('browser','pilot.browser@pilot.test','PilotBrowserFixture-2026!')]
    for name,email,password in accounts:
        signup,_=call('/auth/v1/signup',{'email':email,'password':password})
        # Safe reruns reuse only these known synthetic accounts.
        expect(name+' signup accepted or existing',signup in (200,400,422,429))
        status,data=call('/auth/v1/token?grant_type=password',{'email':email,'password':password})
        expect(name+' actual password login',status==200 and isinstance(data,dict) and bool(data.get('access_token')))
        tokens[name]=data
        status,user=call('/auth/v1/user',token=data['access_token'],method='GET')
        expect(name+' verified user lookup',status==200 and user['id']==data['user']['id'])
        claims=json.loads(base64.urlsafe_b64decode(data['access_token'].split('.')[1]+'=='))
        expect(name+' expected issuer/role',claims.get('iss')==BASE+'/auth/v1' and claims.get('role')=='authenticated')
        status,_=call('/rest/v1/rpc/pilot_set_allowance',{'p_owner_id':user['id'],'p_granted_units':20000000,'p_max_concurrency':2},config['service_key'])
        expect(name+' bounded test allowance via trusted role',status in (200,204))
    tokenfile=PRIVATE/'sessions.json';tokenfile.write_text(json.dumps(tokens));tokenfile.chmod(0o600)
    status,_=call('/auth/v1/token?grant_type=password',{'email':config['email_a'],'password':'definitely-wrong-fixture-password'})
    expect('wrong password denied',status in (400,401))
    a=tokens['a']['access_token'];b=tokens['b']['access_token'];session=str(uuid.uuid4())
    status,data=call('/rest/v1/rpc/pilot_create_session',{'p_session_id':session,'p_mode':'general','p_consent_version':'local-synthetic-test-v1'},a)
    expect('owned session created',status==200 and data['user_id']==tokens['a']['user']['id'])
    for action in ('pilot_read_session','pilot_stop_session'):
        status,_=call('/rest/v1/rpc/'+action,{'p_session_id':session},b)
        expect('userB denied '+action,status in (401,403))
    status,_=call('/rest/v1/rpc/pilot_read_session',{'p_session_id':session})
    expect('anonymous denied owned read',status in (401,403))
    args={'p_session_id':session,'p_operation_id':'http-fixture-1','p_max_units':100,'p_request_hash':'a'*64,'p_kind':'transcription'}
    status,data=call('/rest/v1/rpc/pilot_reserve_operation',args,a)
    expect('permitted operation reserves allowance',status==200 and data['acquired'])
    status,data=call('/rest/v1/rpc/pilot_reserve_operation',args,a)
    expect('pending retry does not dispatch',status==200 and not data['acquired'] and data['state']=='reserved')
    status,_=call('/rest/v1/rpc/pilot_reserve_operation',{**args,'p_request_hash':'b'*64},a)
    expect('same operation altered input denied',status==400)
    complete={'p_owner_id':tokens['a']['user']['id'],'p_operation_id':'http-fixture-1','p_request_hash':'a'*64,'p_used_units':70,'p_outcome':'succeeded','p_result':{'text':'Synthetic durable transcript','chunkIndex':0,'source':'microphone'},'p_transcript_text':'Synthetic durable transcript','p_source':'microphone'}
    status,_=call('/rest/v1/rpc/pilot_complete_operation',complete,a)
    expect('ordinary user cannot forge settlement',status in (401,403))
    status,data=call('/rest/v1/rpc/pilot_complete_operation',complete,config['service_key'])
    expect('trusted final transcript committed',status==200 and data['state']=='succeeded')
    status,data=call('/rest/v1/rpc/pilot_read_session',{'p_session_id':session},a)
    expect('owned final transcript reload',status==200 and len(data['events'])==1 and data['events'][0]['text']=='Synthetic durable transcript')
    sequence=data['events'][0]['pilot_sequence']
    status,data=call('/rest/v1/rpc/pilot_read_session',{'p_session_id':session,'p_after_sequence':sequence},a)
    expect('durable cursor replay has no duplicate',status==200 and data['events']==[])
    status,data=call('/rest/v1/rpc/pilot_reserve_operation',args,a)
    expect('completed operation replay returns saved result',status==200 and not data['acquired'] and data['state']=='succeeded')
    status,data=call('/rest/v1/rpc/pilot_stop_session',{'p_session_id':session},a)
    expect('owned stop acknowledged',status==200 and data['status']=='ended');ended=data['ended_at']
    status,data=call('/rest/v1/rpc/pilot_stop_session',{'p_session_id':session},a)
    expect('repeated stop idempotent',status==200 and data['ended_at']==ended)
    status,data=call('/rest/v1/rpc/pilot_delete_session',{'p_session_id':session},b)
    expect('foreign delete has no effect',status==200 and data is False)
    status,data=call('/rest/v1/rpc/pilot_delete_session',{'p_session_id':session},a)
    expect('owned delete acknowledged',status==200 and data is True)
    status,_=call('/rest/v1/rpc/pilot_read_session',{'p_session_id':session},a)
    expect('deleted session unavailable',status in (401,403))
    # Reload is via a new HTTP request/DB connection, not a process-local Map.
    evidence={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':['python3','scripts/db-test/test_local_pilot_http.py'],'exit_code':0,'checks':checks,'check_count':len(checks),'layer':'actual local GoTrue password login/JWT verification + PostgREST + unmodified002/003 on PostgreSQL17 image','provider_calls':0,'production_or_shared_mutation':False,'private_session_file':str(tokenfile),'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    out=ROOT/'review/completion-storage/local-http-acceptance.json';out.write_text(json.dumps(evidence,indent=2)+'\n')
    print(f'Pilot local HTTP acceptance passed {len(checks)} checks; fixture browser account ready. Tokens and signing keys withheld.')


if __name__=='__main__':
    try: main()
    except Exception as error:
        print(str(error) if isinstance(error,RuntimeError) else 'Local HTTP acceptance failed: '+type(error).__name__)
        raise SystemExit(1)
