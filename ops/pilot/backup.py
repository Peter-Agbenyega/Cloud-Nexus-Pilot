#!/usr/bin/env python3
"""Encrypt a consistent Pilot database dump to a new private archive; never restore."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from verify_config import read_values


def validate_backup_values(values):
    # Backup must remain available before public admission is configured.
    if not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}',values.get('PILOT_POSTGRES_IMAGE','')):
        raise ValueError('Immutable PostgreSQL image required')
    if not re.fullmatch(r'(?:pilot|cnp-pilot)[a-zA-Z0-9_-]*',values.get('PILOT_PG_VOLUME','')):
        raise ValueError('Dedicated Pilot volume required')
    if not Path(values.get('PILOT_CONFIG_DIR','')).is_absolute():
        raise ValueError('Absolute private configuration directory required')


def release_source(root, expected=None):
    if expected is not None and not re.fullmatch('[a-f0-9]{40}',expected):
        raise ValueError('Full source SHA required')
    try:
        result=subprocess.run(['git','rev-parse','HEAD'],cwd=root,text=True,capture_output=True)
        actual=result.stdout.strip() if result.returncode==0 else None
    except FileNotFoundError:
        actual=None
    if actual and not re.fullmatch('[a-f0-9]{40}',actual):
        raise ValueError('Invalid checkout source identity')
    if actual and expected and actual!=expected:
        raise ValueError('Selected source differs from checkout')
    if not actual and not expected:
        raise ValueError('Exported deployment requires independently selected source SHA')
    return actual or expected,'git-checkout' if actual else 'operator-selected-export'


def validate_database(details, values, image_id, networks):
    labels=details.get('Config',{}).get('Labels',{})
    if labels.get('com.docker.compose.project')!='cloud-nexus-pilot' or labels.get('com.docker.compose.service')!='db' or details.get('HostConfig',{}).get('PortBindings') or not details.get('State',{}).get('Running'):
        raise ValueError('Database identity/private-network boundary mismatch')
    if details.get('Image')!=image_id or details.get('Config',{}).get('Image')!=values['PILOT_POSTGRES_IMAGE']:
        raise ValueError('Running database image does not match selected immutable image')
    mounts=[m for m in details.get('Mounts',[]) if m.get('Destination')=='/pilot-data']
    if len(mounts)!=1 or mounts[0].get('Type')!='volume' or mounts[0].get('Name')!=values['PILOT_PG_VOLUME'] or not mounts[0].get('RW'):
        raise ValueError('Database is not using the selected dedicated persistent volume')
    attached=details.get('NetworkSettings',{}).get('Networks',{})
    if len(attached)!=1 or len(networks)!=1 or not networks[0].get('Internal') or networks[0].get('Labels',{}).get('com.docker.compose.project')!='cloud-nexus-pilot' or networks[0].get('Labels',{}).get('com.docker.compose.network')!='data' or attached[next(iter(attached))].get('NetworkID')!=networks[0].get('Id'):
        raise ValueError('Database must be attached only to the selected private data network')


def encrypt_dump(command, recipient, archive, errors):
    # File is deliberately marked partial until both producer and encryption pass.
    with archive.open('xb') as dest,errors.open('xb') as err:
        dump=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=err)
        try:
            encrypted=subprocess.run(['openssl','cms','-encrypt','-binary','-aes-256-cbc','-outform','DER',str(recipient.resolve())],stdin=dump.stdout,stdout=dest,stderr=err,timeout=600)
            dump.stdout.close();dump_code=dump.wait(timeout=30)
        finally:
            if dump.stdout:dump.stdout.close()
            if dump.poll() is None:
                dump.terminate()
                try:dump.wait(timeout=10)
                except subprocess.TimeoutExpired:dump.kill();dump.wait(timeout=5)
    if encrypted.returncode or dump_code or archive.stat().st_size==0:
        raise RuntimeError('Backup failed; private partial archive retained, no success receipt written')
    with archive.open('rb') as stream:
        os.fsync(stream.fileno())
        digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return dump_code,encrypted.returncode,digest


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env',type=Path,required=True)
    p.add_argument('--recipient',type=Path,required=True)
    p.add_argument('--expected-recipient-sha256',required=True)
    p.add_argument('--output-directory',type=Path,required=True)
    p.add_argument('--source-sha',help='Independently selected full SHA for a deployment without Git metadata')
    args=p.parse_args();values=read_values(args.env);validate_backup_values(values)
    root=Path(__file__).resolve().parents[2]
    source_sha,source_basis=release_source(root,args.source_sha)
    out=args.output_directory
    if any(item.is_symlink() for item in (out,*out.parents)) or not out.is_absolute() or not out.is_dir() or out.stat().st_mode & 0o077 or out.stat().st_uid != os.getuid():
        raise ValueError('Existing owned private mode0700 backup directory required')
    if args.recipient.is_symlink() or not args.recipient.is_file() or args.recipient.stat().st_size>65536:
        raise ValueError('Existing reviewed recipient certificate required')
    digest=hashlib.sha256(args.recipient.read_bytes()).hexdigest()
    if not re.fullmatch('[a-f0-9]{64}',args.expected_recipient_sha256) or digest!=args.expected_recipient_sha256:
        raise ValueError('Recipient identity does not match independently selected digest')
    root=Path(__file__).resolve().parents[2]
    compose=['docker','compose','--env-file',str(args.env.resolve()),'-f',str(root/'ops/pilot/compose.yaml')]
    cid=subprocess.check_output([*compose,'ps','-q','db'],text=True).strip()
    if not re.fullmatch('[a-f0-9]{12,64}',cid):raise ValueError('Exactly one running Pilot database required')
    details=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]
    image_id=subprocess.check_output(['docker','image','inspect',values['PILOT_POSTGRES_IMAGE'],'--format','{{.Id}}'],text=True).strip()
    network_ids=[item['NetworkID'] for item in details.get('NetworkSettings',{}).get('Networks',{}).values()]
    networks=json.loads(subprocess.check_output(['docker','network','inspect',*network_ids],text=True)) if network_ids else []
    validate_database(details,values,image_id,networks)
    os.umask(0o077)
    name='pilot-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
    archive=out/(name+'.cms.partial');errors=out/(name+'.private-errors')
    # Bind to the inspected CID, never a potentially replaced compose service.
    command=['docker','exec','--user','postgres','-e','PGCONNECT_TIMEOUT=10','-e','PGOPTIONS=-c statement_timeout=600000',cid,'pg_dump','-h','/tmp','-U','postgres','-d','pilot','-Fc']
    dump_code,encryption_code,archive_digest=encrypt_dump(command,args.recipient,archive,errors)
    final=out/(name+'.cms')
    # Atomic no-overwrite publication in the same private filesystem.
    os.link(archive,final);archive.unlink();archive=final
    receipt={'recorded_at':datetime.now(timezone.utc).isoformat(),'source_sha':source_sha,'source_identity_basis':source_basis,'backup_script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'database_container':cid,'database_image_id':details['Image'],'archive':archive.name,'bytes':archive.stat().st_size,'sha256':archive_digest,'recipient_certificate_sha256':digest,'pg_dump_exit':dump_code,'encryption_exit':encryption_code,'consistent_snapshot':True,'restore_verified':False,'includes':'Pilot database, auth records, ownership, durable sessions; signing/config secrets separately escrowed'}
    with (out/(name+'.receipt.json')).open('x') as f:
        json.dump(receipt,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    descriptor=os.open(out,os.O_RDONLY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)
    print('Encrypted Pilot backup created with private receipt. Restore acceptance is still required.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Pilot backup stopped: '+type(error).__name__+'. Private data and values withheld.')
        raise SystemExit(1)
