"""Owner-only fixed QQ operations, dispatched outside the broker's lifetime."""
import json,secrets,subprocess,threading,time
from pathlib import Path

ACTIONS=frozenset({'compact','baseline','restart','minimize','show','desktop-on','desktop-off'})
RESTARTS=frozenset({'compact','baseline','restart'})
ACTIVE=frozenset({'running','reconnecting'})

def run(args,timeout=20):
    result=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise ValueError('QQ维护操作未能启动，请查询状态；没有自动重复操作')
    return result.stdout

class QQMaintenance:
    def __init__(self,root):
        self.path=Path(root)/'qq-client-request.json'
        self.lock=threading.RLock()

    def saved(self):
        try:return json.loads(self.path.read_text())
        except (OSError,ValueError):return {}

    def save(self,value):
        temporary=self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value,ensure_ascii=False));temporary.chmod(0o600);temporary.replace(self.path)

    def snapshot(self):
        raw=json.loads(run(['/usr/bin/python3','/opt/codex-qq/resource-policy/native-client.py','status']))
        last=raw.get('last') or {}
        raw['last']={k:last[k] for k in ['action','phase','started','finished','error'] if k in last}
        with self.lock:raw['request']=self.saved()
        return raw

    def schedule(self,action):
        if not isinstance(action,str) or action not in ACTIONS:raise ValueError('不支持的QQ操作；请使用维护帮助')
        with self.lock:
            current=self.snapshot();now=time.time();prior=self.saved();last=current.get('last') or {}
            if last.get('phase') in ACTIVE and 0<=now-last.get('started',0)<180:
                raise ValueError('QQ维护正在进行，请等待后查询状态')
            if prior.get('scheduled') and 0<=now-prior.get('created',0)<180 and last.get('finished',0)<prior.get('created',0):
                raise ValueError('上一项QQ维护尚未完成，请勿重复提交')
            if action in RESTARTS and 0<=now-prior.get('last_restart_at',0)<180:
                raise ValueError('QQ客户端重启冷却中，请等待3分钟')
            if action=='minimize' and not current.get('native',{}).get('ready'):
                raise ValueError('QQ未登录就绪，请先处理登录窗口')
            request={'action':action,'created':now,'scheduled':True,'delay_seconds':4,
                'last_restart_at':now if action in RESTARTS else prior.get('last_restart_at',0)}
            # systemd owns the 4-second delay, so broker/agent restarts cannot lose the request.
            run(['systemd-run','--quiet','--collect','--unit=qq-client-dispatch-'+secrets.token_hex(6),
                '--on-active=4s','--timer-property=AccuracySec=1s','/usr/bin/systemctl','start','--no-block',
                'qq-client-control@'+action+'.service'])
            self.save(request)
            return request
