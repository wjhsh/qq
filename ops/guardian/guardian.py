"""Cloud-local QQ / proxy guardian. Only fixed actions; survives Google outages."""
import concurrent.futures,fcntl,hashlib,hmac,json,os,re,subprocess,sys,time,urllib.error,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path
from guardian_policy import decide,auth_result,observe,SERVICES
from snowluma_transport import Snowluma

ROOT=Path('/var/lib/qq-guardian');PRIVATE=ROOT/'private';CONFIG=Path('/etc/qq-guardian')
NAPCAT=Path('/var/lib/qq-agent/Napcat/opt/QQ/resources/app/app_launcher/napcat')
UIN='10002'
DIRECT=urllib.request.build_opener(urllib.request.ProxyHandler({}))
PROXY=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'}))
def stamp():return datetime.now(timezone.utc).isoformat(timespec='seconds')
def write_json(file,value,mode=0o600):
    temporary=file.with_name(file.name+'.tmp')
    with temporary.open('w') as stream:json.dump(value,stream,ensure_ascii=False,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.chmod(temporary,mode);os.replace(temporary,file)
def read_json(file,default=None):return json.loads(file.read_text()) if file.exists() else default
def transport_mode():
    try:return str(read_json(CONFIG/'transport.json',{}).get('mode','napcat'))
    except (OSError,ValueError,TypeError):return 'invalid'
def json_http(url,body=None,headers=None,timeout=5,method=None):
    request=urllib.request.Request(url,headers=headers or {},data=json.dumps(body).encode() if body is not None else None,method=method)
    if body is not None:request.add_header('Content-Type','application/json')
    with DIRECT.open(request,timeout=timeout) as response:
        raw=response.read(512*1024+1)
        if len(raw)>512*1024:raise ValueError('response_too_large')
        return json.loads(raw) if raw else {}
class Napcat:
    def __init__(self):self.credential=None
    def call(self,route,body=None):
        if self.credential is None:
            config=read_json(NAPCAT/'config/webui.json')
            result=json_http('http://127.0.0.1:6099/api/auth/login',{'hash':hashlib.sha256((config['token']+'.napcat').encode()).hexdigest()})
            self.credential=result['data']['Credential']
        return json_http('http://127.0.0.1:6099/api'+route,body or {},{'Authorization':'Bearer '+self.credential},timeout=20 if route in ['/QQLogin/PasswordLogin','/QQLogin/SetQuickLogin'] else 5)
def credential():
    value=read_json(CONFIG/'credential.json',{})
    if value.get('uin')!=UIN or not re.fullmatch('[a-fA-F0-9]{32}',str(value.get('password_md5',''))):return None
    return value
def reachable(url,proxy=False):
    try:
        with (PROXY if proxy else DIRECT).open(url,timeout=5) as response:return 200<=response.status<500
    except urllib.error.HTTPError as error:return 200<=error.code<500 and error.code not in [407,429]
    except Exception:return False
def proxy_local():
    config=read_json(Path('/etc/codex-mihomo/config.yaml'))
    json_http('http://127.0.0.1:19090/version',headers={'Authorization':'Bearer '+config['secret']},timeout=3)
    return True
def gateway():
    config=read_json(Path('/etc/codex-gateway/config.yaml'))
    key=config['access']['api-keys'][0]
    try:
        data=json_http('http://127.0.0.1:8317/v1/models',headers={'Authorization':'Bearer '+key},timeout=4)
        return {'ready':isinstance(data.get('data'),list),'error':''}
    except urllib.error.HTTPError as error:
        return{'ready':False,'error':'auth' if error.code in [401,403] else 'quota' if error.code==429 else 'network'}
def console():
    cfg=read_json(Path('/var/lib/qq-agent/config.json'))
    data=json_http('http://127.0.0.1:3210/api/status',headers={'x-console-token':cfg['server']['token']},timeout=4)
    return {'connected':data.get('onebot',{}).get('connected') is True,'reachable':True}
def onebot():
    token=Path('/var/lib/qq-agent/onebot-token').read_text().strip()
    for file in ([] if transport_mode()=='snowluma' else [NAPCAT/('config/onebot11_'+UIN+'.json'),NAPCAT/('config/onebot_'+UIN+'.json')]):
        if not file.exists():continue
        value=read_json(file,{})
        network=value.get('network',value.get('networks',{}))
        http=next((server for server in network.get('httpServers',[]) if str(server.get('port'))=='3000'),None)
        if http:token=str(http.get('token',http.get('accessToken',token)));break
    data=json_http('http://127.0.0.1:3000/get_status',{},headers={'Authorization':'Bearer '+token},timeout=4)
    return data.get('retcode')==0 and data.get('data',{}).get('online') is True
def onebot_direct():
    from onebot_bridge import container_ip
    token=Path('/var/lib/qq-agent/onebot-token').read_text().strip()
    data=json_http('http://'+container_ip()+':3000/get_status',{},headers={'Authorization':'Bearer '+token},timeout=4)
    return data.get('retcode')==0 and data.get('data',{}).get('online') is True
def capture_login(client):
    if isinstance(client,Snowluma):return client.capture()
    data=client.call('/QQLogin/CheckLoginStatus').get('data',{})
    ready=data.get('isLogin') is True and data.get('coreReady') is True and data.get('isOffline') is not True
    available=False
    if not ready:
        accounts=client.call('/QQLogin/GetQuickLoginList').get('data') or []
        available=any((str(a.get('uin',a.get('qq',''))) if isinstance(a,dict) else str(a))==UIN for a in accounts)
    return{'reachable':True,'ready':ready,'phase':str(data.get('loginPhase',''))[:50],'quick':available}
def sample(client):
    mode=transport_mode()
    checks={'proxy_local':proxy_local,'gateway':gateway,
      'google204':lambda:reachable('https://www.gstatic.com/generate_204',True),'google_oauth':lambda:reachable('https://oauth2.googleapis.com/',True)}
    if mode in ['napcat','snowluma']:checks.update(native=lambda:capture_login(client),console=console,onebot=onebot)
    if mode=='snowluma':checks['onebot_direct']=onebot_direct
    results={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
        futures={name:pool.submit(fn) for name,fn in checks.items()}
        for name,future in futures.items():
            try:results[name]=future.result()
            except Exception:results[name]=None
    login=results.get('native') or {};console_state=results.get('console') or {};model=results.get('gateway') or {}
    secret=credential()
    return{'native_reachable':login.get('reachable',False),'login_ready':login.get('ready',False),'phase':login.get('phase','unreachable'),'quick_available':login.get('quick',False),
      'onebot_online':results.get('onebot'),'onebot_connected':console_state.get('connected',False),'agent_reachable':console_state.get('reachable',False),'onebot_direct_online':results.get('onebot_direct'),'snowluma_attach_available':login.get('attach',False),
      'proxy_local_ready':results.get('proxy_local') is True,'proxy_outbound_ok':results.get('google204') is True or results.get('google_oauth') is True,
      'gateway_ready':model.get('ready',False),'gateway_error':model.get('error','network'),
      'credential_configured':secret is not None,'credential_generation':str(secret.get('generation','')) if secret else '',
      'paused':(CONFIG/'paused').exists(),'risk_blocked':read_json(CONFIG/'qq-risk.json',{}).get('auth_paused') is True,'checked_at':stamp(),'transport_mode':mode}
def event(value):
    file=PRIVATE/'events.jsonl'
    if file.exists() and file.stat().st_size>1024*1024:os.replace(file,file.with_suffix('.jsonl.1'))
    with file.open('a') as stream:stream.write(json.dumps({'at':stamp(),**value},ensure_ascii=False)+'\n')
    os.chmod(file,0o600)

def trusted_kick_time(raw,since_us):
    """Only our native WARN evidence is authoritative; quoted group text is not."""
    latest=0
    for line in raw.splitlines():
        try:
            row=json.loads(line);at=int(row.get('__REALTIME_TIMESTAMP','0'))
            if at<=since_us:continue
            message=row.get('MESSAGE','')
            if isinstance(message,list):message=bytes(message).decode('utf8','replace')
            message=re.sub(r'\x1b\[[0-9;]*m','',message)
            match=re.match(r'^\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[warn\] (?:[^\r\n]*?\|\s*)?\[QQGuardian\] KickEvidence\s+(\{.*\})\s*$',message)
            if not match:continue
            value=json.loads(match.group(1))
            if not isinstance(value.get('fields'),list) or not isinstance(value.get('values'),dict):continue
            if not {'tipsTitle','tipsDesc'}.issubset(value['fields']):continue
            latest=max(latest,at)
        except (ValueError,TypeError):continue
    return latest

def watch_kicks(state,now_us):
    since=int(state.get('kick_watch_since_us',now_us))
    result=subprocess.run(['journalctl','-u','napcat-qq','--since','@'+str(since/1_000_000),'-n','100','--grep','QQGuardian.*KickEvidence','-o','json','--no-pager'],capture_output=True,text=True,timeout=5)
    # journalctl --grep returns 1 for an empty match set; it is healthy here.
    if result.returncode not in [0,1] or result.stderr.strip():raise RuntimeError('native_journal_unavailable')
    raw=result.stdout
    latest=trusted_kick_time(raw,since)
    state['kick_watch_since_us']=now_us
    if latest:
        state['forced_offline_hold']=True;state['last_native_kick_at_us']=latest
        event({'event':'native_forced_offline','timestamp_us':latest,'login_recovery_paused':True})
    return state
def incident(client,snapshot):
    # Store only connection/auth evidence; never message content, QR payloads or tokens.
    result={'snapshot':{k:v for k,v in snapshot.items() if k!='credential_generation'},'time':stamp(),'events':[]}
    raw=subprocess.run(['journalctl','-u','napcat-qq','--since','-4 minutes','-n','1800','-o','json','--no-pager'],capture_output=True,text=True,timeout=6).stdout
    for line in raw.splitlines():
        try:
            row=json.loads(line);text=row.get('MESSAGE','')
            if isinstance(text,list):text=bytes(text).decode('utf8','replace')
            if re.search(r'收到消息|接收消息|发送消息|(?:接收|发送)\s*(?:<-|->)|二维码|█|▄|▀',text):continue
            if not re.search('KickedOffLine|SelfOffline|QQGuardian|身份已失效|账号当前登录|账号已离线|快速登录失败|密码回退|Login Error',text,re.I):continue
            text=re.sub(r'https?://\S+','[url]',text);text=re.sub(r'\x1b\[[0-9;]*m','',text);text=re.sub(r'\b[A-Za-z0-9_+/=-]{32,}\b','[long-value]',text)
            result['events'].append({'time':row.get('__REALTIME_TIMESTAMP'),'message':text[:600]})
        except Exception:continue
    try:
        guid=client.call('/QQLogin/GetDeviceGUID').get('data',{}).get('guid','')
        if guid:result['device_identity_sha256']=hashlib.sha256(guid.encode()).hexdigest()
    except Exception:pass
    result['ntp']=subprocess.run(['timedatectl','show','-p','NTPSynchronized','--value'],capture_output=True,text=True,timeout=3).stdout.strip()
    write_json(PRIVATE/('incident-'+str(int(time.time()))+'.json'),result)
    files=sorted(PRIVATE.glob('incident-*.json'))
    for file in files[:-40]:file.unlink()
def perform(client,action):
    kind,target=action['kind'],action.get('target','')
    mode=transport_mode()
    qq_action=kind in ['quick_login','password_login','snowluma_attach'] or kind=='restart' and target in ['napcat-qq','qq-agent','qq-onebot-bridge','qq-cloud-transport']
    if qq_action and mode not in ['napcat','snowluma']:raise ValueError('transport_under_maintenance')
    if mode=='snowluma' and (kind in ['quick_login','password_login'] or target=='napcat-qq'):raise ValueError('unsupported_transport_action')
    if mode=='napcat' and (kind=='snowluma_attach' or target in ['qq-onebot-bridge','qq-cloud-transport']):raise ValueError('unsupported_transport_action')
    if kind=='snowluma_attach':
        if transport_mode()!='snowluma' or not isinstance(client,Snowluma):raise ValueError('transport_under_maintenance')
        return client.attach()
    if kind=='restart':
        if target not in SERVICES:raise ValueError('unit_not_allowed')
        subprocess.run(['systemctl','restart',target],check=True,timeout=35)
        return'scheduled'
    if kind=='proxy_auto':
        sys.path.insert(0,'/opt/codex-qq/harness')
        from cloud_controls import Controls
        controls=Controls();controls.switch('auto')
        # Existing fallback probes each candidate and retains the available selection.
        try:controls.control('/group/GOOGLE-AUTO/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000')
        except Exception:pass
        return'scheduled'
    if kind not in ['quick_login','password_login']:raise ValueError('action_not_allowed')
    body={'uin':UIN};route='/QQLogin/SetQuickLogin'
    if kind=='password_login':
        secret=credential()
        if not secret:return'credentials_required'
        body['passwordMd5']=secret['password_md5'];route='/QQLogin/PasswordLogin'
    result=client.call(route,body);data=result.get('data') or {}
    if data.get('needCaptcha') or data.get('needNewDevice'):
        write_json(PRIVATE/'challenge.json',{'at':stamp(),'data':data,'kind':'captcha' if data.get('needCaptcha') else 'new_device'})
        return'captcha_required' if data.get('needCaptcha') else 'device_confirmation_required'
    if result.get('code')==0:return'accepted'
    message=str(result.get('message',''))
    if kind=='quick_login' and re.search('身份|失效|过期',message):return'invalid_session'
    if re.search('验证|安全|新设备|异常设备',message):return'device_confirmation_required'
    if re.search('网络|network|超时|timeout',message,re.I):return'network_error'
    return'password_rejected' if kind=='password_login' else'invalid_session'

def main():
    ROOT.mkdir(mode=0o755,exist_ok=True);PRIVATE.mkdir(mode=0o700,exist_ok=True)
    os.chmod(ROOT,0o755);os.chmod(PRIVATE,0o700)
    lock=PRIVATE/'lock'
    with lock.open('w') as stream:
        try:fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        state=read_json(PRIVATE/'state.json',{'version':1});client=Snowluma() if transport_mode()=='snowluma' else Napcat()
        if transport_mode()=='napcat':
            try:state=watch_kicks(state,int(time.time()*1_000_000));kick_watch_ready=True
            except Exception:kick_watch_ready=False;event({'event':'native_kick_watch_unavailable'})
        else:kick_watch_ready=False
        snapshot=sample(client)
        snapshot['forced_offline_hold']=state.get('forced_offline_hold',False)
        old=state.get('last_public',{});next_state,actions,public=decide(snapshot,state,time.time())
        if snapshot['transport_mode']=='napcat' and old.get('qq')!=public.get('qq') and public.get('qq')!='online':
            try:incident(client,snapshot)
            except Exception:event({'event':'incident_capture_failed'})
        # Persist attempt reservations before touching a service or making a login request.
        write_json(PRIVATE/'state.json',next_state)
        results=[]
        for action in actions:
            try:result=perform(client,action)
            except Exception as error:result='network_error' if action['kind'].endswith('login') else 'action_failed'
            results.append({**action,'result':result})
            if action['kind'] in ['quick_login','password_login']:
                next_state=auth_result(next_state,action['kind'],result)
                if result in ['captcha_required','device_confirmation_required','password_rejected']:public['qq']=result
            write_json(PRIVATE/'state.json',next_state)
            event({'event':'recovery_attempt',**action,'result':result})
        next_state,public=observe(next_state,public,time.time())
        public.update({'version':1,'checked_at':stamp(),'interval_seconds':30,'actions':results,
          'onebot_connected':snapshot['onebot_connected'],'native_login_ready':snapshot['login_ready'] if snapshot['transport_mode'] in ['napcat','snowluma'] else None,
          'human_action_required':public['qq'] in ['credentials_required','captcha_required','device_confirmation_required','password_rejected','risk_device_blocked','forced_offline_review_required','official_qq_trial','transport_maintenance'],
          'uses_external_model':False,'deepseek_configured':False,'native_kick_watch_ready':kick_watch_ready,'transport_mode':snapshot['transport_mode']})
        next_state['last_public']=dict(public);write_json(PRIVATE/'state.json',next_state)
        write_json(ROOT/'status.json',public,0o644)
        if old.get('qq')!=public.get('qq') or results:print(json.dumps(public,ensure_ascii=False),flush=True)
if __name__=='__main__':main()
