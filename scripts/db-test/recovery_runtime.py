#!/usr/bin/env python3
"""Start/reload ONLY the separately approved synthetic recovery runtime."""
from pathlib import Path
import json, os, signal, socket, subprocess, sys, time
P=Path.home()/'.local/share/cloud-nexus-pilot/recovery-test'
R=Path(json.loads((P/'runtime.json').read_text()).get('checkout',str(Path.home()/'Cloud-Nexus-Pilot-recovery-acceptance')))
assert R in (Path.home()/'Cloud-Nexus-Pilot-recovery-acceptance',Path.home()/'Cloud-Nexus-Pilot-voice-investigation')
NODE='/opt/homebrew/opt/node@22/bin/node'


def main(mode):
    assert mode in ('normal','expired','provider','gateway')
    if mode=='gateway':
        stack=json.loads((P/'stack.json').read_text());pid=stack['gateway_pid']
        command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
        assert 'scripts/db-test/local_pilot_gateway.py' in command
        assert pid != json.loads(Path('/private/tmp/cnp-pilot-local-stack/stack.json').read_text())['gateway_pid']
        os.kill(pid,signal.SIGTERM)
        for _ in range(40):
            with socket.socket() as sock:free=sock.connect_ex(('127.0.0.1',59090))!=0
            if free:break
            time.sleep(.25)
        assert free
        fd=os.open(P/'gateway.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
        with os.fdopen(fd,'a') as log:
            child=subprocess.Popen([sys.executable,str(R/'scripts/db-test/local_pilot_gateway.py')],cwd=R,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'PILOT_RECOVERY_STACK':'1'})
        stack['gateway_pid']=child.pid;(P/'stack.json').write_text(json.dumps(stack,indent=2));(P/'stack.json').chmod(0o600)
        print('Recovery gateway moved to durable runtime source')
        return
    state=json.loads((P/'runtime.json').read_text())
    role='provider' if mode=='provider' else 'application'
    pid=state[role]
    command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
    assert str(P/'pilot.env') in command or str(P/'expired.env') in command
    assert ('provider-fixture.mjs' if role=='provider' else 'local.mjs') in command
    os.kill(pid,signal.SIGTERM)
    ports=[59093] if role=='provider' else [43101,43310]
    for _ in range(40):
        free=True
        for port in ports:
            with socket.socket() as sock:free &= sock.connect_ex(('127.0.0.1',port))!=0
        if free:break
        time.sleep(.25)
    assert free, 'Refuse duplicate consumer'
    env=P/'pilot.env'
    if mode=='expired':
        # Fail-closed temporal preflight test; no valid signature is claimed.
        import base64
        token='test.'+base64.urlsafe_b64encode(json.dumps({'role':'service_role','exp':1}).encode()).decode().rstrip('=')+'.invalid'
        path=P/'expired.env'
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as output:output.write('\n'.join('PILOT_PROCESSING_SERVICE_KEY='+token if x.startswith('PILOT_PROCESSING_SERVICE_KEY=') else x for x in env.read_text().splitlines())+'\n')
        env=path
    args=[NODE,'--env-file='+str(env), 'scripts/pilot/provider-fixture.mjs' if role=='provider' else 'scripts/pilot/local.mjs']
    if role=='application':args+=['start']
    fd=os.open(P/(role+'.log'),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    with os.fdopen(fd,'a') as log:child=subprocess.Popen(args,cwd=R,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    state[role]=child.pid
    (P/'runtime.json').write_text(json.dumps(state));(P/'runtime.json').chmod(0o600)
    for _ in range(40):
        ready=True
        for port in ports:
            with socket.socket() as sock:ready &= sock.connect_ex(('127.0.0.1',port))==0
        if ready:break
        time.sleep(.25)
    assert ready
    print('Recovery-only runtime ready: '+mode)


if __name__=='__main__':
    try:main(sys.argv[1])
    except Exception as error:
        print('Recovery runtime stopped: '+type(error).__name__)
        raise SystemExit(1)
