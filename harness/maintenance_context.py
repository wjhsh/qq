"""Bounded, read-only diagnostic context. No secrets, chat bodies or raw logs."""
import collections,hashlib,json,re,subprocess,time,urllib.request
from datetime import datetime,timezone
from pathlib import Path

GUIDE=Path(__file__).with_name('MAINTAINER.md')
SERVICES=('qq-agent','qq-harness','qq-onebot-bridge','codex-gateway','codex-mihomo','qq-mobile-console')
EGRESS_CHECK=('python3','/opt/codex-qq/ops/gateway-egress-guard.py','check')
def run(args):
 try:return subprocess.run(args,capture_output=True,text=True,timeout=5).stdout
 except (OSError,subprocess.SubprocessError):return ''
def category(text):
 text=str(text)
 for code,pattern in [('request_guard',r'GOOGLE_REQUEST_GUARD|保护冷却'),('capacity_exhausted',r'MODEL_CAPACITY_EXHAUSTED|No capacity available'),('provider_unavailable',r'auth_unavailable|no auth available'),('upstream_internal',r'Internal error encountered|HTTP 500'),('timeout',r'超时|timeout|timed out|deadline exceeded'),('rate_limit',r'HTTP 429|rate.limit'),('authentication',r'HTTP 401|invalid_token'),('policy_block',r'content.policy|内容安全|safety_violation'),('memory_limit',r'oom.kill|内存限制'),('workspace_limit',r'128MiB|4000文件')]:
  if re.search(pattern,text,re.I):return code
 return 'other' if text else ''
def safe_model(value):
 return value if isinstance(value,str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,99}',value) else None
def protection_policy(api):
 """Only typed, bounded policy fields; endpoint/key selectors stay private."""
 recovery=api.get('preferredRecovery');recovery=recovery if isinstance(recovery,dict) else {}
 guard=api.get('requestGuard');guard=guard if isinstance(guard,dict) else {}
 safe_guard={'enabled':guard.get('enabled') if type(guard.get('enabled')) is bool else None}
 for name in ['minIntervalMs','maxQueue','rateLimitCooldownMs','unavailableCooldownMs','networkCooldownMs']:
  value=guard.get(name)
  safe_guard[name]=value if type(value) is int and 0<=value<=3600000 else None
 return {'preferred_recovery':{'enabled':recovery.get('enabled') if type(recovery.get('enabled')) is bool else None,'model':safe_model(recovery.get('model'))},'request_guard':safe_guard}
def gateway_egress_status():
 # A service being active only proves installation was attempted. Inspect the
 # exact current IPv4/IPv6 rules and never include the command's raw output.
 result={'checked_at':datetime.now(timezone.utc).isoformat(timespec='seconds'),'status':'unknown'}
 try:completed=subprocess.run(list(EGRESS_CHECK),capture_output=True,text=True,timeout=8)
 except (OSError,subprocess.SubprocessError):return {**result,'reason':'check_unavailable'}
 if completed.returncode!=0:return {**result,'reason':'check_failed'}
 try:value=json.loads(completed.stdout)
 except (ValueError,TypeError):return {**result,'reason':'invalid_response'}
 if not isinstance(value,dict) or value.get('action')!='check' or not isinstance(value.get('families'),dict):return {**result,'reason':'invalid_response'}
 families={}
 for family,label in [('4','ipv4'),('6','ipv6')]:
  row=value['families'].get(family)
  names=('jump_present','chain_matches','output_jump_first')
  if not isinstance(row,dict) or any(type(row.get(name)) is not bool for name in names):return {**result,'reason':'invalid_response'}
  families[label]={name:row[name] for name in names}
 result['families']=families
 result['status']='verified' if all(all(row.values()) for row in families.values()) else 'not_verified'
 return result
def agent_status(cfg):
 try:
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  request=urllib.request.Request('http://127.0.0.1:3210/api/status',headers={'x-console-token':cfg.get('server',{}).get('token','')})
  with opener.open(request,timeout=3) as response:value=json.load(response)
  orches=value.get('orchestrator') or {}
  return {'qq_connected':value.get('onebot',{}).get('connected'),'paused':orches.get('paused'),'running_count':len(orches.get('running') or []),'waiting_count':len(orches.get('waiting') or [])}
 except Exception:return {'available':False}
