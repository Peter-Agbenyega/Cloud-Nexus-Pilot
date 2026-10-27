#!/usr/bin/env python3
"""Read-only preparation validator. Never provisions, sources shell, or prints values."""
import argparse
import json
import os
from pathlib import Path
import re
from urllib.parse import urlparse


def read_values(path, private=False):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Configuration must be a regular non-symlink file')
    if private and path.stat().st_mode & 0o077:
        raise ValueError('Private environment requires mode0600 or more restrictive')
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in values:
            raise ValueError('Malformed or duplicate configuration name')
        if not value or any(x in value for x in ('REPLACE', '${', '`', '\x00')):
            raise ValueError('Missing value or unresolved template')
        values[key] = value
    return values


def validate(values):
    for name in ('PILOT_POSTGRES_IMAGE','PILOT_AUTH_IMAGE','PILOT_REST_IMAGE','PILOT_REALTIME_IMAGE'):
        if not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', values.get(name,'')):
            raise ValueError('Every deployed image must be selected by immutable digest')
    if not re.fullmatch(r'pilot[a-zA-Z0-9_-]*', values.get('PILOT_PG_VOLUME','')):
        raise ValueError('An explicitly dedicated Pilot volume is required')
    directory = Path(values.get('PILOT_CONFIG_DIR',''))
    if not directory.is_absolute():
        raise ValueError('Private configuration directory must be absolute')
    for name in ('PILOT_IDENTITY_HOST','PILOT_REALTIME_HOST'):
        host = values.get(name,'')
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host) or '.' not in host:
            raise ValueError('Exact approved DNS hosts required')
    origin = urlparse(values.get('PILOT_WEB_ORIGIN',''))
    if origin.scheme != 'https' or not origin.hostname or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}', origin.hostname) or origin.path or origin.query or origin.fragment or origin.username or origin.password or origin.port not in (None,443):
        raise ValueError('One exact HTTPS frontend origin is required')
    if values['PILOT_IDENTITY_HOST'] == values['PILOT_REALTIME_HOST']:
        raise ValueError('Identity and realtime hosts must be distinct')
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env',type=Path,required=True)
    parser.add_argument('--target',type=Path,help='Required before any deployment; authoritative allocation record, not a guessed VM')
    args = parser.parse_args()
    directory = validate(read_values(args.env))
    for name in ('db','auth','rest','realtime','bootstrap','migration'):
        data = read_values(directory/(name+'.env'),private=True)
        if any(k.startswith('NEXT_PUBLIC_') for k in data):
            raise ValueError('Guest private services do not consume public frontend configuration')
    if args.target:
        target=json.loads(args.target.read_text())
        if type(target.get('guest_id')) is not int or target['guest_id'] in (101,107,201) or target['guest_id'] <= 0 or target.get('product') != 'pilot' or target.get('allocation_verified') is not True or not target.get('owner') or not target.get('verified_at'):
            raise ValueError('Verified dedicated Pilot allocation is required')
        print('Configuration shape and allocation record accepted; hosted acceptance remains separate.')
    else:
        print('Configuration shape accepted only. No destination checked; deployment remains blocked.')


if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,json.JSONDecodeError):
        print('Pilot preparation blocked: invalid/missing configuration or allocation; values withheld.')
        raise SystemExit(1)
