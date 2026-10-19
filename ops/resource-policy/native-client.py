"""Bounded maintenance for the single existing QQ client; no arbitrary shell or credentials output."""
import configparser,fcntl,hashlib,json,os,re,shutil,subprocess,sys,time
from pathlib import Path

ROOT=Path('/var/lib/qq-client-control')
SUPERVISOR=Path('/opt/codex-qq/snowluma-trial/supervisord.baseline.conf')
CONTAINER='codex-qq-trial'
COMMANDS={'compact','baseline','restart','minimize','show','desktop-on','desktop-off','status'}

def run(args,timeout=20,check=True):
    r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if check and r.returncode:raise RuntimeError('maintenance_command_failed:'+args[0])
    return r

def save(value):
    ROOT.mkdir(mode=0o700,exist_ok=True);temp=ROOT/'status.tmp';temp.write_text(json.dumps(value,ensure_ascii=False,indent=2));temp.chmod(0o600);temp.replace(ROOT/'status.json')

def native():
    sys.path.insert(0,'/opt/codex-qq/guardian')
    from snowluma_transport import Snowluma
    return Snowluma()

METRICS=r'''
import json,os
from pathlib import Path
out={'qq_pss_kib':0,'qq_swap_pss_kib':0,'qq_rss_kib':0,'qq_processes':0,'main_pids':[],'compact_flags_seen':False}
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if os.readlink(p/'exe')!='/opt/QQ/qq':continue
  args=[x.decode('utf8','replace') for x in (p/'cmdline').read_bytes().split(bytes([0])) if x]
  values={}
  for line in (p/'smaps_rollup').read_text().splitlines():
   f=line.split()
   if len(f)>1 and f[1].isdigit():values[f[0].rstrip(':')]=int(f[1])
  out['qq_pss_kib']+=values.get('Pss',0);out['qq_rss_kib']+=values.get('Rss',0);out['qq_swap_pss_kib']+=values.get('SwapPss',0);out['qq_processes']+=1
  if not any(a.startswith('--type=') for a in args):out['main_pids'].append(int(p.name))
  if any('--max-old-space-size=192' in a for a in args):out['compact_flags_seen']=True
 except OSError:pass
out['qq_total_pss_and_swap_kib']=out['qq_pss_kib']+out['qq_swap_pss_kib']
print(json.dumps(out))
'''

WINDOWS=r'''
import ctypes,json,os,re,subprocess,sys
from ctypes import c_char_p,c_int,c_ulong,c_void_p
action=sys.argv[1]
r=subprocess.run(['xwininfo','-root','-tree'],capture_output=True,text=True,timeout=5)
ids=[]
for line in r.stdout.splitlines():
 m=re.search(r'(0x[0-9a-f]+) "(?:QQ|qq)": .*? (\d+)x(\d+)\+',line)
 if m and int(m[2])>100 and int(m[3])>100:ids.append(int(m[1],16))
x=ctypes.CDLL('libX11.so.6');x.XOpenDisplay.argtypes=[c_char_p];x.XOpenDisplay.restype=c_void_p
x.XDefaultScreen.argtypes=[c_void_p];x.XDefaultScreen.restype=c_int
x.XIconifyWindow.argtypes=[c_void_p,c_ulong,c_int];x.XMapRaised.argtypes=[c_void_p,c_ulong]
x.XFlush.argtypes=[c_void_p];x.XCloseDisplay.argtypes=[c_void_p]
d=x.XOpenDisplay(os.environ.get('DISPLAY',':1').encode())
if not d:raise SystemExit('display_unavailable')
try:
 for w in ids:
  if action=='minimize':x.XIconifyWindow(d,w,x.XDefaultScreen(d))
  else:x.XMapRaised(d,w)
 x.XFlush(d)
finally:x.XCloseDisplay(d)
print(json.dumps({'action':action,'windows':len(ids)}))
'''

