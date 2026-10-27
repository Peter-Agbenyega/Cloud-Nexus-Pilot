#!/usr/bin/env python3
"""Disposable network-disabled PostgreSQL rehearsal. No existing DB is targeted."""
from pathlib import Path
import hashlib
import json
import secrets
import subprocess
import time
import tempfile

ROOT=Path(__file__).resolve().parents[3]
IMAGE='supabase/postgres@sha256:be60aee15997daca475b710b734bc6bfe52cd544dcd7e9fd2ff58210b6747d83'
name='pilot-preparation-test-'+secrets.token_hex(6)
container=None
auth_container=None
steps=[]


def run(args,input=None,check=True):
    result=subprocess.run(args,input=input,text=True,capture_output=True,timeout=60)
    if check and result.returncode:
        # Private generated passwords are never part of error payloads.
        raise RuntimeError('Rehearsal command failed: '+args[0]+'; exit '+str(result.returncode))
    return result


def sql(text,db='pilot'):
    return run(['docker','exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d',db],text).stdout.strip()


try:
    with tempfile.TemporaryDirectory(prefix='pilot-raw-env-') as temporary:
        directory=Path(temporary)
        (directory/'raw.env').write_text('SYNTHETIC_CONFIG=literal-$MUST_NOT_EXPAND\n')
        (directory/'raw.env').chmod(0o600)
        config={'name':name+'-env','services':{'check':{'image':IMAGE,'network_mode':'none','read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'env_file':[{'path':str(directory/'raw.env'),'format':'raw'}],'entrypoint':['/bin/sh','-c'], 'command':["test \"$$SYNTHETIC_CONFIG\" = 'literal-$$MUST_NOT_EXPAND'"]}}}
        (directory/'compose.json').write_text(json.dumps(config))
        run(['docker','compose','-f',str(directory/'compose.json'),'run','--rm','--no-deps','check'])
    steps.append('actual raw-env container preserves literal dollar bytes without interpolation')
    container=run(['docker','run','-d','--name',name,'--label','cloudnexus.purpose=pilot-preparation-test','--network','none','--user','postgres','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1g','--tmpfs','/pilot-data:mode=1777,size=268435456','--tmpfs','/tmp:mode=1777,size=67108864','-v',str(ROOT/'ops/pilot')+':/opt/pilot:ro','-v',str(ROOT/'packages/db/migrations/postgres')+':/migrations:ro','-e','POSTGRES_PASSWORD='+secrets.token_hex(32),'--entrypoint','/bin/bash',IMAGE,'/opt/pilot/start-postgres.sh']).stdout.strip()
    for _ in range(80):
        if run(['docker','exec',container,'pg_isready','-h','/tmp','-U','postgres','-d','postgres'],check=False).returncode==0:break
        time.sleep(.25)
    else:raise RuntimeError('Disposable database did not become ready')
    steps.append('new isolated PostgreSQL17 initialized via proposed production entrypoint; no ports/network')
    auth_password=secrets.token_hex(32)
    env=['-e','PILOT_AUTH_DB_PASSWORD='+auth_password,'-e','PILOT_REST_DB_PASSWORD='+secrets.token_hex(32)]
    run(['docker','exec',*env,container,'psql','-Xq','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres','-f','/opt/pilot/bootstrap.sql'])
    assert sql("SELECT rolcreaterole OR rolsuper OR rolbypassrls FROM pg_roles WHERE rolname='supabase_auth_admin'")=='f'
    assert sql("SELECT bool_and(NOT rolcanlogin) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")=='t'
    steps.append('fresh dedicated pilot database and separated non-superuser auth/REST roles; no public role can login')
    # Exercise real compatible Auth schema migration with the restricted role.
    auth_values={'GOTRUE_API_HOST':'0.0.0.0','GOTRUE_API_PORT':'9999','API_EXTERNAL_URL':'http://127.0.0.1:9999','GOTRUE_SITE_URL':'http://127.0.0.1:3100','GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':'postgres://supabase_auth_admin:'+auth_password+'@127.0.0.1:5432/pilot?sslmode=disable','GOTRUE_JWT_SECRET':secrets.token_hex(32),'GOTRUE_JWT_AUD':'authenticated','GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated','GOTRUE_DISABLE_SIGNUP':'true','GOTRUE_EXTERNAL_EMAIL_ENABLED':'true','GOTRUE_MAILER_AUTOCONFIRM':'false','GOTRUE_LOG_LEVEL':'error'}
    auth_env=[]
    for key,value in auth_values.items():auth_env+=['-e',key+'='+value]
    auth_container=run(['docker','run','-d','--name',name+'-auth','--label','cloudnexus.purpose=pilot-preparation-test','--network','container:'+container,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:size=16777216',*auth_env,'supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b']).stdout.strip()
    for _ in range(60):
        health=run(['docker','exec',auth_container,'wget','-qO-','http://127.0.0.1:9999/health'],check=False)
        if health.returncode==0:break
        time.sleep(.25)
    else:raise RuntimeError('Restricted-role isolated Auth did not become healthy')
    assert sql("SELECT to_regclass('auth.users') IS NOT NULL")=='t'
    assert sql("SELECT rolcreaterole OR rolsuper OR rolbypassrls FROM pg_roles WHERE rolname='supabase_auth_admin'")=='f'
    steps.append('real GoTrue schema migration and health200 with restricted auth role, signup disabled, no external network')
    migration=['docker','exec','-e','PGHOST=/tmp','-e','PGUSER=postgres','-e','PGDATABASE=pilot','-e','PGPASSWORD=synthetic-unused-peer',container,'/bin/bash','/opt/pilot/migrate.sh']
    run(migration)
    before=sql('SELECT string_agg(name||sha256,\',\' ORDER BY name) FROM pilot_ops.migrations')
    run(migration);assert sql('SELECT string_agg(name||sha256,\',\' ORDER BY name) FROM pilot_ops.migrations')==before
    assert sql('SELECT count(*) FROM pilot_ops.migrations')=='2'
    assert sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('interview_sessions','transcript_segments','pilot_usage_accounts','pilot_processing_operations')")=='t'
    assert sql('SELECT count(*) FROM public.pilot_usage_accounts')=='0'
    steps.append('full002+003 applied, checksum receipts identical on repeat; ownership RLS enabled; no automatic usage grants')
    assert sql("SELECT has_function_privilege('authenticated','public.pilot_set_allowance(uuid,bigint,integer)','EXECUTE')")=='f'
    assert sql("SELECT has_function_privilege('service_role','public.pilot_set_allowance(uuid,bigint,integer)','EXECUTE')")=='t'
    assert sql("SELECT has_table_privilege('authenticated','public.interview_sessions','TRUNCATE')")=='f'
    assert sql("SELECT has_schema_privilege('authenticated','pilot_ops','USAGE')")=='f'
    assert sql("SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='auth.uid()'::regprocedure")=='supabase_auth_admin'
    subject='11111111-1111-4111-8111-111111111111'
    assert sql("BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims','{\"sub\":\""+subject+"\"}',true); SELECT auth.uid(); ROLLBACK;").splitlines()[-1]==subject
    steps.append('service-only quota grant, migration ledger privacy, truncate denial and identity function ownership verified')
    sql("UPDATE pilot_ops.migrations SET sha256=repeat('0',64) WHERE name='002_cloud_nexus_pilot_interviews.sql'")
    assert run(migration,check=False).returncode!=0
    steps.append('changed applied checksum is refused before SQL reapplication')
    assert sql("SELECT pg_read_file('/tmp/pilot-init-password',0,1,true) IS NULL")=='t'
    print(json.dumps({'passed':True,'image':IMAGE,'layer':'disposable PostgreSQL bootstrap/migration, not production identity or hosted acceptance','steps':steps,'files':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT/'ops/pilot/bootstrap.sql',ROOT/'ops/pilot/migrate.sh',ROOT/'ops/pilot/start-postgres.sh']}},indent=2))
finally:
    if auth_container:
        assert run(['docker','inspect','--format','{{index .Config.Labels "cloudnexus.purpose"}}',auth_container]).stdout.strip()=='pilot-preparation-test'
        run(['docker','rm','-f',auth_container])
    if container:
        identity=run(['docker','inspect','--format','{{index .Config.Labels "cloudnexus.purpose"}}',container]).stdout.strip()
        if identity!='pilot-preparation-test':raise RuntimeError('Cleanup label mismatch')
        run(['docker','rm','-f',container])
