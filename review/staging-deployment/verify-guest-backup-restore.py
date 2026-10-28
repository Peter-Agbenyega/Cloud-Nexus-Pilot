"""Encrypt guest Pilot snapshot; restore only to a new random database; verify synthetic fixture and RLS."""
from pathlib import Path
import datetime,hashlib,json,re,subprocess,uuid
ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path('/private/tmp/cnp-pilot-local-stack/staging/restore-rehearsal')
SSH=['ssh','-i','/private/tmp/cnp-pilot-local-stack/pilot-staging-ed25519','-o','UserKnownHostsFile=/private/tmp/cnp-pilot-local-stack/staging-known-hosts','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','pilot@192.168.68.54']
SOURCE='0d0d3c6f16bc78be7ee9b6eec0ba4855a5f7a4df'
checks=[];restore='pilot_restore_'+uuid.uuid4().hex;session=str(uuid.uuid4());created=False
people=json.loads((PRIVATE.parent/'acceptance-state.json').read_text())['users']
a=str(uuid.UUID(people['a']['id']));b=str(uuid.UUID(people['b']['id']))
def remote(cmd,data=None):
 r=subprocess.run(SSH+[cmd],input=data,capture_output=True,timeout=180)
 if r.returncode:raise RuntimeError('Remote command failed (exit '+str(r.returncode)+'); payload withheld')
 return r.stdout

def sql(database,text):
 assert database=='pilot' or re.fullmatch('pilot_restore_[a-f0-9]{32}',database)
 return remote('sudo docker exec -i --user postgres cloud-nexus-pilot-db-1 psql -XqAt -v ON_ERROR_STOP=1 -h /tmp -U postgres -d '+database,text.encode()).decode().strip()
def check(name,ok=True):
 if not ok:raise RuntimeError('Check failed: '+name)
 checks.append(name)