def metrics():return json.loads(run(['docker','exec',CONTAINER,'python3','-c',METRICS]).stdout)
def windows(action):
    result=run(['docker','exec',CONTAINER,'python3','-c',WINDOWS,action],check=False)
    return json.loads(result.stdout) if result.returncode==0 else {'action':action,'windows':0,'available':False}
def desktop(action):return json.loads(run(['python3','/opt/codex-qq/resource-policy/desktop-control.py',action]).stdout)

def capture(client):
    try:return client.capture()
    except Exception as exc:return {'reachable':False,'ready':False,'phase':'controller_unavailable','error':type(exc).__name__}

def desktop_safe(action):
    try:return desktop(action)
    except Exception as exc:return {'available':False,'error':type(exc).__name__}

def read_state(name,default=None):
    try:return json.loads((ROOT/name).read_text())
    except (OSError,ValueError):return default

def status():
    client=native()
    result={'native':capture(client),'profile':read_state('profile.json',{'profile':'baseline'}).get('profile','baseline'),'last':read_state('status.json')}
    try:result['metrics']=metrics()
    except Exception as exc:result['metrics']={'available':False,'error':type(exc).__name__}
    try:result['desktop']=json.loads(Path('/etc/qq-resource-policy/desktop.json').read_text()).get('mode','off')
    except (OSError,ValueError):result['desktop']='unknown'
    result['checked_at']=time.time()
    return result

def load_config(data):
    c=configparser.ConfigParser(interpolation=None);c.read_string(data)
    if not c.has_section('program:qq'):raise ValueError('QQ supervisor configuration missing')
    return c

def profile_config(original,profile,baseline=None):
    if profile not in ['compact','baseline']:raise ValueError('unknown client profile')
    # Use the verified vendor startup for both modes. Compact controls the UI and
    # on-demand desktop only; experimental V8 caps had no measured benefit.
    current=load_config(original)
    if baseline is None:return original
    command=load_config(baseline).get('program:qq','command')
    if current.get('program:qq','command')==command:return original
    pattern=r'(?ms)(^\[program:qq\][^\r\n]*\r?\n)(.*?)(?=^\[|\Z)'
    def section(match):
        body,count=re.subn(r'(?m)^command\s*=[^\r\n]*',lambda _: 'command='+command,match[2],count=1)
        if count!=1:raise ValueError('QQ command entry missing')
        return match[1]+body
    updated,count=re.subn(pattern,section,original,count=1)
    if count!=1:raise ValueError('QQ supervisor section missing')
    return updated

def attach_managed_client(client):
    """Only after owner maintenance: pre-load the sole QQ in the fixed container.

    An unhooked client may report UIN 0 even after UI sign-in. Loading never
    proves login: capture still requires the exact expected account afterwards.
    """
    rows=client.call('/processes').get('list',[])
    pids=metrics().get('main_pids',[])
    if len(pids)!=1:return False
    candidates=[row for row in rows if row.get('pid')==pids[0] and row.get('name')=='qq' and row.get('injected') is False
        and str(row.get('uin','0')) in ['0','10002'] and str((row.get('account') or {}).get('uin','0')) in ['0','10002']]
    if len(candidates)!=1:return False
    client.call('/processes/'+str(pids[0])+'/load',{})
    return True

def recover(client,seconds=65):
    end=time.monotonic()+seconds;last={};attached=False
    while time.monotonic()<end:
        try:
            last=client.capture()
            if last.get('ready'):return last
            if not attached:
                if last.get('attach'):client.attach();attached=True
                elif attach_managed_client(client):attached=True
        except Exception:pass
        time.sleep(2)
    return last

