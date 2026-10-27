import subprocess,sys,pathlib,json,datetime,hashlib,os
root=pathlib.Path('/private/tmp/cnp-quality-gates'); out=root/'review/quality-gates'
name=sys.argv[1]; cmd=sys.argv[2:]; env=os.environ.copy(); env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH']; env['NEXT_TELEMETRY_DISABLED']='1'
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/(name+'.log')).open('wb') as f:
 r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
data=(out/(name+'.log')).read_bytes()
record={'command':cmd,'cwd':str(root),'started_at':start,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':r.returncode,'log':name+'.log','sha256':hashlib.sha256(data).hexdigest()}
(out/(name+'.json')).write_text(json.dumps(record,indent=2)+'\n'); print(json.dumps(record)); print(data.decode(errors='replace')[-2200:]); sys.exit(r.returncode)
