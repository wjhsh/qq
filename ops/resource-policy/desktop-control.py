"""Remote desktop on demand; never stop QQ, Xvfb, SnowLuma, or change login data."""
import json,os,subprocess,sys
from pathlib import Path

CONFIG=Path('/etc/qq-resource-policy/desktop.json')
CONTAINER='codex-qq-trial'
CONTROL=r'''
import json,os,signal,subprocess,time
from pathlib import Path
action=__import__('sys').argv[1]
matched=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit() or int(p.name)==os.getpid():continue
 try:
  args=[s.decode('utf-8','replace') for s in (p/'cmdline').read_bytes().split(b'\0') if s]
  if not args:continue
  if Path(args[0]).name=='x11vnc' or '/opt/noVNC/utils/novnc_proxy' in args or any(s.startswith('/opt/noVNC/utils/websockify/') for s in args):matched.append((int(p.name),Path(args[0]).name))
 except OSError:pass
if action=='off':
 for pid,name in matched:
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
 time.sleep(.3)
elif action=='on':
 if not any(name=='x11vnc' for pid,name in matched):
  subprocess.Popen(['x11vnc','-display',os.environ.get('DISPLAY',':1'),'-noxrecord','-noxfixes','-noxdamage','-forever','-threads','-rfbauth','/root/.vnc/passwd'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 if not any(name!='x11vnc' for pid,name in matched):
  subprocess.Popen(['/opt/noVNC/utils/novnc_proxy','--vnc','localhost:5900','--listen','6081','--file-only'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 time.sleep(.5)
print(json.dumps({'action':action,'desktop_processes_before':len(matched)}))
'''

def main():
    command=sys.argv[1] if len(sys.argv)>1 else 'status'
    if command not in ['on','off','enforce','status']:raise SystemExit('usage: desktop-control.py on|off|enforce|status')
    if command in ['on','off']:
        CONFIG.parent.mkdir(mode=0o700,exist_ok=True);CONFIG.write_text(json.dumps({'mode':command}));CONFIG.chmod(0o600)
    mode=json.loads(CONFIG.read_text()).get('mode','off') if CONFIG.exists() else 'off'
    ready=None
    if command in ['off','enforce']:
        sys.path.insert(0,'/opt/codex-qq/guardian')
        try:
            from snowluma_transport import Snowluma
            ready=bool(Snowluma().capture().get('ready'))
        except Exception:ready=False
    # Keep a desktop available when login/verification or the controller needs attention.
    action=('on' if mode=='on' or not ready else 'off') if command in ['off','enforce'] else command
    result=subprocess.run(['docker','exec',CONTAINER,'python3','-c',CONTROL,action],capture_output=True,text=True,timeout=15)
    if result.returncode:raise SystemExit('desktop_control_failed')
    print(json.dumps({'requested_mode':mode,'qq_ready':ready,'result':json.loads(result.stdout)},ensure_ascii=False))

if __name__=='__main__':main()
