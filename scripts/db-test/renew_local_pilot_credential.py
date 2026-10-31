#!/usr/bin/env python3
"""Renew only this recorded loopback fixture's settlement token; never rotate signer.

Gateway private.json recovery is deliberately minimal (two API keys). No setup,
SQL, account password recovery, allowance grant, or service restart is performed.
"""
from pathlib import Path
import base64, datetime, hashlib, hmac, json, os, shutil, subprocess, time
import urllib.request

PRIVATE = Path('/private/tmp/cnp-pilot-local-stack')
BASE = 'http://127.0.0.1:58090'
TTL = 86400


def encoded(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def inspect(name, template):
    return subprocess.check_output(['docker', 'inspect', '--format', template, name], text=True).strip()


def field(name, key):
    # Select only the named entry inside Docker; never return the full environment.
    template = '{{range .Config.Env}}{{if eq (index (split . "=") 0) "'+key+'"}}{{println .}}{{end}}{{end}}'
    value = inspect(name, template)
    assert value.startswith(key+'=')
    return value.split('=', 1)[1]


def protected(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(value)


def main():
    assert PRIVATE.stat().st_mode & 0o077 == 0
    state = json.loads((PRIVATE/'stack.json').read_text())
    for role, name in state['containers'].items():
        assert name == state['network']+'-'+role
        assert inspect(name, '{{.Id}}') == state['container_ids'][role]
        assert inspect(name, '{{index .Config.Labels "cloudnexus.purpose"}}') == 'pilot-local-acceptance'
        assert inspect(name, '{{.State.Running}}') == 'true'
    auth, rest = state['containers']['auth'], state['containers']['rest']
    signer = field(auth, 'GOTRUE_JWT_SECRET')
    assert hmac.compare_digest(signer, field(rest, 'PGRST_JWT_SECRET'))
    issuer = field(auth, 'GOTRUE_JWT_ISSUER')
    assert issuer == BASE+'/auth/v1'
    envpath = PRIVATE/'pilot.env'
    assert envpath.stat().st_mode & 0o077 == 0
    raw = envpath.read_text()
    env = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line and not line.startswith('#'))
    assert env['PILOT_DATA_API_URL'] == env['NEXT_PUBLIC_SUPABASE_URL'] == BASE
    assert env['OPENAI_BASE_URL'] == 'http://127.0.0.1:58093/v1'
    old = env['PILOT_PROCESSING_SERVICE_KEY']
    header, payload, signature = old.split('.')
    assert json.loads(base64.urlsafe_b64decode(header+'==='))['alg'] == 'HS256'
    assert hmac.compare_digest(encoded(hmac.new(signer.encode(), (header+'.'+payload).encode(), hashlib.sha256).digest()), signature)
    claims = json.loads(base64.urlsafe_b64decode(payload+'==='))
    assert claims['iss'] == issuer and claims['role'] == 'service_role'
    now = int(time.time())
    assert claims['exp'] <= now, 'Refuse to replace a still-valid token'
    claims.update(iat=now, nbf=now-5, exp=now+TTL)
    payload = encoded(json.dumps(claims, separators=(',', ':')).encode())
    token = header+'.'+payload
    token += '.'+encoded(hmac.new(signer.encode(), token.encode(), hashlib.sha256).digest())
    # Running verifier validates signature, role, nbf and exp before any local write.
    request = urllib.request.Request(BASE+'/rest/v1/',
        headers={'apikey': env['NEXT_PUBLIC_SUPABASE_ANON_KEY'], 'authorization': 'Bearer '+token})
    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 200
        remote = response.headers.get('Date')
        if remote:
            from email.utils import parsedate_to_datetime
            assert abs(parsedate_to_datetime(remote).timestamp()-time.time()) < 30
    target = PRIVATE/'private.json'
    if target.exists():
        config = json.loads(target.read_text())
        assert config['anon_key'] == env['NEXT_PUBLIC_SUPABASE_ANON_KEY']
    else:
        config = {'anon_key': env['NEXT_PUBLIC_SUPABASE_ANON_KEY']}
    backup = PRIVATE/('credential-rollback-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    for path in [envpath, target]:
        if path.exists():
            shutil.copyfile(path, backup/path.name)
            (backup/path.name).chmod(0o600)
    config['service_key'] = token
    protected(PRIVATE/'private.json.renewing', json.dumps(config)+'\n')
    updated = '\n'.join('PILOT_PROCESSING_SERVICE_KEY='+token if line.startswith('PILOT_PROCESSING_SERVICE_KEY=') else line for line in raw.splitlines())+'\n'
    protected(PRIVATE/'pilot.env.renewing', updated)
    os.replace(PRIVATE/'private.json.renewing', target)
    os.replace(PRIVATE/'pilot.env.renewing', envpath)
    print(json.dumps({'renewed': True, 'verifier_read_only_status': 200, 'ttl_seconds': TTL,
        'expires_at': datetime.datetime.fromtimestamp(now+TTL, datetime.timezone.utc).isoformat(),
        'signing_identity_preserved': True, 'recovered_fields': ['anon_key', 'service_key'],
        'public_token_unchanged': True, 'services_restarted': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if isinstance(error, __import__('urllib.error', fromlist=['HTTPError']).HTTPError):
            try: print(json.dumps({'http_status': error.code, 'error_code': json.loads(error.read()).get('code')}))
            except Exception: pass
        print('Local renewal stopped safely: '+type(error).__name__)
        raise SystemExit(1)
