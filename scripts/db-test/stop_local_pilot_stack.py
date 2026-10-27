#!/usr/bin/env python3
"""Stop only validated Pilot fixture processes; preserve PG data and config."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path('/private/tmp/cnp-pilot-local-stack')
commands=[]


def run(args,check=True):
    result=subprocess.run(args,text=True,capture_output=True,timeout=60)
    commands.append({'command':args,'exit_code':result.returncode,'stdout_sha256':hashlib.sha256(result.stdout.encode()).hexdigest(),'stderr_sha256':hashlib.sha256(result.stderr.encode()).hexdigest()})
    if check and result.returncode:raise RuntimeError('Pilot fixture stop action failed')
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--remove-container-metadata',action='store_true');args=parser.parse_args()
    state=json.loads((PRIVATE/'stack.json').read_text());prefix=state['network']
    assert re.fullmatch(r'cnp-pilot-local-[0-9a-f]+',prefix) and set(state['containers'])=={'db','auth','rest'}
    for role,name in state['containers'].items():
        data=json.loads(run(['docker','inspect',name]).stdout)[0]
        assert name==prefix+'-'+role and data['Config']['Labels'].get('cloudnexus.purpose')=='pilot-local-acceptance'
        assert data['Id']==state['container_ids'][role] and prefix in data['NetworkSettings']['Networks']
        if role=='db':
            mount=next(item for item in data['Mounts'] if item['Destination']=='/pilot-data')
            assert mount['Source']==str(PRIVATE/'postgres-data') and mount['Type']=='bind'
    pid=state.get('gateway_pid');gateway_stopped=False
    if isinstance(pid,int) and pid>1:
        process=run(['ps','-p',str(pid),'-o','command='],check=False)
        if process.returncode==0 and str(ROOT/'scripts/db-test/local_pilot_gateway.py') in process.stdout:
            os.kill(pid,signal.SIGTERM)
            for _ in range(30):
                process=run(['ps','-p',str(pid),'-o','command='],check=False)
                if process.returncode or str(ROOT/'scripts/db-test/local_pilot_gateway.py') not in process.stdout:gateway_stopped=True;break
                time.sleep(.1)
            if not gateway_stopped:raise RuntimeError('Owned gateway did not stop; no broad process kill attempted')
        else:gateway_stopped=True  # Original owned gateway already absent; unrelated PID untouched.
    for role in ('auth','rest','db'):
        name=state['containers'][role];run(['docker','stop',name])
        if args.remove_container_metadata:run(['docker','rm',name])  # no -v, no data deletion
    if args.remove_container_metadata:
        for name in (state.get('frontend_network'),prefix):
            if not name:continue
            data=json.loads(run(['docker','network','inspect',name]).stdout)[0]
            assert data['Labels'].get('cloudnexus.purpose')=='pilot-local-acceptance' and not data['Containers']
            run(['docker','network','rm',name])
    evidence={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':0,'all_owned_labels_validated':True,
        'container_ids':state['container_ids'],'gateway_pid':pid,'owned_gateway_stopped':gateway_stopped,
        'container_metadata_removed':args.remove_container_metadata,'private_data_preserved':True,'private_configuration_preserved':True,
        'commands':commands,'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (ROOT/'review/completion-storage/local-stack-stop.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print('Only owned Pilot fixture processes stopped. Private PG data and configuration preserved.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error) if isinstance(error,RuntimeError) else 'Pilot fixture stop failed: '+type(error).__name__)
        raise SystemExit(1)