def operate(action):
    if action not in COMMANDS:raise ValueError('unknown QQ maintenance action')
    if action=='status':return status()
    ROOT.mkdir(mode=0o700,exist_ok=True)
    with (ROOT/'lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('另一个QQ维护操作正在运行')
        client=native();before=capture(client);before_metrics=metrics()
        baseline_file=ROOT/'baseline-supervisord.conf'
        changes_startup=action in ['compact','baseline'] and baseline_file.exists() and profile_config(SUPERVISOR.read_text(),action,baseline_file.read_text())!=SUPERVISOR.read_text()
        if action=='restart' or changes_startup:
            prior=read_state('restart-cooldown.json',{})
            if 0<=time.time()-prior.get('started',0)<180:raise ValueError('QQ客户端重启冷却中，请等待3分钟；无需重复提交')
            temp=ROOT/'restart-cooldown.tmp';temp.write_text(json.dumps({'started':time.time()}));temp.chmod(0o600);temp.replace(ROOT/'restart-cooldown.json')
        state={'action':action,'phase':'running','started':time.time(),'before_native':before,'before_metrics':before_metrics}
        save(state)
        if action in ['minimize','show','desktop-on','desktop-off']:
            try:
                if action=='minimize' and not before.get('ready'):raise ValueError('QQ未登录就绪，保留验证窗口')
                state['result']=desktop(action.split('-')[1]) if action.startswith('desktop-') else windows(action)
                if action=='desktop-on':state['window_result']=windows('show')
                state.update(phase='succeeded',finished=time.time(),after_native=capture(client));save(state);return state
            except Exception as exc:
                state.update(phase='failed',finished=time.time(),error=type(exc).__name__);save(state);raise
        timers_active=run(['systemctl','is-active','qq-guardian.timer'],check=False).returncode==0
        backup=ROOT/('backup-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()));backup.mkdir(mode=0o700)
        config_before=SUPERVISOR.read_text();(backup/'supervisord.conf').write_text(config_before)
        baseline=ROOT/'baseline-supervisord.conf'
        if not baseline.exists():baseline.write_text(config_before);baseline.chmod(0o600)
        root_profile=ROOT/'profile.json';profile_before=root_profile.read_bytes() if root_profile.exists() else None
        try:
            run(['systemctl','stop','qq-guardian.timer','qq-guardian.service'])
            # Native QQ, controller and data volume are kept in the same existing container.
            if action in ['compact','baseline']:
                next_config=profile_config(config_before,action,baseline.read_text())
                state['client_restarted']=next_config!=config_before
                if next_config!=config_before:
                    SUPERVISOR.write_text(next_config)
                    run(['docker','exec',CONTAINER,'supervisorctl','reread'])
                    run(['docker','exec',CONTAINER,'supervisorctl','update','qq'],timeout=35)
                root_profile.write_text(json.dumps({'profile':action}));root_profile.chmod(0o600)
            else:
                sys.path.insert(0,'/opt/codex-qq/guardian')
                from cloud_transport import restart_client
                restart_client()
            state['phase']='reconnecting';save(state)
            after=recover(client)
            if not after.get('ready'):
                state.update(phase='needs_login',after_native=after,finished=time.time())
                state['desktop']=desktop_safe('on');windows('show');save(state);return state
            state['window_result']=windows('show' if action=='baseline' else 'minimize')
            state['desktop']=desktop_safe('on' if action=='baseline' else 'off')
            state.update(phase='succeeded',after_native=after,after_metrics=metrics(),finished=time.time(),backup=str(backup));save(state);return state
        except Exception as exc:
            SUPERVISOR.write_text(config_before)
            if profile_before is None:root_profile.unlink(missing_ok=True)
            else:root_profile.write_bytes(profile_before)
            run(['docker','exec',CONTAINER,'supervisorctl','reread'],check=False)
            run(['docker','exec',CONTAINER,'supervisorctl','update','qq'],timeout=35,check=False)
            after=recover(client,35)
            state.update(phase='rolled_back' if after.get('ready') else 'needs_attention',error=type(exc).__name__,after_native=after,finished=time.time(),backup=str(backup));save(state);raise
        finally:
            if timers_active:run(['systemctl','start','qq-guardian.timer'],check=False)

if __name__=='__main__':
    action=sys.argv[1] if len(sys.argv)>1 else 'status'
    try:print(json.dumps(operate(action),ensure_ascii=False),flush=True)
    except Exception as exc:print(json.dumps({'error':str(exc)[:150]},ensure_ascii=False),flush=True);raise SystemExit(1)