def collect(root,agent_root=Path('/var/lib/qq-agent'),mem_file=Path('/proc/meminfo')):
 root=Path(root);agent_root=Path(agent_root);cfg={}
 try:cfg=json.loads((agent_root/'config.json').read_text())
 except (OSError,ValueError):pass
 mem={}
 try:mem={k:int(v.split()[0])//1024 for k,v in (x.split(':',1) for x in Path(mem_file).read_text().splitlines()) if k in ['MemTotal','MemAvailable','SwapTotal','SwapFree']}
 except (OSError,ValueError):pass
 result={'captured_at':datetime.now(timezone.utc).isoformat(timespec='seconds'),'scope':'read_only_snapshot_no_chat_bodies_or_credentials','services':{},'memory_mib':mem,
  'chat_policy':{'model':cfg.get('api',{}).get('model'),'request_timeout_ms':cfg.get('api',{}).get('timeoutMs'),'request_retries':cfg.get('api',{}).get('requestRetryAttempts',2),'session_retries':cfg.get('sessionRetryAttempts'),'max_concurrent_runs':cfg.get('maxConcurrentRuns')},'recent_logs':{},'recent_sessions':[],'recent_jobs':[]}
 result['chat_policy']['fallback_models']=[str(row.get('model',''))[:100] for row in cfg.get('api',{}).get('fallbackModels',[]) if isinstance(row,dict)]
 result['chat_policy']['fallback_after_ms']=cfg.get('api',{}).get('fallbackAfterMs')
 result['chat_policy'].update(protection_policy(cfg.get('api',{})))
 result['gateway_egress_guard']=gateway_egress_status()
 result['agent_runtime']=agent_status(cfg)
 for service in SERVICES:
  text=run(['systemctl','show',service,'--property=ActiveState,SubState,NRestarts,MemoryCurrent'])
  result['services'][service]=dict(x.split('=',1) for x in text.splitlines() if '=' in x)
 for service in ['qq-agent','codex-gateway','codex-mihomo']:
  text=run(['journalctl','--no-pager','-u',service,'--since','-2 hours','-n','180','-o','json'])
  events=[];durations=[]
  for line in text.splitlines():
   try:row=json.loads(line)
   except ValueError:continue
   message=str(row.get('MESSAGE',''));kind=category(message)
   if kind and kind!='other':events.append({'at_us':row.get('__REALTIME_TIMESTAMP'),'category':kind})
   match=re.search(r'\]\s+(\d{3})\s*\|\s*([0-9.]+)(ms|s)\s*\|.*POST\s+"/v1/chat/completions"',message)
   if match:durations.append({'http_status':int(match[1]),'seconds':round(float(match[2])/(1000 if match[3]=='ms' else 1),3)})
  result['recent_logs'][service]={'event_counts':dict(collections.Counter(x['category'] for x in events)),'last_events':events[-10:],'recent_request_times':durations[-12:]}
 try:paths=sorted((agent_root/'sessions').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:100]
 except OSError:paths=[]
 for path in paths:
  try:
   if path.stat().st_size>2*1024*1024:continue
   value=json.loads(path.read_text());chat=str(value.get('chatKey',''))
   start=value.get('startedAt') or 0;end=value.get('endedAt') or int(time.time()*1000)
   result['recent_sessions'].append({'chat':chat.split(':')[0]+'#'+hashlib.sha256(chat.encode()).hexdigest()[:6],'status':value.get('status'),'started_at_ms':start,'elapsed_seconds':max(0,round((end-start)/1000,1)),'sent_count':len(value.get('sent') or []),'error_category':category(value.get('error',''))})
  except (OSError,ValueError,TypeError):continue
 try:paths=sorted((root/'state').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:12]
 except OSError:paths=[]
 for path in paths:
  try:
   value=json.loads(path.read_text());result['recent_jobs'].append({k:value.get(k) for k in ['id','engine','mode','status','created','error_code']})
  except (OSError,ValueError):continue
 return result

def prepare(work,root):
 work=Path(work)
 # Do not follow workspace links; this runs only in a freshly-created task.
 for name in ['server-diagnostics.json','MAINTAINER.md']:
  if (work/name).exists() or (work/name).is_symlink():raise ValueError('诊断资料路径已存在')
 (work/'server-diagnostics.json').write_text(json.dumps(collect(root),ensure_ascii=False,indent=2),encoding='utf8')
 (work/'MAINTAINER.md').write_text(GUIDE.read_text('utf8'),encoding='utf8')
 return '先阅读/workspace/work/MAINTAINER.md和server-diagnostics.json。诊断快照只代表采集时刻；基于证据区分已确认、推测、未验证。不能因为缺少直接生产权限就跳过现有快照。\n'
