"""Ensure one QQ client; native self-relaunches must not cause a second login."""
import json,subprocess,time
CONTAINER='codex-qq-trial'
INVENTORY=r'''
import json,os,pwd
from pathlib import Path
uid=pwd.getpwnam('snowluma').pw_uid;rows=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if os.readlink(p/'exe')!='/opt/QQ/qq' or p.stat().st_uid!=uid:continue
  args=[s.decode('utf8','replace') for s in (p/'cmdline').read_bytes().split(bytes([0])) if s]
  if any(s.startswith('--type=') for s in args):continue
  rows.append({'pid':int(p.name),'relaunch':'--relaunch' in args})
 except OSError:pass
print(json.dumps(rows))
'''
TERMINATE=r'''
import os,pwd,signal,sys
from pathlib import Path
pid=int(sys.argv[1]);p=Path('/proc')/str(pid)
if pid<=1:raise SystemExit('invalid_pid')
try:
 if os.readlink(p/'exe')!='/opt/QQ/qq' or p.stat().st_uid!=pwd.getpwnam('snowluma').pw_uid:raise SystemExit('not_managed_qq')
 args=(p/'cmdline').read_bytes().split(bytes([0]))
 if any(s.startswith(b'--type=') for s in args):raise SystemExit('not_main_process')
 os.kill(pid,signal.SIGTERM)
except FileNotFoundError:pass
'''
def run(args,check=True):return subprocess.run(args,capture_output=True,text=True,check=check,timeout=45)
def inventory():return json.loads(run(['docker','exec',CONTAINER,'python3','-c',INVENTORY]).stdout)
def client_plan(rows):
    if not isinstance(rows,list) or any(not isinstance(r,dict) or type(r.get('pid')) is not int or r['pid']<=1 for r in rows):raise ValueError('invalid QQ inventory')
    if len(rows)>1:raise ValueError('多个QQ主进程，停止自动创建新实例，请先检查')
    return 'keep' if rows else 'start'
def ensure_client():
    for attempt in range(15):
        result=run(['docker','exec',CONTAINER,'supervisorctl','status','qq'],False)
        if result.returncode in [0,3]:break
        time.sleep(1)
    plan=client_plan(inventory())
    if plan=='start':run(['docker','exec',CONTAINER,'supervisorctl','start','qq'])
    return plan
def restart_client():
    client_plan(inventory())
    run(['docker','exec',CONTAINER,'supervisorctl','stop','qq'],False)
    signalled=set()
    for attempt in range(12):
        rows=inventory()
        if client_plan(rows)=='start':
            run(['docker','exec',CONTAINER,'supervisorctl','start','qq']);return
        pid=rows[0]['pid']
        if pid not in signalled:
            run(['docker','exec',CONTAINER,'python3','-c',TERMINATE,str(pid)]);signalled.add(pid)
        time.sleep(.5)
    raise ValueError('原QQ进程尚未退出，没有启动第二份客户端')
def main():
    state=json.loads(run(['docker','inspect',CONTAINER]).stdout)[0]
    if not state['State']['Running']:run(['docker','start',CONTAINER])
    plan=ensure_client()
    run(['docker','exec',CONTAINER,'supervisorctl','restart','snowluma'])
    print('CLOUD_QQ_TRANSPORT_READY client='+plan,flush=True)
if __name__=='__main__':main()
