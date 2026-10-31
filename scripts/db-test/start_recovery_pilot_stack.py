#!/usr/bin/env python3
"""Create the separately authorized durable recovery acceptance fixture.

Reads precreated mode0600 synthetic configuration outside git. Does not accept
production URLs, restore backups, publish non-loopback ports, or provision hosts.
"""
from pathlib import Path
import json
import os
import secrets
import base64
import hashlib
import hmac
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = Path.home()/'.local/share/cloud-nexus-pilot/recovery-test'
PG = 'supabase/postgres@sha256:be60aee15997daca475b710b734bc6bfe52cd544dcd7e9fd2ff58210b6747d83'
AUTH = 'supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b'
REST = 'postgrest/postgrest@sha256:1347d7552b88f17832912c06afbf7c43209af6eeeb60834b04aae12c9bd9d5cc'


def command(args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=60)
    if result.returncode:
        with (PRIVATE / 'setup-errors.log').open('a') as output:
            output.write(result.stdout + '\n' + result.stderr + '\n')
        raise RuntimeError(f'{args[0]} action failed; details retained privately')
    return result.stdout.strip()


def envfile(name, values):
    file = PRIVATE / name
    file.write_text('\n'.join(key + '=' + value for key, value in values.items()) + '\n')
    file.chmod(0o600)
    return str(file)



def prepare_configuration():
    assert not (PRIVATE/'stack.json').exists(), 'Existing recovery stack requires inspection, not bootstrap'
    for port in (43101,43310,59090,59091,59092,59093):
        with socket.socket() as sock:
            assert sock.connect_ex(('127.0.0.1',port)) != 0, 'Recovery port occupied'
    PRIVATE.mkdir(parents=True,mode=0o700,exist_ok=True)
    PRIVATE.chmod(0o700)
    assert not (PRIVATE/'private.json').exists(), 'Preserve existing configuration'
    signer=secrets.token_hex(32); now=int(time.time())
    def token(role):
        def enc(value):return base64.urlsafe_b64encode(value).decode().rstrip('=')
        body=enc(b'{"alg":"HS256","typ":"JWT"}')+'.'+enc(json.dumps({'iss':'http://127.0.0.1:59090/auth/v1','role':role,'iat':now,'nbf':now-5,'exp':now+86400},separators=(',',':')).encode())
        return body+'.'+enc(hmac.new(signer.encode(),body.encode(),hashlib.sha256).digest())
    config={'jwt_secret':signer,'anon_key':token('anon'),'service_key':token('service_role'),'db_password':secrets.token_hex(24),'auth_password':secrets.token_hex(24),'user_password':secrets.token_urlsafe(24),'email_a':'pilot.recovery.a@pilot.test','email_b':'pilot.recovery.b@pilot.test','email_browser':'pilot.recovery.browser@pilot.test'}
    envfile('private.json',{})
    (PRIVATE/'private.json').write_text(json.dumps(config)+'\n')
    envfile('pilot.env',{'NEXT_PUBLIC_SUPABASE_URL':'http://127.0.0.1:59090','NEXT_PUBLIC_SUPABASE_ANON_KEY':config['anon_key'],'PILOT_PROCESSING_SERVICE_KEY':config['service_key'],'PILOT_DATA_API_URL':'http://127.0.0.1:59090','NEXT_PUBLIC_SITE_URL':'http://127.0.0.1:43101','SUPABASE_URL':'http://127.0.0.1:59090','SUPABASE_PUBLISHABLE_KEY':config['anon_key'],'OPENAI_API_KEY':'local-synthetic-only','OPENAI_BASE_URL':'http://127.0.0.1:59093/v1','OPENAI_TRANSCRIPTION_MODEL':'synthetic-transcription','OPENAI_MODEL':'synthetic-guidance','NEXT_PUBLIC_PILOT_TEST_FIXTURE':'1','NEXT_PUBLIC_PILOT_REALTIME_WS_URL':'ws://127.0.0.1:43310/ws/session','PILOT_LOCAL_FRONTEND_PORT':'43101','PILOT_LOCAL_REALTIME_PORT':'43310','PILOT_JOURNEY_URL':'http://127.0.0.1:43101','PILOT_RECOVERY_STACK':'1','PILOT_FIXTURE_PORT':'59093'})

