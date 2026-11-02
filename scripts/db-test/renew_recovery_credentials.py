#!/usr/bin/env python3
"""Renew expired recovery API credentials without changing signer/accounts/data.

Explicit --apply only. Stops the recorded recovery application (live or legacy),
reloads only its gateway, and leaves rebuild/startup to the live launcher.
"""
from pathlib import Path
import base64, datetime, hashlib, hmac, json, os, shlex, signal, socket
import subprocess, sys, time, urllib.request

PRIVATE = Path.home()/'.local/share/cloud-nexus-pilot/recovery-test'
ROOT = Path(__file__).resolve().parents[2]
BASE = 'http://127.0.0.1:59090'
TTL = 86400
PROGRESS = {
    "phase": "preflight", "application_stop_requested": False,
    "application_stopped": False, "credential_files_replaced": [],
    "gateway_stop_requested": False, "gateway_restarted": False,
    "rollback_directory": None,
}

def enc(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')

def run(args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=20)
    if result.returncode: raise RuntimeError('Read-only subprocess failed')
    return result.stdout.strip()

def write(path, text):
    temp = path.with_name(path.name+'.renewing')
    fd = os.open(temp, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(text)
    os.replace(temp, path)

def listening(port):
    with socket.socket() as sock: return sock.connect_ex(('127.0.0.1', port)) == 0

def wait_free(ports):
    for _ in range(40):
        if not any(listening(p) for p in ports): return
        time.sleep(.25)
    raise RuntimeError('Owned listeners did not stop')

def select_application(runtime, gateway_pid):
    """Verify the recorded recovery consumer before permitting any signal."""
    active = [name for name in ('application', 'live_application') if name in runtime]
    assert len(active) == 1, 'Require exactly one recorded recovery application'
    app_field = active[0]
    live = app_field == 'live_application'
    checkout = ROOT if live else Path.home()/'Cloud-Nexus-Pilot-voice-investigation'
    assert runtime['live_checkout' if live else 'checkout'] == str(checkout)
    app_pid = runtime[app_field]
    assert isinstance(app_pid, int) and app_pid > 1 and app_pid != gateway_pid
    app_args = shlex.split(run(['ps','-p',str(app_pid),'-o','command=']))
    assert app_args and Path(app_args[0]).name == 'node'
    app_cwd = run(['/usr/sbin/lsof','-a','-p',str(app_pid),'-d','cwd','-Fn'])
    assert 'n'+str(checkout) in app_cwd.splitlines()
    if live:
        assert len(app_args) == 3 and app_args[2] == 'start'
        assert app_args[1] in ('scripts/pilot/live-local.mjs', str(ROOT/'scripts/pilot/live-local.mjs'))
        app_ports, other_ports = [43102, 43311], [43101, 43310]
        stopped_field = 'live_application_stopped'
    else:
        assert len(app_args) == 4 and app_args[1] == '--env-file='+str(PRIVATE/'pilot.env')
        assert app_args[2] in ('scripts/pilot/local.mjs', str(checkout/'scripts/pilot/local.mjs'))
        assert app_args[3] == 'start'
        app_ports, other_ports = [43101, 43310], [43102, 43311]
        stopped_field = 'synthetic_application_stopped'
    assert all(listening(port) for port in app_ports)
    assert not any(listening(port) for port in other_ports), 'Unrecorded recovery consumer must be inspected'
    return app_field, live, app_pid, app_ports, stopped_field

def main():
    assert sys.argv[1:] == ['--apply']
    assert ROOT == Path.home()/'Cloud-Nexus-Pilot-live-acceptance'
    assert PRIVATE.stat().st_mode & 0o077 == 0
    for name in ('private.json', 'pilot.env', 'stack.json', 'runtime.json'):
        p = PRIVATE/name
        assert p.is_file() and not p.is_symlink() and p.stat().st_nlink == 1
        assert p.stat().st_mode & 0o077 == 0
    cfg = json.loads((PRIVATE/'private.json').read_text())
    state = json.loads((PRIVATE/'stack.json').read_text())
    runtime = json.loads((PRIVATE/'runtime.json').read_text())
    raw = (PRIVATE/'pilot.env').read_text()
    env = dict(line.split('=',1) for line in raw.splitlines() if '=' in line and not line.startswith('#'))
    assert env['PILOT_RECOVERY_STACK'] == '1'
    assert env['PILOT_DATA_API_URL'] == env['NEXT_PUBLIC_SUPABASE_URL'] == BASE
    assert env['OPENAI_BASE_URL'] == 'http://127.0.0.1:59093/v1'
    assert env['OPENAI_API_KEY'] == 'local-synthetic-only'
    assert env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] == env['SUPABASE_PUBLISHABLE_KEY'] == cfg['anon_key']
    assert env['PILOT_PROCESSING_SERVICE_KEY'] == cfg['service_key']
    for role, name in state['containers'].items():
        assert name == state['network']+'-'+role
        meta = json.loads(run(['docker','inspect',name]))[0]
        assert meta['Id'] == state['container_ids'][role]
        assert meta['State']['Running']
        assert meta['Config']['Labels']['cloudnexus.purpose'] == 'pilot-recovery-acceptance'
        values = dict(item.split('=',1) for item in meta['Config']['Env'])
        if role == 'auth':
            assert hmac.compare_digest(values['GOTRUE_JWT_SECRET'], cfg['jwt_secret'])
            assert values['GOTRUE_JWT_ISSUER'] == BASE+'/auth/v1'
        if role == 'rest':
            assert hmac.compare_digest(values['PGRST_JWT_SECRET'], cfg['jwt_secret'])
    original = Path('/private/tmp/cnp-pilot-local-stack/stack.json')
    original_hash = hashlib.sha256(original.read_bytes()).hexdigest() if original.exists() else None
    if original.exists(): assert state['gateway_pid'] != json.loads(original.read_text())['gateway_pid']
    listeners = run(['/usr/sbin/lsof','-nP','-a','-p',str(state['gateway_pid']),'-iTCP','-sTCP:LISTEN','-Fn'])
    assert 'n127.0.0.1:59090' in listeners and ':58090' not in listeners
    gateway_args = shlex.split(run(['ps','-p',str(state['gateway_pid']),'-o','command=']))
    gateway_sources = {
        str(Path.home()/'Cloud-Nexus-Pilot-recovery-acceptance/scripts/db-test/local_pilot_gateway.py'),
        str(ROOT/'scripts/db-test/local_pilot_gateway.py'),
    }
    assert len(gateway_args) == 2 and Path(gateway_args[0]).name.lower().startswith('python')
    assert gateway_args[1] in gateway_sources
    assert listening(59090)
    app_field, live, app_pid, app_ports, stopped_field = select_application(runtime, state['gateway_pid'])
    PROGRESS['application_mode'] = 'live' if live else 'synthetic'
    now = int(time.time())
    renewed = {}
    for field, role in [('anon_key','anon'),('service_key','service_role')]:
        header, payload, sig = cfg[field].split('.')
        assert json.loads(base64.urlsafe_b64decode(header+'==='))['alg'] == 'HS256'
        assert hmac.compare_digest(sig, enc(hmac.new(cfg['jwt_secret'].encode(),(header+'.'+payload).encode(),hashlib.sha256).digest()))
        claims = json.loads(base64.urlsafe_b64decode(payload+'==='))
        assert claims['role'] == role and claims['iss'] == BASE+'/auth/v1'
        assert claims['exp'] <= now, 'Refuse to replace a valid credential'
        claims.update(iat=now, nbf=now-5, exp=now+TTL)
        body = header+'.'+enc(json.dumps(claims,separators=(',',':')).encode())
        renewed[field] = body+'.'+enc(hmac.new(cfg['jwt_secret'].encode(),body.encode(),hashlib.sha256).digest())
        request = urllib.request.Request('http://127.0.0.1:59092/',headers={'authorization':'Bearer '+renewed[field]})
        with urllib.request.urlopen(request,timeout=5) as response: assert response.status == 200
    # Database is read-only here. Record full public-row digests and account ids.
    sql = r"""BEGIN READ ONLY;
SELECT 'auth.users:'||count(*)||':'||md5(coalesce(string_agg(id::text,',' ORDER BY id),''))
FROM auth.users;
SELECT format('SELECT %L || count(*) || %L || md5(coalesce(string_agg(row_to_json(t)::text,%L ORDER BY row_to_json(t)::text),%L)) FROM %I.%I t;',
table_name||':',':',',','','public',table_name)
FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name
\gexec
COMMIT;"""
    def snapshot():
        return run(['docker','exec','-i',state['containers']['db'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'],sql)
    backup = PRIVATE/('recovery-renewal-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    PROGRESS['rollback_directory'] = str(backup)
    for name in ('private.json','pilot.env','stack.json','runtime.json'):
        write(backup/name, (PRIVATE/name).read_text())
    PROGRESS['phase'] = 'stopping_recorded_application'
    os.kill(app_pid,signal.SIGTERM)
    PROGRESS['application_stop_requested'] = True
    wait_free(app_ports)
    PROGRESS['application_stopped'] = True
    runtime[stopped_field] = runtime.pop(app_field)
    runtime['transition'] = 'recorded recovery application stopped; credential renewal pending'
    write(PRIVATE/'runtime.json',json.dumps(runtime))
    PROGRESS['phase'] = 'snapshot_after_application_stop'
    before = snapshot()
    cfg.update(renewed)
    replacements = {'NEXT_PUBLIC_SUPABASE_ANON_KEY':cfg['anon_key'],'SUPABASE_PUBLISHABLE_KEY':cfg['anon_key'],'PILOT_PROCESSING_SERVICE_KEY':cfg['service_key']}
    updated = '\n'.join(line.split('=',1)[0]+'='+replacements[line.split('=',1)[0]] if line.split('=',1)[0] in replacements else line for line in raw.splitlines())+'\n'
    PROGRESS['phase'] = 'replacing_private_configuration'
    write(PRIVATE/'private.json',json.dumps(cfg)+'\n')
    PROGRESS['credential_files_replaced'].append('private.json')
    write(PRIVATE/'pilot.env',updated)
    PROGRESS['credential_files_replaced'].append('pilot.env')
    PROGRESS['phase'] = 'reloading_recovery_gateway'
    os.kill(state['gateway_pid'],signal.SIGTERM)
    PROGRESS['gateway_stop_requested'] = True
    wait_free([59090])
    fd = os.open(PRIVATE/'gateway.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    with os.fdopen(fd,'a') as log:
        child = subprocess.Popen([sys.executable,str(ROOT/'scripts/db-test/local_pilot_gateway.py')],cwd=ROOT,env={**os.environ,'PILOT_RECOVERY_STACK':'1'},stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    state['gateway_pid'] = child.pid
    PROGRESS['gateway_restarted'] = True
    write(PRIVATE/'stack.json',json.dumps(state))
    runtime['transition'] = 'credentials renewed; live rebuild and startup pending'
    write(PRIVATE/'runtime.json',json.dumps(runtime))
    for _ in range(40):
        if listening(59090): break
        time.sleep(.25)
    PROGRESS['phase'] = 'verifying_gateway_and_data'
    request = urllib.request.Request(BASE+'/rest/v1/',headers={'apikey':cfg['anon_key'],'authorization':'Bearer '+cfg['service_key'],'origin':'http://127.0.0.1:43102'})
    with urllib.request.urlopen(request,timeout=5) as response:
        assert response.status == 200
        assert response.headers.get('access-control-allow-origin') == 'http://127.0.0.1:43102'
    assert before == snapshot(), 'Database contents changed during renewal'
    assert original_hash == (hashlib.sha256(original.read_bytes()).hexdigest() if original.exists() else None)
    report = {'renewed':True,'ttl_seconds':TTL,'expires_at':datetime.datetime.fromtimestamp(now+TTL,datetime.timezone.utc).isoformat(),'signer_preserved':True,'accounts_and_public_rows_preserved':True,'original_stack_state_unchanged':True,'synthetic_app_stopped':not live,'live_app_stopped':live,'rebuild_required':True,'live_gateway_cors_verified':True,'rollback_directory':str(backup)}
    PROGRESS['phase'] = 'verified'
    write(PRIVATE/'recovery-renewal-result.json',json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'renewal_verified':False,**PROGRESS,'error_type':type(error).__name__,'http_status':getattr(error,'code',None),'error_line':__import__('traceback').extract_tb(error.__traceback__)[-1].lineno}))
        raise SystemExit(1)
