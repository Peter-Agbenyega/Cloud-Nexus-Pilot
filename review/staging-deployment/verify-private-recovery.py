"""Verify only this run's retained synthetic session after guest container restart."""
from pathlib import Path
import datetime,json,urllib.request,urllib.error
private=Path('/private/tmp/cnp-pilot-local-stack/staging')
s=json.loads((private/'acceptance-state.json').read_text());checks=[]
def call(name,token):
 req=urllib.request.Request('http://127.0.0.1:58192/rpc/'+name,data=json.dumps({'p_session_id':s['session']}).encode(),headers={'authorization':'Bearer '+token,'content-type':'application/json'},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=12) as r:status=r.status;body=r.read(1048576)
 except urllib.error.HTTPError as e:status=e.code;body=e.read(65536)
 return status,json.loads(body) if body else None
def expect(name,ok):
 if not ok:raise RuntimeError(name)
 checks.append(name)
try:
 a=s['users']['a']['token'];b=s['users']['b']['token']
 status,data=call('pilot_read_session',a)
 expect('pre-restart token still verifies',status==200)
 expect('final event survived restart without duplication',len(data['events'])==s['expected_events'])
 expect('ended state survived restart',data['session']['status']=='ended' and data['session']['ended_at']==s['ended_at'])
 status,_=call('pilot_read_session',b);expect('cross-account denied after restart',status in (401,403))
 status,data=call('pilot_delete_session',b);expect('foreign deletion no effect',status==200 and data is False)
 status,data=call('pilot_delete_session',a);expect('owned deletion succeeds',status==200 and data is True)
 status,_=call('pilot_read_session',a);expect('deleted session unavailable',status in (401,403))
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'guest_id':215,'guest_ip':'192.168.68.54','checks':checks,'exit_code':0,'layer':'Private guest DB/Auth/REST restart with retained verified user token; synthetic fixture only','provider_calls':0,'frontend_export_verified':False,'public_acceptance_verified':False}
 Path(__file__).with_name('private-recovery-acceptance.json').write_text(json.dumps(report,indent=2)+'\n');print('Private guest restart/delete checks passed:',len(checks))
except Exception as e:print('Sanitized recovery failure:',str(e) if isinstance(e,RuntimeError) else type(e).__name__);raise SystemExit(1)
