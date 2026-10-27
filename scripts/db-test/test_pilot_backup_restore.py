#!/usr/bin/env python3
"""Real pg_dump/pg_restore proof for ONLY the labeled local Pilot fixture.

No external URLs/DB names are accepted. Raw archives and synthetic credentials
remain mode0600 outside git. Source database and unrelated sessions are retained.
"""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path('/private/tmp/cnp-pilot-local-stack')
BASE='http://127.0.0.1:58090'


def literal(value):
    return "'"+str(value).replace("'","''")+"'"


def identifier(value):
    return '"'+str(value).replace('"','""')+'"'


def main():
    config=json.loads((PRIVATE/'private.json').read_text())
    state=json.loads((PRIVATE/'stack.json').read_text())
    name=state['containers']['db']
    assert re.fullmatch(r'cnp-pilot-local-[0-9a-f]+-db',name)
    run_id=uuid.uuid4().hex
    target='pilot_restore_'+run_id[:16]
    assert re.fullmatch(r'pilot_restore_[0-9a-f]{16}',target)
    archive=PRIVATE/('pilot-backup-'+run_id+'.dump')
    container_archive='/pilot-data/pilot-backup-'+run_id+'.dump'
    bind_archive=PRIVATE/'postgres-data'/('pilot-backup-'+run_id+'.dump')
    assert not archive.exists()
    records=[];checks=[];owned=[];target_created=False;dump_created=False
    receipt={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'command':['python3','scripts/db-test/test_pilot_backup_restore.py'],
             'run_id':run_id,'source_database':'postgres','restore_database':target,
             'archive_path':str(archive),'provider_calls':0,'shared_or_production_changes':False,
             'commands':records,'checks':checks,'cleanup':{},'exit_code':1}
    out=ROOT/'review/completion-storage/backup-restore.json'

    def record_command(args,input=None,okay=True,timeout=60):
        started=datetime.datetime.now(datetime.timezone.utc).isoformat()
        result=subprocess.run(args,input=input,text=True,capture_output=True,timeout=timeout)
        records.append({'command':args,'stdin_sha256':hashlib.sha256(input.encode()).hexdigest() if input is not None else None,
                        'started_at':started,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        'exit_code':result.returncode,'stdout_sha256':hashlib.sha256(result.stdout.encode()).hexdigest(),
                        'stderr_sha256':hashlib.sha256(result.stderr.encode()).hexdigest()})
        if okay and result.returncode:
            # Diagnostics may contain schema metadata; retain only privately.
            errorfile=PRIVATE/('backup-restore-'+run_id+'-error.log')
            errorfile.write_text(result.stdout+'\n'+result.stderr);errorfile.chmod(0o600)
            raise RuntimeError('Local backup command failed; private diagnostics retained')
        return result

    def check(label,condition):
        if not condition:raise RuntimeError('Backup/restore assertion failed: '+label)
        checks.append(label)

    def http(path,body=None,token=None,method='POST',service=False):
        key=config['service_key'] if service else config['anon_key']
        headers={'apikey':key,'authorization':'Bearer '+(token or key)}
        if body is not None:headers['content-type']='application/json'
        req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
        try:
            with urllib.request.urlopen(req,timeout=10) as response:status=response.status;data=response.read(2_000_000)
        except urllib.error.HTTPError as error:status=error.code;data=error.read(65536)
        # Record no API keys, bearer tokens, passwords or response payloads.
        records.append({'http_method':method,'path':path.split('?')[0],'status':status})
        return status,json.loads(data) if data else None

    def sql(text,owner=None,role=None,okay=True):
        prefix=''
        if owner is not None:
            claims=json.dumps({'sub':str(uuid.UUID(owner)),'role':'authenticated'})
            prefix+='SELECT set_config(\'request.jwt.claims\','+literal(claims)+',false);'
        if role is not None:
            assert role in ('authenticated','anon')
            prefix+='SET ROLE '+identifier(role)+';'
        args=['docker','exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','--dbname',target]
        return record_command(args,prefix+text,okay=okay)

    def owned_session(token):
        session=str(uuid.uuid4())
        status,data=http('/rest/v1/rpc/pilot_create_session',{'p_session_id':session,'p_mode':'general','p_consent_version':'local-backup-restore-v1'},token)
        check('owned fixture session created '+str(len(owned)+1),status==200 and data.get('id')==session)
        owned.append(session)
        return session

    def final_event(token,owner,session,index,text,units):
        operation='backup:'+run_id+':'+str(index)
        digest=hashlib.sha256(text.encode()).hexdigest()
        args={'p_session_id':session,'p_operation_id':operation,'p_max_units':units,'p_request_hash':digest,'p_kind':'transcription'}
        for _ in range(20):
            status,data=http('/rest/v1/rpc/pilot_reserve_operation',args,token)
            if status==200 and data.get('state')=='concurrency_exceeded':time.sleep(.1);continue
            break
        check('bounded fixture operation acquired '+str(index),status==200 and data.get('acquired') is True)
        result={'text':text,'chunkIndex':index,'source':'microphone','segments':[]}
        status,data=http('/rest/v1/rpc/pilot_complete_operation',{'p_owner_id':owner,'p_operation_id':operation,
            'p_request_hash':digest,'p_used_units':units,'p_outcome':'succeeded','p_result':result,
            'p_transcript_text':text,'p_source':'microphone'},service=True)
        check('trusted fixture final committed '+str(index),status==200 and data.get('state')=='succeeded')

    try:
        inspected=json.loads(record_command(['docker','inspect',name]).stdout)[0]
        check('exact fixture container ID',inspected['Id']==state['container_ids']['db'])
        check('exact fixture label',inspected['Config']['Labels'].get('cloudnexus.purpose')=='pilot-local-acceptance')
        check('source fixture database running',inspected['State']['Status']=='running')
        receipt['source_container_id']=inspected['Id'];receipt['postgres_image']=inspected['Config']['Image']
        people={}
        for actor in ('a','b'):
            status,login=http('/auth/v1/token?grant_type=password',{'email':config['email_'+actor],'password':config['user_password']})
            check(actor+' actual GoTrue signin',status==200 and bool(login.get('access_token')))
            status,user=http('/auth/v1/user',token=login['access_token'],method='GET')
            check(actor+' principal verified',status==200 and user.get('id')==login['user']['id'])
            people[actor]={'id':str(uuid.UUID(user['id'])),'token':login['access_token']}
        a,b=people['a'],people['b']
        source=owned_session(a['token'])
        texts=['Synthetic backup reference one.','Synthetic backup reference two.']
        final_event(a['token'],a['id'],source,1,texts[0],64)
        final_event(a['token'],a['id'],source,2,texts[1],64)
        deleted=owned_session(a['token'])
        final_event(a['token'],a['id'],deleted,3,'Synthetic deleted backup reference.',32)
        status,result=http('/rest/v1/rpc/pilot_delete_session',{'p_session_id':deleted},a['token'])
        check('separate owned deleted fixture removed before dump',status==200 and result is True)
        owned.remove(deleted)
        receipt['fixture_session_id']=source;receipt['deleted_fixture_id']=deleted;receipt['fixture_settled_units']=160
        # Custom archive is written inside the exact local fixture, never binary
        # stdout. pg_dump uses one consistent source snapshot and does not stop
        # source writes or alter source schema/database state.
        dump_created=True
        record_command(['docker','exec',name,'/bin/sh','-c',
                        'umask 077; exec pg_dump --host /tmp --username postgres --dbname postgres --format=custom --no-password --file "$1"',
                        'pilot-owned-dump',container_archive])
        # Docker cp cannot archive tmpfs files reliably. Use the already private
        # bind mount; copy bytes directly to a newly created mode0600 file.
        fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as output,bind_archive.open('rb') as source_file:
            while True:
                chunk=source_file.read(1024*1024)
                if not chunk:break
                output.write(chunk)
        records.append({'local_binary_copy_from':str(bind_archive),'to':str(archive),'exit_code':0})
        receipt['archive_bytes']=archive.stat().st_size
        receipt['archive_sha256']=hashlib.sha256(archive.read_bytes()).hexdigest()
        receipt['archive_mode']=oct(archive.stat().st_mode&0o777)
        check('nonempty protected archive',receipt['archive_bytes']>0 and receipt['archive_mode']=='0o600')
        record_command(['docker','exec',name,'createdb','--host','/tmp','--username','postgres','--template','template0',target])
        target_created=True
        record_command(['docker','exec',name,'pg_restore','--host','/tmp','--username','postgres','--dbname',target,
                        '--exit-on-error','--no-password',container_archive])
        result=sql('SELECT public.pilot_read_session('+literal(source)+',0);',a['id'],'authenticated')
        snapshot=json.loads(result.stdout.strip().splitlines()[-1])
        check('restored owner retained',snapshot['session']['user_id']==a['id'])
        check('restored final text order', [event['text'] for event in snapshot['events']]==texts)
        sequences=[event['pilot_sequence'] for event in snapshot['events']]
        check('restored final unique ordered identities',len(set(sequences))==2 and sequences==sorted(sequences))
        cursor=sql('SELECT public.pilot_read_session('+literal(source)+','+str(sequences[0])+');',a['id'],'authenticated')
        check('restored cursor resumes only later event',[event['text'] for event in json.loads(cursor.stdout.strip().splitlines()[-1])['events']]==texts[1:])
        denial=sql('SELECT public.pilot_read_session('+literal(source)+',0);',b['id'],'authenticated',okay=False)
        check('restored userB denied userA session',denial.returncode!=0 and 'session_unavailable' in denial.stderr)
        denial=sql('SELECT public.pilot_read_session('+literal(source)+',0);',role='anon',okay=False)
        check('restored anonymous denied',denial.returncode!=0)
        absent=sql('SELECT count(*) FROM public.interview_sessions WHERE id='+literal(deleted)+';')
        check('deleted fixture session absent from restore',absent.stdout.strip()=='0')
        absent=sql('SELECT count(*) FROM public.transcript_segments WHERE interview_session_id='+literal(deleted)+';')
        check('deleted fixture final event absent from restore',absent.stdout.strip()=='0')
        status,live=http('/rest/v1/rpc/pilot_read_session',{'p_session_id':source},a['token'])
        check('source owned fixture remains readable during restoration',status==200 and len(live.get('events',[]))==2)
        receipt['exit_code']=0
        receipt['retained']='Owned session metadata, ordered final transcript events/provider results, operation/quota state, actual auth records and schema at the consistent fixture snapshot.'
        receipt['not_retained']='Raw audio was never stored. Writes committed to the source after the dump snapshot are intentionally not part of this archive. No zero-loss or production RPO claim.'
        receipt['restored_identity_scope']='Actual GoTrue verified synthetic user IDs; restored DB assertions use authenticated/anon database roles and explicit JWT claims, not a separate restored GoTrue HTTP service.'
    finally:
        if target_created:
            result=record_command(['docker','exec',name,'dropdb','--host','/tmp','--username','postgres',target],okay=False)
            receipt['cleanup']['temporary_restored_database_dropped']=result.returncode==0
            if result.returncode:receipt['exit_code']=1
        for session in owned:
            if 'people' in locals() and 'a' in people:
                try:
                    status,result=http('/rest/v1/rpc/pilot_delete_session',{'p_session_id':session},people['a']['token'])
                    receipt['cleanup']['owned_source_fixture_deleted']=status==200 and result is True
                    if not receipt['cleanup']['owned_source_fixture_deleted']:receipt['exit_code']=1
                except Exception:receipt['cleanup']['owned_source_fixture_deleted']=False;receipt['exit_code']=1
        if dump_created:
            result=record_command(['docker','exec',name,'/bin/rm','-f','--',container_archive],okay=False)
            receipt['cleanup']['container_archive_copy_removed']=result.returncode==0
            if result.returncode:receipt['exit_code']=1
        receipt['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt['script_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        out.write_text(json.dumps(receipt,indent=2)+'\n')
    if receipt['exit_code']:raise RuntimeError('Backup restoration or fixture cleanup remains incomplete')
    print('Pilot backup/restore verified '+str(len(checks))+' checks. Archive retained privately; only the temporary restored DB and this run\'s owned source fixtures removed.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error) if isinstance(error,RuntimeError) else 'Pilot backup/restore stopped: '+type(error).__name__)
        raise SystemExit(1)
