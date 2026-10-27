import sys,pathlib,subprocess,os,json,hashlib,datetime
root=pathlib.Path('/private/tmp/cnp-quality-gates');dest=root/'review/completion-soak';env=os.environ.copy();env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH']
for line in pathlib.Path('/private/tmp/cnp-pilot-local-stack/pilot.env').read_text().splitlines():
 if line and not line.startswith('#') and '=' in line:
  k,v=line.split('=',1);env[k]=v.strip().strip(chr(34)).strip(chr(39))
name='synthetic-30-minute-soak';cmd=['node','scripts/pilot/test-local-soak.mjs'];start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (dest/(name+'.log')).open('wb') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
data=(dest/(name+'.log')).read_bytes();d={'command':cmd,'cwd':str(root),'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'started_at':start,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':r.returncode,'log':name+'.log','sha256':hashlib.sha256(data).hexdigest()};(dest/(name+'.json')).write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d));print(data.decode(errors='replace')[-2500:]);sys.exit(r.returncode)
