"""Read exact Pilot env metadata; import only a readable non-production OpenAI key into an empty private entry."""
from pathlib import Path
import os,json,subprocess,datetime
project='prj_gv3EGRDtboiptK7DcevvsxvvJnoR';team='team_MUZZoWAsIqodGK9XbE3LY9dZ'
env={**os.environ,'PATH':'/opt/homebrew/opt/node@22/bin:'+os.environ['PATH']}
r=subprocess.run(['vercel','api',f'/v10/projects/{project}/env?teamId={team}','--method','GET'],env=env,text=True,capture_output=True,timeout=30)
report={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'project':project,'team':team,'lookup_exit':r.returncode,'key_metadata':[],'imported_into_empty_private_entry':False}
if r.returncode==0:
 data=json.loads(r.stdout)
 for item in data.get('envs',[]):
  if item.get('key') not in ('OPENAI_API_KEY','DEEPGRAM_API_KEY'):continue
  targets=item.get('target') or [];targets=[targets] if isinstance(targets,str) else targets
  value=item.get('value');readable=isinstance(value,str) and value.startswith('sk-') and '\n' not in value
  report['key_metadata'].append({'name':item['key'],'targets':targets,'type':item.get('type'),'readable_openai_key_available':readable})
  if item['key']=='OPENAI_API_KEY' and readable and any(t in ('preview','development') for t in targets):
   p=Path('/private/tmp/cnp-pilot-local-stack/live-provider.env');assert not p.is_symlink() and p.stat().st_uid==os.getuid();lines=p.read_text().splitlines(keepends=True)
   matches=[i for i,line in enumerate(lines) if line.startswith('OPENAI_API_KEY=')];assert len(matches)==1
   i=matches[0]
   if not lines[i].partition('=')[2].strip():
    lines[i]='OPENAI_API_KEY='+value+'\n';p.chmod(0o600);p.write_text(''.join(lines));p.chmod(0o600);report['imported_into_empty_private_entry']=True
else:report['lookup_error']='Project secret metadata unavailable through CLI; no raw response or value logged.'
p=Path('/private/tmp/cnp-pilot-local-stack/live-provider.env');p.chmod(0o600)
report['local_live_key_present']=any(line.startswith('OPENAI_API_KEY=') and bool(line.partition('=')[2].strip()) for line in p.read_text().splitlines())
Path('review/staging-deployment/authorized-secret-check.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
