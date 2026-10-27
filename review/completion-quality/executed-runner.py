import subprocess,sys,pathlib,json,datetime,hashlib,os
root=pathlib.Path('/private/tmp/cnp-quality-gates');out=root/'review/completion-quality';out.mkdir(exist_ok=True)
name=sys.argv[1];cmd=sys.argv[2:];env=os.environ.copy();env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH'];env['NEXT_TELEMETRY_DISABLED']='1'
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/(name+'.log')).open('wb') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
raw=(out/(name+'.log')).read_bytes();d={'command':cmd,'cwd':str(root),'started_at':started,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':r.returncode,'log':name+'.log','sha256':hashlib.sha256(raw).hexdigest()};(out/(name+'.json')).write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d));print(raw.decode(errors='replace')[-2000:]);sys.exit(r.returncode)
