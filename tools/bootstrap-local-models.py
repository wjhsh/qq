"""Local development endpoints only. Never use the cloud gateway or Pi for workers."""
import sys,pathlib,json,secrets,subprocess,os,urllib.request,time,shutil
import argparse
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--workspace',type=pathlib.Path,required=True);args=parser.parse_args()
ROOT=args.workspace.resolve();WORKERS=ROOT/'outputs/codex-api-workers'
sys.path.insert(0,str(WORKERS))
from codex_workers.vault import _crypt
from codex_workers.gateway import provision
from types import SimpleNamespace
STATE=ROOT/'work/social-phase2-private';STATE.mkdir(exist_ok=True)
runtime=json.loads((WORKERS/'.runtime.json').read_text())
meta=STATE/'local-endpoints.json'
settings=json.loads(meta.read_text()) if meta.exists() else {'gemini_key':secrets.token_urlsafe(32),'deepseek_key':secrets.token_urlsafe(32)}
def get(url,key=None):
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 req=urllib.request.Request(url,headers={'Authorization':'Bearer '+key} if key else {})
 with op.open(req,timeout=5) as r:return json.load(r)
def launch(args,cwd,env,log):
 with open(STATE/log,'ab') as out:
  p=subprocess.Popen(args,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=out,creationflags=subprocess.CREATE_NO_WINDOW)
 return p.pid
# Reuse saved account 1 locally; its tokens are never sent to a developer model.
accounts=STATE/'proxy/gemini/accounts';accounts.mkdir(parents=True,exist_ok=True)
original=WORKERS/'state/proxy/antigravity-1/accounts'
for p in original.glob('antigravity*.json'):
 target=accounts/p.name
 if not target.exists():shutil.copy2(p,target)
assert list(accounts.glob('antigravity*.json')),'Local Gemini authorization missing'
cfg=SimpleNamespace(state=STATE,data={'outbound_proxy_url':os.environ.get('HTTPS_PROXY','')},key=lambda _p:settings['gemini_key'])
path=provision(cfg,{'id':'gemini','managed_proxy':True,'proxy_port':18329})
try:models=get('http://127.0.0.1:18329/v1/models',settings['gemini_key'])
except OSError:
 settings['gemini_pid']=launch([runtime['cliproxy_executable'],'--config',str(path),'--local-model'],str(path.parent),dict(os.environ),'gemini-private.log')
 time.sleep(2);models=get('http://127.0.0.1:18329/v1/models',settings['gemini_key'])
settings['gemini_url']='http://127.0.0.1:18329/v1'
# Reuse the owner's DPAPI WorkBuddy authorization; run the pinned API-only profile locally.
wb=ROOT/'work/workbuddy-integration/runtime';sys.path.insert(0,str(wb))
import wb_accounts
cred=json.loads(_crypt((WORKERS/'state/credential-backups/workbuddy-cn.dpapi').read_bytes(),False))
ac=STATE/'workbuddy/accounts';ac.mkdir(parents=True,exist_ok=True)
uid=wb_accounts.jwt_uid(cred['accessToken']);assert uid,'Invalid saved WorkBuddy authorization'
target=ac/('cn-'+uid+'.json')
if not target.exists():
 account={'uid':uid,'nickname':'Local development','accessToken':cred['accessToken'],'refreshToken':cred.get('refreshToken',''),'expiresAt':cred.get('expiresAt') or wb_accounts.jwt_exp(cred['accessToken']),'domain':cred.get('domain') or 'www.workbuddy.cn','realm':'cn','platform':'CLI','product':'workbuddy','source':'owner-authorized-login','enabled':True}
 target.write_text(json.dumps(account));target.chmod(0o600)
(ac/'active_realm.json').write_text(json.dumps({'realm':'cn'}))
policy={'pricing_enabled':False,'update_check_enabled':False,'window_probe':False,'quota_scan_models':[],'daily_chat_web':False,'daily_chat_web_retry':False,'local_web_tools':False,'auto_switch_product':False,'free_model_credit_fallback':False,'enable_anthropic_messages':False,'upstream':{'header_timeout_seconds':60,'idle_timeout_seconds':180},'prompt':{'mode':'passthrough','file':''}}
(ac/'settings.json').write_text(json.dumps(policy))
try:health=get('http://127.0.0.1:18788/health')
except OSError:
 env=dict(os.environ,WB_PROXY_KEY=settings['deepseek_key'],PYTHONDONTWRITEBYTECODE='1',PYTHONUNBUFFERED='1')
 settings['deepseek_pid']=launch([runtime['python'],'-B',str(wb/'guarded_gateway.py'),'--host','127.0.0.1','--port','18788','--accounts-dir',str(ac),'--usage-dir',str(STATE/'workbuddy/usage')],str(STATE/'workbuddy'),env,'deepseek-private.log')
 time.sleep(3);health=get('http://127.0.0.1:18788/health')
settings['deepseek_url']='http://127.0.0.1:18788/v1'
meta.write_text(json.dumps(settings,indent=2));meta.chmod(0o600)
print(json.dumps({'gemini_local':True,'gemini_catalog':[x['id'] for x in models.get('data',[])],'deepseek_local':True,'deepseek_authenticated':health.get('authenticated'),'cloud_tunnel':False,'pi':False}))
