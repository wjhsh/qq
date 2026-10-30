#!/usr/bin/env python3
"""Fixed-path hash-guarded Bili client repair; backs up only source, never credentials."""

import pathlib,json,hashlib,subprocess,os,tempfile,stat,shutil,datetime,sys
plan=json.loads(pathlib.Path(__file__).with_name('upstream-video-repair.json').read_text(encoding='utf-8'));
if os.geteuid()!=0:raise SystemExit('Root is required for this fixed-path source repair')
root=pathlib.Path('/opt/codex-qq/bilibili/node_modules/@xzxzzx/bilibili-mcp/dist/bilibili')
revision=hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()[:10]
backup=pathlib.Path('/var/lib/qq-deploy/backups')/('bili-video-'+revision);stage=pathlib.Path('/var/lib/qq-deploy/staging')/('bili-video-'+revision)
def write(p,data,m):
 fd,tmp=tempfile.mkstemp(prefix='.bili-repair-',dir=p.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,m['mode']);os.chown(tmp,m['uid'],m['gid']);os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)

mode=sys.argv[1] if len(sys.argv)>1 else 'apply'
if mode not in ['apply','rollback']:raise SystemExit('Use apply or rollback')
if mode=='rollback':
 assert backup.is_dir() and not backup.is_symlink(),'Backup missing'
 meta=json.loads((backup/'meta.json').read_text());restore=[]
 for name,spec in plan['files'].items():
  p=root/name;b=backup/name;assert p.is_file() and not p.is_symlink() and b.is_file() and not b.is_symlink()
  assert hashlib.sha256(b.read_bytes()).hexdigest()==spec['old_sha256'],'Backup conflict'
  assert hashlib.sha256(p.read_bytes()).hexdigest() in [spec['old_sha256'],spec['new_sha256']],'Source changed; refusing rollback'
  restore.append((p,b.read_bytes(),meta['files'][name]))
 subprocess.run(['systemctl','stop','qq-bili-reader'],check=True)
 try:
  for p,data,m in restore:write(p,data,m)
 finally:subprocess.run(['systemctl','start','qq-bili-reader'],check=True)
 print(json.dumps({'rolled_back':True,'revision':revision,'credentials_changed':False}));raise SystemExit(0)

stage.mkdir(mode=0o755,parents=True,exist_ok=True);prepared=[]
for name,spec in plan['files'].items():
 assert name in ['video-api.js','http.js','wbi.js']
 p=root/name;assert p.is_file() and not p.is_symlink();raw=p.read_bytes();digest=hashlib.sha256(raw).hexdigest()
 if digest==spec['new_sha256']:prepared.append((name,p,raw,raw,True));continue
 assert digest==spec['old_sha256'],'Vendor source conflict; not stopped'
 text=raw.decode()
 for item in spec['replacements']:
  assert text.count(item['before'])==1,'Patch context conflict'
  text=text.replace(item['before'],item['after'])
 new=text.encode();assert hashlib.sha256(new).hexdigest()==spec['new_sha256']
 candidate=stage/name;candidate.write_bytes(new)
 r=subprocess.run(['node','--check',str(candidate)],capture_output=True,text=True);assert r.returncode==0,'Candidate syntax error'
 prepared.append((name,p,raw,new,False))
if all(item[4] for item in prepared):print(json.dumps({'already_applied':True,'backup':str(backup)}));raise SystemExit(0)
assert not any(item[4] for item in prepared),'Partial pre-existing release; refusing'
assert not backup.exists(),'Backup already exists; refusing overwrite'
backup.mkdir(mode=0o700);backup.chmod(0o700)
meta={'revision':revision,'source':'DeepSeek auth proposal + coordinator WBI/diagnostic correction','reference':plan['reference'],'files':{},'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
for name,p,raw,new,_ in prepared:
 s=p.stat();b=backup/name;b.write_bytes(raw);b.chmod(0o600)
 meta['files'][name]={'old_sha256':hashlib.sha256(raw).hexdigest(),'new_sha256':hashlib.sha256(new).hexdigest(),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
(backup/'meta.json').write_text(json.dumps(meta,indent=2));(backup/'meta.json').chmod(0o600)
subprocess.run(['systemctl','stop','qq-bili-reader'],check=True)
try:
 for name,p,raw,new,_ in prepared:
  assert hashlib.sha256(p.read_bytes()).hexdigest()==meta['files'][name]['old_sha256'],'Source race'
  write(p,new,meta['files'][name])
 subprocess.run(['systemctl','start','qq-bili-reader'],check=True)
except BaseException:
 for name,p,raw,new,_ in prepared:write(p,raw,meta['files'][name])
 subprocess.run(['systemctl','start','qq-bili-reader'],check=True);raise
version=json.loads((root.parents[1]/'package.json').read_text()).get('version')
result={'applied':True,'backup':str(backup),'revision':revision,'package_version':version,'files_verified':all(hashlib.sha256(p.read_bytes()).hexdigest()==meta['files'][name]['new_sha256'] for name,p,raw,new,_ in prepared),'credentials_changed':False,'qq_agent_restarted':False,'service':subprocess.run(['systemctl','is-active','qq-bili-reader'],capture_output=True,text=True).stdout.strip()}
print(json.dumps(result),flush=True)
