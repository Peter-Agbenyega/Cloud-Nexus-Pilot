"""Read-only exact Pilot project mapping; never prints environment or key values."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[2]
env={**os.environ,'PATH':'/opt/homebrew/opt/node@22/bin:'+os.environ['PATH']}
project='prj_gv3EGRDtboiptK7DcevvsxvvJnoR';team='team_MUZZoWAsIqodGK9XbE3LY9dZ'
results={}
for name,path in [('project','/v9/projects/'+project),('domains','/v9/projects/'+project+'/domains')]:
    args=['vercel','api',path+'?teamId='+team,'--method','GET']
    r=subprocess.run(args,env=env,text=True,capture_output=True,timeout=30)
    if r.returncode:raise RuntimeError('Read-only hosting metadata lookup failed; values withheld')
    d=json.loads(r.stdout)
    if name=='project':
        link=d.get('link',{});prod=d.get('targets',{}).get('production') or {}
        results[name]={k:d.get(k) for k in ('id','name','accountId','rootDirectory','framework','nodeVersion','installCommand','buildCommand')}
        results[name]['repository']={k:link.get(k) for k in ('type','org','repo','productionBranch')}
        results[name]['production']={k:prod.get(k) for k in ('id','url','readyState','createdAt')}
        results[name]['production']['git_sha']=(prod.get('gitSource') or {}).get('sha') or prod.get('meta',{}).get('githubCommitSha')
    else:results[name]=[{k:item.get(k) for k in ('name','verified','redirect','gitBranch')} for item in d.get('domains',[])]
results['recorded_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
results['method']='CLI explicit exact project/team read-only GETs; connector404 was access-context mismatch, not outage proof'
(root/'review/release-preparation/hosting-mapping.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
