#!/usr/bin/env python3
"""Renew expired recovery API credentials without changing signer/accounts/data.

Explicit --apply only. Stops the old synthetic application (not its fixture),
reloads the recovery gateway, and leaves frontend startup to the live launcher.
"""
from pathlib import Path
import base64, datetime, hashlib, hmac, json, os, signal, socket
import subprocess, sys, time, urllib.request

PRIVATE = Path.home()/'.local/share/cloud-nexus-pilot/recovery-test'
ROOT = Path(__file__).resolve().parents[2]
BASE = 'http://127.0.0.1:59090'
TTL = 86400

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
    gateway_command = run(['ps','-p',str(state['gateway_pid']),'-o','command='])
    assert 'Cloud-Nexus-Pilot-recovery-acceptance/scripts/db-test/local_pilot_gateway.py' in gateway_command
    app_command = run(['ps','-p',str(runtime['application']),'-o','command='])
    assert '--env-file='+str(PRIVATE/'pilot.env') in app_command
    assert 'scripts/pilot/local.mjs start' in app_command
    assert runtime['checkout'] == str(Path.home()/'Cloud-Nexus-Pilot-voice-investigation')
    assert listening(59090) and not listening(43102) and not listening(43311)
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
    before = snapshot()
    backup = PRIVATE/('recovery-renewal-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    for name in ('private.json','pilot.env','stack.json','runtime.json'):
        write(backup/name, (PRIVATE/name).read_text())
    os.kill(runtime['application'],signal.SIGTERM)
    wait_free([43101,43310])
    cfg.update(renewed)
    replacements = {'NEXT_PUBLIC_SUPABASE_ANON_KEY':cfg['anon_key'],'SUPABASE_PUBLISHABLE_KEY':cfg['anon_key'],'PILOT_PROCESSING_SERVICE_KEY':cfg['service_key']}
    updated = '\n'.join(line.split('=',1)[0]+'='+replacements[line.split('=',1)[0]] if line.split('=',1)[0] in replacements else line for line in raw.splitlines())+'\n'
    write(PRIVATE/'private.json',json.dumps(cfg)+'\n')
    write(PRIVATE/'pilot.env',updated)
    os.kill(state['gateway_pid'],signal.SIGTERM)
    wait_free([59090])
    fd = os.open(PRIVATE/'gateway.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    with os.fdopen(fd,'a') as log:
        child = subprocess.Popen([sys.executable,str(ROOT/'scripts/db-test/local_pilot_gateway.py')],cwd=ROOT,env={**os.environ,'PILOT_RECOVERY_STACK':'1'},stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    state['gateway_pid'] = child.pid
    write(PRIVATE/'stack.json',json.dumps(state))
    runtime['synthetic_application_stopped'] = runtime.pop('application')
    runtime['transition'] = 'credentials renewed; live startup pending'
    write(PRIVATE/'runtime.json',json.dumps(runtime))
    for _ in range(40):
        if listening(59090): break
        time.sleep(.25)
    request = urllib.request.Request(BASE+'/rest/v1/',headers={'apikey':cfg['anon_key'],'authorization':'Bearer '+cfg['service_key'],'origin':'http://127.0.0.1:43102'})
    with urllib.request.urlopen(request,timeout=5) as response:
        assert response.status == 200
        assert response.headers.get('access-control-allow-origin') == 'http://127.0.0.1:43102'
    assert before == snapshot(), 'Database contents changed during renewal'
    assert original_hash == (hashlib.sha256(original.read_bytes()).hexdigest() if original.exists() else None)
    report = {'renewed':True,'ttl_seconds':TTL,'expires_at':datetime.datetime.fromtimestamp(now+TTL,datetime.timezone.utc).isoformat(),'signer_preserved':True,'accounts_and_public_rows_preserved':True,'original_stack_state_unchanged':True,'synthetic_app_stopped':True,'live_gateway_cors_verified':True,'rollback_directory':str(backup)}
    write(PRIVATE/'recovery-renewal-result.json',json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'renewed':False,'error_type':type(error).__name__,'http_status':getattr(error,'code',None),'error_line':__import__('traceback').extract_tb(error.__traceback__)[-1].lineno}))
        raise SystemExit(1)
