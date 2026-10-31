#!/usr/bin/env python3
"""Create/reuse only known synthetic accounts in the separately approved stack."""
from pathlib import Path
import json, urllib.request, urllib.error


def main():
    p=Path.home()/'.local/share/cloud-nexus-pilot/recovery-test'
    c=json.loads((p/'private.json').read_text());base='http://127.0.0.1:59090';out={}
    def call(path,body=None,key=None):
        k=key or c['anon_key']
        r=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'apikey':k,'authorization':'Bearer '+k,'content-type':'application/json'})
        try:
            with urllib.request.urlopen(r,timeout=10) as v:
                raw=v.read();return v.status,json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            return error.code,None
    assert call('/rest/v1/')[0]==200
    for label in ['a','b','browser']:
        credentials={'email':c['email_'+label],'password':c['user_password']}
        status,data=call('/auth/v1/token?grant_type=password',credentials)
        if status!=200:
            assert call('/auth/v1/signup',credentials)[0] in (200,422)
            status,data=call('/auth/v1/token?grant_type=password',credentials)
        assert status==200 and data['user']['id'];out[label]=data
        status,_=call('/rest/v1/rpc/pilot_set_allowance',{'p_owner_id':data['user']['id'],'p_granted_units':20000000,'p_max_concurrency':2},c['service_key'])
        assert status in (200,204)
    f=p/'sessions.json';f.write_text(json.dumps(out));f.chmod(0o600)
    print('PASS: REST200; three synthetic authenticated accounts; bounded allowances; protected sessions')


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Recovery account setup failed: '+type(error).__name__)
        raise SystemExit(1)
