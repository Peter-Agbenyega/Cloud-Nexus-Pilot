import sys,pathlib,subprocess,os,json,hashlib,datetime
root=pathlib.Path('/private/tmp/cnp-quality-gates');dest=root/'review/completion-server';env=os.environ.copy();env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH'];env['NEXT_TELEMETRY_DISABLED']='1'
if os.environ.get('CNP_PILOT_ENV'):
 for line in pathlib.Path(os.environ['CNP_PILOT_ENV']).read_text().splitlines():
  if line and not line.startswith('#') and '=' in line:
   k,v=line.split('=',1);env[k]=v.strip().strip(chr(34)).strip(chr(39))
name=sys.argv[1];cmd=sys.argv[2:];start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (dest/(name+'.log')).open('wb') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
data=(dest/(name+'.log')).read_bytes();record={'command':cmd,'cwd':str(root),'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'started_at':start,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':r.returncode,'log':name+'.log','sha256':hashlib.sha256(data).hexdigest()};(dest/(name+'.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));print(data.decode(errors='replace')[-3500:]);sys.exit(r.returncode)
