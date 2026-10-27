#!/usr/bin/env python3
"""Actual Caddy parsing and HTTP denials in a network-disabled disposable container."""
from pathlib import Path
import json
import secrets
import subprocess
import time

ROOT=Path(__file__).resolve().parents[3]
IMAGE='caddy@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489'
name='pilot-caddy-test-'+secrets.token_hex(6)
base=['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges','--tmpfs','/config','--tmpfs','/data','-v',str(ROOT/'ops/pilot/Caddyfile')+':/etc/caddy/Caddyfile:ro']


def run(args,check=True):
    r=subprocess.run(args,text=True,capture_output=True,timeout=30)
    if check and r.returncode:raise RuntimeError('Caddy rehearsal command failed: '+r.stderr[:300])
    return r


selectors=['-e','PILOT_IDENTITY_HOST=identity.pilot.example.invalid','-e','PILOT_REALTIME_HOST=realtime.pilot.example.invalid','-e','PILOT_WEB_ORIGIN=https://pilot.example.invalid']
adapted=run([*base,*selectors,IMAGE,'caddy','adapt','--validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
json.loads(adapted.stdout)
container=None
try:
    selectors=['-e','PILOT_IDENTITY_HOST=http://127.0.0.1:8080','-e','PILOT_REALTIME_HOST=http://127.0.0.1:8081','-e','PILOT_WEB_ORIGIN=https://pilot.example.invalid']
    container=run([*base,'-d','--name',name,'--label','cloudnexus.purpose=pilot-preparation-test',*selectors,IMAGE]).stdout.strip()
    def request(path,origin=None,method='GET'):
        # Busybox wget runs INSIDE the network-none container; no host listener.
        command=['docker','exec',container,'wget','-S','-O','/dev/null','--timeout=2']
        if origin:command+=['--header','Origin: '+origin]
        if method=='POST':command+=['--post-data','']
        elif method=='OPTIONS':
            # BusyBox wget has no arbitrary method; use its bundled netcat.
            text=f'OPTIONS {path} HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nOrigin: {origin}\r\nConnection: close\r\n\r\n'
            r=subprocess.run(['docker','exec','-i',container,'nc','-w','2','127.0.0.1','8080'],input=text,text=True,capture_output=True,timeout=5)
            return r.stdout
        r=run([*command,'http://127.0.0.1:8080'+path],check=False)
        return r.stderr
    for _ in range(20):
        if '404' in request('/unknown'):break
        time.sleep(.1)
    else:raise RuntimeError('Isolated test listener not ready')
    cases=[('/rest/v1/interview_sessions','https://foreign.example.invalid','GET','403'),('/auth/v1/token','https://foreign.example.invalid','POST','403'),('/auth/v1/admin/users',None,'GET','404'),('/auth/v1/admin/users','https://pilot.example.invalid','GET','404'),('/rest/v1/interview_sessions','https://pilot.example.invalid','OPTIONS','204'),('/rest/v1/interview_sessions','https://foreign.example.invalid','OPTIONS','403')]
    for path,origin,method,code in cases:
        result=request(path,origin,method)
        assert code in result, f'Expected safe status{code}, got '+result[:150]
    print(json.dumps({'passed':True,'image':IMAGE,'adapt_and_validate_exit':adapted.returncode,'http_denials_passed':len(cases),'network':'none, no host ports','note':'HTTPS config parsing and real local HTTP routing only; no public DNS/certificate or hosted TLS qualification.'},indent=2))
finally:
    if container:
        assert run(['docker','inspect','--format','{{index .Config.Labels "cloudnexus.purpose"}}',container]).stdout.strip()=='pilot-preparation-test'
        run(['docker','rm','-f',container])