def main():
    prepare_configuration()
    assert PRIVATE.is_dir() and (PRIVATE / 'private.json').stat().st_mode & 0o077 == 0
    assert not (PRIVATE / 'stack.json').exists(), 'Existing stack must be reviewed rather than overwritten.'
    config = json.loads((PRIVATE / 'private.json').read_text())
    suffix = secrets.token_hex(4)
    names = {key: f'cnp-pilot-recovery-test-{suffix}-{key}' for key in ('db', 'auth', 'rest')}
    network = f'cnp-pilot-recovery-test-{suffix}'
    state = {'network': network, 'frontend_network': network+'-frontend', 'containers': names, 'images': {'postgres': PG, 'auth': AUTH, 'postgrest': REST}, 'container_ids': {}}
    statefile = PRIVATE / 'stack.json'
    statefile.write_text(json.dumps(state, indent=2)); statefile.chmod(0o600)
    command(['docker', 'network', 'create', '--internal', '--label', 'cloudnexus.purpose=pilot-recovery-acceptance', network])
    command(['docker','network','create','--label','cloudnexus.purpose=pilot-recovery-acceptance',state['frontend_network']])
    volume = network+'-data'
    command(['docker','volume','create','--label','cloudnexus.purpose=pilot-recovery-acceptance',volume])
    state['volume'] = volume
    command(['docker','run','--rm','--network','none','--user','root','--mount',f'type=volume,source={volume},target=/pilot-data','--entrypoint','/bin/sh',PG,'-c','chown postgres:postgres /pilot-data && chmod 700 /pilot-data'])
    start = "if [ ! -f /pilot-data/db/PG_VERSION ]; then initdb -D /pilot-data/db --username=postgres --auth-local=trust --auth-host=scram-sha-256 >/pilot-data/init.log 2>&1 && printf '\\nhost all all 0.0.0.0/0 scram-sha-256\\n' >>/pilot-data/db/pg_hba.conf || exit 1; fi; exec postgres -D /pilot-data/db -c listen_addresses='*' -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements -c max_connections=40 -c shared_buffers=128MB"
    common = ['--label','cloudnexus.purpose=pilot-recovery-acceptance','--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges']
    state['container_ids']['db'] = command(['docker','run','-d','--name',names['db'],*common,'--network-alias','pilot-db','--user','postgres','--memory','1536m','--cpus','2','--mount',f'type=volume,source={volume},target=/pilot-data','--tmpfs','/tmp:rw,nosuid,size=16777216','--entrypoint','/bin/bash',PG,'-c',start])
    statefile.write_text(json.dumps(state,indent=2))
    for _ in range(60):
        ready = subprocess.run(['docker','exec',names['db'],'pg_isready','-h','/tmp','-U','postgres'],capture_output=True)
        if ready.returncode == 0: break
        time.sleep(.5)
    else: raise RuntimeError('Disposable PostgreSQL not ready')
    def sql(text):
        return command(['docker','exec','-i',names['db'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'], text)
    sql("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '" + config['db_password'] + "'; GRANT anon,authenticated,service_role TO authenticator; CREATE ROLE supabase_auth_admin LOGIN CREATEROLE PASSWORD '" + config['auth_password'] + "'; CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin; ALTER ROLE supabase_auth_admin SET search_path TO auth; GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$; ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;")
    # Full002 is executed unmodified: the pinned image supplies pgvector.
    sql((ROOT/'packages/db/migrations/postgres/002_cloud_nexus_pilot_interviews.sql').read_text())
    sql('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;')
    sql((ROOT/'packages/db/migrations/postgres/003_pilot_durable_processing.sql').read_text())
    authenv = envfile('auth.env', {
        'GOTRUE_API_HOST':'0.0.0.0','GOTRUE_API_PORT':'9999','API_EXTERNAL_URL':'http://127.0.0.1:59090/auth/v1',
        'GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':'postgres://supabase_auth_admin:'+config['auth_password']+'@pilot-db:5432/postgres?sslmode=disable',
        'GOTRUE_SITE_URL':'http://127.0.0.1:43101','GOTRUE_URI_ALLOW_LIST':'http://127.0.0.1:43101/**,http://localhost:43101/**',
        'GOTRUE_DISABLE_SIGNUP':'false','GOTRUE_JWT_ADMIN_ROLES':'service_role','GOTRUE_JWT_AUD':'authenticated','GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated',
        'GOTRUE_JWT_EXP':'3600','GOTRUE_JWT_SECRET':config['jwt_secret'],'GOTRUE_JWT_ISSUER':'http://127.0.0.1:59090/auth/v1',
        'GOTRUE_EXTERNAL_EMAIL_ENABLED':'true','GOTRUE_MAILER_AUTOCONFIRM':'true','GOTRUE_EXTERNAL_PHONE_ENABLED':'false',
        'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED':'false','GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED':'true','GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL':'0',
        'GOTRUE_LOG_LEVEL':'error','GOTRUE_DB_MAX_POOL_SIZE':'5',
    })
    state['container_ids']['auth'] = command(['docker','run','-d','--name',names['auth'],*common,'--memory','256m','--cpus','1','--tmpfs','/tmp:rw,nosuid,size=16777216','-p','127.0.0.1:59091:9999','--env-file',authenv,AUTH])
    restenv = envfile('rest.env', {
        'PGRST_DB_URI':'postgres://authenticator:'+config['db_password']+'@pilot-db:5432/postgres',
        'PGRST_DB_SCHEMAS':'public','PGRST_DB_ANON_ROLE':'anon','PGRST_JWT_SECRET':config['jwt_secret'],
        'PGRST_SERVER_PORT':'3000','PGRST_DB_POOL':'5','PGRST_DB_MAX_ROWS':'1000','PGRST_LOG_LEVEL':'error',
    })
    state['container_ids']['rest'] = command(['docker','run','-d','--name',names['rest'],*common,'--memory','256m','--cpus','1','-p','127.0.0.1:59092:3000','--env-file',restenv,REST])
    # Docker internal-only endpoints do not expose published host ports. Only
    # the synthetic APIs receive a separate frontend bridge; PG stays private.
    for component in ('auth','rest'):
        command(['docker','network','connect',state['frontend_network'],names[component]])
        command(['docker','restart',names[component]])
    gatewaylog = (PRIVATE/'gateway.log').open('a')
    gateway = subprocess.Popen([sys.executable,str(ROOT/'scripts/db-test/local_pilot_gateway.py')],stdout=gatewaylog,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'PILOT_RECOVERY_STACK':'1'})
    state['gateway_pid'] = gateway.pid
    statefile.write_text(json.dumps(state,indent=2))
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:59090/auth/v1/health',timeout=2) as response:
                if response.status == 200: break
        except Exception: time.sleep(.5)
    else: raise RuntimeError('Disposable Auth gateway not ready; inspect private logs')
    sql("CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;")
    print(json.dumps({'state_file':str(statefile),'gateway_pid':gateway.pid,'container_ids':state['container_ids'],'gateway':'http://127.0.0.1:59090','postgres_exposed_to_host':False,'migrations':'002 and003 unmodified'},indent=2))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(f'Pilot local stack setup stopped: {type(error).__name__}. Inspect private setup-errors.log/stack.json; no secret values emitted.',file=sys.stderr)
        raise SystemExit(1)