try:
 # Insert only a newly generated, explicitly synthetic fixture; never replace source records.
 sql('pilot',f"BEGIN; INSERT INTO public.interview_sessions(id,user_id,status,title) VALUES ('{session}','{a}','ended','Synthetic isolated restore fixture'); INSERT INTO public.transcript_segments(user_id,interview_session_id,source,text,is_partial,client_event_id,provider_result) VALUES ('{a}','{session}','manual','Synthetic restore final',false,'restore-event-1','{{\"synthetic\":true}}'); INSERT INTO public.guidance_items(user_id,interview_session_id,headline,speak_now) VALUES ('{a}','{session}','Synthetic guidance','Hypothetical restore fixture'); COMMIT;")
 expected=sql('pilot',f"SELECT md5(string_agg(text||pilot_sequence::text,',' ORDER BY pilot_sequence)) FROM transcript_segments WHERE interview_session_id='{session}'")
 cert=hashlib.sha256((PRIVATE/'recipient.pem').read_bytes()).hexdigest()
 remote('sudo python3 /opt/cloud-nexus-pilot/ops/pilot/backup.py --env /etc/cloud-nexus-pilot/deployment.env --recipient /var/tmp/cnp-restore-rehearsal/recipient.pem --expected-recipient-sha256 '+cert+' --source-sha '+SOURCE+' --output-directory /var/tmp/cnp-restore-rehearsal')
 check('guarded pg_dump and CMS encryption succeeded')
 listing=remote('sudo find /var/tmp/cnp-restore-rehearsal -maxdepth 1 -type f -name "*.receipt.json" -printf "%f\\n"').decode().splitlines()
 check('exactly one rehearsal backup receipt',len(listing)==1)
 name=listing[0];assert re.fullmatch(r'pilot-[0-9TZ]+-[a-f0-9]{8}\.receipt\.json',name)
 receipt=json.loads(remote('sudo cat /var/tmp/cnp-restore-rehearsal/'+name))
 archive=receipt['archive'];assert re.fullmatch(r'pilot-[0-9TZ]+-[a-f0-9]{8}\.cms',archive)
 encrypted=remote('sudo cat /var/tmp/cnp-restore-rehearsal/'+archive)
 check('off-guest encrypted copy matches backup receipt',hashlib.sha256(encrypted).hexdigest()==receipt['sha256'])
 (PRIVATE/archive).write_bytes(encrypted);(PRIVATE/archive).chmod(0o600)
 (PRIVATE/name).write_text(json.dumps(receipt,indent=2)+'\n');(PRIVATE/name).chmod(0o600)
 plain=PRIVATE/'isolated-rehearsal.dump'
 with plain.open('xb') as f:
  plain.chmod(0o600)
  r=subprocess.run(['openssl','cms','-decrypt','-inform','DER','-in',str(PRIVATE/archive),'-recip',str(PRIVATE/'recipient.pem'),'-inkey',str(PRIVATE/'recipient.key')],stdout=f,stderr=subprocess.PIPE,timeout=30)
 check('Mac-held private key decrypts archive',r.returncode==0 and plain.stat().st_size>0)
 remote('sudo docker exec --user postgres cloud-nexus-pilot-db-1 createdb -h /tmp -U postgres --template template0 '+restore);created=True
 check('new random restore database created without overwrite')
 remote('sudo docker exec -i --user postgres cloud-nexus-pilot-db-1 pg_restore -h /tmp -U postgres --exit-on-error --dbname '+restore,plain.read_bytes())
 check('actual custom-format archive restored successfully')
 actual=sql(restore,f"SELECT md5(string_agg(text||pilot_sequence::text,',' ORDER BY pilot_sequence)) FROM transcript_segments WHERE interview_session_id='{session}'")
 check('final text and sequence preserved',actual==expected)
 check('guidance association preserved',sql(restore,f"SELECT count(*) FROM guidance_items WHERE interview_session_id='{session}' AND user_id='{a}'")=='1')
 check('identity UUIDs restored',sql(restore,f"SELECT count(*) FROM auth.users WHERE id IN ('{a}','{b}')")=='2')
 check('both migration receipts restored',sql(restore,'SELECT count(*) FROM pilot_ops.migrations')=='2')
 def owned_count(owner):
  return sql(restore,f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{{\"sub\":\"{owner}\",\"role\":\"authenticated\"}}'; SELECT count(*) FROM public.transcript_segments WHERE interview_session_id='{session}'; ROLLBACK;")
 check('restored owner can read own final',owned_count(a)=='1')
 check('restored second user cannot read final',owned_count(b)=='0')
 check('source fixture unchanged by restore',sql('pilot',f"SELECT md5(string_agg(text||pilot_sequence::text,',' ORDER BY pilot_sequence)) FROM transcript_segments WHERE interview_session_id='{session}'")==expected)
 # Remove only the disposable restore target and this run's exact source fixture.
 remote('sudo docker exec --user postgres cloud-nexus-pilot-db-1 dropdb -h /tmp -U postgres '+restore);created=False
 sql('pilot',f"DELETE FROM public.interview_sessions WHERE id='{session}' AND user_id='{a}';")
 plain.unlink()
 check('disposable target and exact source fixture cleaned; encrypted copies retained')
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_sha':SOURCE,'guest_id':215,'guest_ip':'192.168.68.54','exit_code':0,'checks':checks,'check_count':len(checks),'archive_sha256':receipt['sha256'],'recipient_sha256':cert,'archive_bytes':receipt['bytes'],'restore_database':restore,'target_removed':True,'encrypted_off_guest_copy':True,'production_backup_policy_verified':False,'identity_refresh_cutover_verified':False,'provider_calls':0,'layer':'Real guest encrypted pg_dump/isolated database restore; synthetic records and role-based RLS checks; not production recovery'}
 (ROOT/'review/staging-deployment/guest-backup-restore.json').write_text(json.dumps(report,indent=2)+'\n')
 print('Guest backup/isolated restore passed',len(checks),'checks; encrypted copies retained privately.')
except Exception as e:
 print('Backup/restore stopped:',str(e) if isinstance(e,RuntimeError) else type(e).__name__)
 print('Disposable restore target retained for inspection:',restore if created else 'not created or already removed')
 raise SystemExit(1)
