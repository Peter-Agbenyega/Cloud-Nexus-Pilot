"""Private Pilot guest HTTP acceptance with explicitly provisioned synthetic users; no provider calls."""
from pathlib import Path
import base64,datetime,hashlib,hmac,json,secrets,time,urllib.request,urllib.error,uuid
PRIVATE=Path('/private/tmp/cnp-pilot-local-stack/staging')
REPORT=Path(__file__).with_name('private-backend-acceptance.json')
def main():
    signing=json.loads((PRIVATE/'secrets.json').read_text())['jwt']
    def jwt(role):
        enc=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).decode().rstrip('=')
        body=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'role':role,'iss':'pilot-staging','iat':int(time.time()),'exp':int(time.time())+600})
        return body+'.'+base64.urlsafe_b64encode(hmac.new(signing.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    anon=jwt('anon');admin=jwt('service_role');checks=[]
    def call(service,path,body=None,token=anon,method='POST'):
        headers={'apikey':anon,'authorization':'Bearer '+token,'content-type':'application/json'}
        req=urllib.request.Request('http://127.0.0.1:'+str(58191 if service=='auth' else 58192)+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
        try:
            with urllib.request.urlopen(req,timeout=12) as r:status=r.status;raw=r.read(1048576)
        except urllib.error.HTTPError as e:status=e.code;raw=e.read(65536)
        return status,json.loads(raw) if raw else None
    def expect(name,condition):
        if not condition:raise RuntimeError('Check failed: '+name)
        checks.append(name)
    run=uuid.uuid4().hex[:12];users={}
    for who in ['a','b']:
        email=f'pilot.staging.{run}.{who}@pilot.test';password=secrets.token_urlsafe(24)
        status,user=call('auth','/admin/users',{'email':email,'password':password,'email_confirm':True},admin)
        expect(who+' admin-provisioned isolated test identity',status in (200,201))
        status,data=call('auth','/token?grant_type=password',{'email':email,'password':password})
        expect(who+' real password sign-in',status==200 and bool(data.get('access_token')))
        users[who]={'email':email,'password':password,'token':data['access_token'],'id':data['user']['id']}
        recovery=PRIVATE/('acceptance-'+run+'.json');recovery.write_text(json.dumps({'users':users}));recovery.chmod(0o600)
        status,user=call('auth','/user',token=data['access_token'],method='GET')
        expect(who+' verified identity',status==200 and user['id']==users[who]['id'])
    a=users['a']['token'];b=users['b']['token'];session=str(uuid.uuid4())
    def rpc(name,body,token):return call('rest','/rpc/'+name,body,token)
    status,data=rpc('pilot_create_session',{'p_session_id':session,'p_mode':'general','p_consent_version':'private-staging-synthetic-v1'},a)
    expect('owned session creation',status==200 and data['user_id']==users['a']['id'])
    for op in ['pilot_read_session','pilot_stop_session']:
        status,_=rpc(op,{'p_session_id':session},b);expect('cross-account denied '+op,status in (401,403))
    status,_=rpc('pilot_read_session',{'p_session_id':session},anon);expect('anonymous owned read denied',status in (401,403))
    args={'p_session_id':session,'p_operation_id':'staging-'+run,'p_max_units':100,'p_request_hash':'a'*64,'p_kind':'transcription'}
    status,data=rpc('pilot_reserve_operation',args,a);expect('no allowance blocks work',status==200 and data.get('acquired') is False and data.get('state')=='quota_exhausted')
    status,_=rpc('pilot_set_allowance',{'p_owner_id':users['a']['id'],'p_granted_units':1000,'p_max_concurrency':1},admin);expect('bounded test allowance',status in (200,204))
    status,data=rpc('pilot_reserve_operation',args,a);expect('permitted operation reserved',status==200 and data['acquired'])
    status,data=rpc('pilot_reserve_operation',args,a);expect('retry does not redispatch',status==200 and not data['acquired'])
    complete={'p_owner_id':users['a']['id'],'p_operation_id':args['p_operation_id'],'p_request_hash':'a'*64,'p_used_units':70,'p_outcome':'succeeded','p_result':{'text':'Synthetic staging persistence fixture','chunkIndex':0,'source':'microphone'},'p_transcript_text':'Synthetic staging persistence fixture','p_source':'microphone'}
    status,_=rpc('pilot_complete_operation',complete,a);expect('user cannot forge settlement',status in (401,403))
    status,data=rpc('pilot_complete_operation',complete,admin);expect('trusted synthetic final committed',status==200 and data['state']=='succeeded')
    status,data=rpc('pilot_read_session',{'p_session_id':session},a);expect('durable owned reload',status==200 and len(data['events'])==1)
    status,data=rpc('pilot_complete_operation',complete,admin);expect('repeat settlement safe',status==200)
    status,data=rpc('pilot_read_session',{'p_session_id':session},a);expect('one final after repeated settlement',status==200 and len(data['events'])==1)
    status,data=rpc('pilot_stop_session',{'p_session_id':session},a);expect('owned stop',status==200 and data['status']=='ended');ended=data['ended_at']
    status,data=rpc('pilot_stop_session',{'p_session_id':session},a);expect('idempotent stop',status==200 and data['ended_at']==ended)
    status,data=rpc('pilot_delete_session',{'p_session_id':session},b);expect('cross-account deletion has no effect',status==200 and data is False)
    state={'users':users,'session':session,'expected_events':1,'ended_at':ended}
    p=PRIVATE/'acceptance-state.json';p.write_text(json.dumps(state));p.chmod(0o600)
    report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'guest_id':215,'guest_ip':'192.168.68.54','checks':checks,'check_count':len(checks),'exit_code':0,'layer':'Private guest GoTrue/PostgREST/PostgreSQL via loopback SSH forwards; synthetic identities and final text','provider_calls':0,'physical_audio_verified':False,'public_routing_enabled':False,'restore_or_restart_verified':False}
    REPORT.write_text(json.dumps(report,indent=2)+'\n');print('Private guest checks passed:',len(checks))
if __name__=='__main__':
    try:main()
    except Exception as e:print(str(e) if isinstance(e,RuntimeError) else 'Sanitized failure: '+type(e).__name__);raise SystemExit(1)
