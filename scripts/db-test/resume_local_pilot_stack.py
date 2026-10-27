#!/usr/bin/env python3
"""Idempotently resume only the exact owned Pilot fixture; preserve its data."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path('/private/tmp/cnp-pilot-local-stack')
PURPOSE='pilot-local-acceptance'
commands=[]


def run(args,input=None,check=True):
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    result=subprocess.run(args,input=input,text=True,capture_output=True,timeout=60)
    commands.append({'command':args,'started_at':started,'exit_code':result.returncode,
        'stdout_sha256':hashlib.sha256(result.stdout.encode()).hexdigest(),
        'stderr_sha256':hashlib.sha256(result.stderr.encode()).hexdigest(),
        'stdin_sha256':hashlib.sha256(input.encode()).hexdigest() if input is not None else None})
    if check and result.returncode:
        p=PRIVATE/'resume-errors.log'
        with p.open('a') as output:output.write(result.stdout+'\n'+result.stderr+'\n')
        p.chmod(0o600)
        raise RuntimeError('Pilot fixture lifecycle action failed; details retained privately')
    return result


def save_state(path,state):
    path.write_text(json.dumps(state,indent=2));path.chmod(0o600)


def inspect_owned(state):
    assert set(state['containers'])=={'db','auth','rest'}
    prefix=state['network']
    assert re.fullmatch(r'cnp-pilot-local-[0-9a-f]+',prefix)
    inspected={}
    # Validate every resource before starting, stopping or repairing any of them.
    for role,name in state['containers'].items():
        assert name==prefix+'-'+role
        row=json.loads(run(['docker','inspect',name]).stdout)[0]
        assert row['Config']['Labels'].get('cloudnexus.purpose')==PURPOSE
        assert row['Id']==state['container_ids'][role]
        assert prefix in row['NetworkSettings']['Networks']
        inspected[role]=row
    for name in (prefix,state.get('frontend_network')):
        assert name in (prefix,prefix+'-frontend')
        network=json.loads(run(['docker','network','inspect',name]).stdout)[0]
        assert network['Labels'].get('cloudnexus.purpose')==PURPOSE
    mount=next(row for row in inspected['db']['Mounts'] if row['Destination']=='/pilot-data')
    assert mount['Type']=='bind' and mount['Source']==str(PRIVATE/'postgres-data')
    return inspected,mount


def gateway_owned(pid):
    if not isinstance(pid,int) or pid<2:return False
    result=run(['ps','-p',str(pid),'-o','command='],check=False)
    return result.returncode==0 and str(ROOT/'scripts/db-test/local_pilot_gateway.py') in result.stdout


def main():
    statefile=PRIVATE/'stack.json';state=json.loads(statefile.read_text())
    inspected,mount=inspect_owned(state);name=state['containers']['db']
    old_id=inspected['db']['Id'];new_id=old_id;repaired=False
    command=' '.join(inspected['db']['Config'].get('Cmd',[]))
    fixed_command='if [ ! -f /pilot-data/db/PG_VERSION ]' in command
    if not fixed_command:
        if inspected['db']['State']['Status']=='running':
            raise RuntimeError('Legacy fixture database is running; stop it before a narrowly scoped restart-command repair')
        archive=PRIVATE/('lifecycle-legacy-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        archive.mkdir(mode=0o700)
        redacted=json.loads(json.dumps(inspected['db']));redacted['Config']['Env']=[item.split('=',1)[0]+'=[REDACTED]' for item in redacted['Config'].get('Env',[])]
        (archive/'inspect-redacted.json').write_text(json.dumps(redacted,indent=2));(archive/'inspect-redacted.json').chmod(0o600)
        logs=run(['docker','logs',name],check=False)
        (archive/'postgres.log').write_text(logs.stdout+logs.stderr);(archive/'postgres.log').chmod(0o600)
        run(['docker','rm',name])  # metadata only; never -v or bind-data removal
        start="if [ ! -f /pilot-data/db/PG_VERSION ]; then initdb -D /pilot-data/db --username=postgres --auth-local=trust --auth-host=scram-sha-256 >/pilot-data/init.log 2>&1 && printf '\\nhost all all 0.0.0.0/0 scram-sha-256\\n' >>/pilot-data/db/pg_hba.conf || exit 1; fi; exec postgres -D /pilot-data/db -c listen_addresses='*' -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements -c max_connections=40 -c shared_buffers=128MB"
        new_id=run(['docker','run','-d','--name',name,'--label','cloudnexus.purpose='+PURPOSE,'--network',state['network'],'--network-alias','pilot-db','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','postgres','--memory','1536m','--cpus','2','--mount',f"type=bind,source={mount['Source']},target=/pilot-data",'--tmpfs','/tmp:rw,nosuid,size=16777216','--entrypoint','/bin/bash',state['images']['postgres'],'-c',start]).stdout.strip()
        state['container_ids']['db']=new_id;save_state(statefile,state);repaired=True
    elif inspected['db']['State']['Status']!='running':
        run(['docker','start',name])
    for _ in range(50):
        if run(['docker','exec',name,'pg_isready','-h','/tmp','-U','postgres'],check=False).returncode==0:break
        time.sleep(.5)
    else:raise RuntimeError('Pilot fixture DB not ready')
    def sql(text):return run(['docker','exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'],text)
    sql('ALTER ROLE supabase_auth_admin SET search_path TO auth; ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;')
    for role in ('auth','rest'):
        if inspected[role]['State']['Status']!='running':run(['docker','start',state['containers'][role]])
    old_gateway=state.get('gateway_pid');started_gateway=False
    if not gateway_owned(old_gateway):
        probe=socket.socket();probe.settimeout(.5)
        try:occupied=probe.connect_ex(('127.0.0.1',58090))==0
        finally:probe.close()
        if occupied:raise RuntimeError('Loopback gateway port is owned by an unverified process; no takeover attempted')
        logpath=PRIVATE/'gateway.log'
        log=logpath.open('a');logpath.chmod(0o600)
        gateway=subprocess.Popen([sys.executable,str(ROOT/'scripts/db-test/local_pilot_gateway.py')],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        log.close();state['gateway_pid']=gateway.pid;save_state(statefile,state);started_gateway=True
        commands.append({'spawn':['python3','scripts/db-test/local_pilot_gateway.py'],'pid':gateway.pid,'exit_code':None})
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:58090/auth/v1/health',timeout=2) as response:
                if response.status==200:break
        except Exception:time.sleep(.5)
    else:raise RuntimeError('Pilot fixture Auth gateway not ready')
    sql("CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;")
    sql((ROOT/'packages/db/migrations/postgres/003_pilot_durable_processing.sql').read_text())
    sql("NOTIFY pgrst,'reload schema';")
    config=json.loads((PRIVATE/'private.json').read_text())
    request=urllib.request.Request('http://127.0.0.1:58090/rest/v1/',headers={'apikey':config['anon_key'],'authorization':'Bearer '+config['anon_key']})
    for _ in range(30):
        try:
            with urllib.request.urlopen(request,timeout=2) as response:
                if response.status==200:break
        except Exception:time.sleep(.5)
    else:raise RuntimeError('Pilot fixture REST gateway not ready')
    evidence={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'old_container_id':old_id,'new_container_id':new_id,
        'legacy_metadata_repaired':repaired,'same_mount_preserved':mount['Source'],'all_owned_labels_validated':True,
        'old_gateway_pid':old_gateway,'gateway_pid':state['gateway_pid'],'gateway_started':started_gateway,
        'auth_health_status':200,'rest_health_status':200,'migration003_reapplied':True,'shared_resources_changed':False,
        'commands':commands,'exit_code':0,'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    output=ROOT/'review/completion-storage/local-stack-resume.json'
    if output.exists():
        previous=json.loads(output.read_text());archive=output.with_name('local-stack-resume-'+str(time.time_ns())+'.json');archive.write_text(json.dumps(previous,indent=2)+'\n')
    output.write_text(json.dumps(evidence,indent=2)+'\n')
    print('Pilot fixture ready: auth200/rest200; same private PG data preserved; owned gateway verified; resume is idempotent.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error) if isinstance(error,RuntimeError) else 'Pilot fixture resume failed: '+type(error).__name__)
        raise SystemExit(1)
