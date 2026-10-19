"""Fixed local SnowLuma control; cached identities alone never imply online."""
import json,urllib.request
from pathlib import Path
BASE='http://127.0.0.1:5099/api';UIN='10002'
DIRECT=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def request(path,body=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['x-snowluma-token']=token
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    with DIRECT.open(req,timeout=25 if path.endswith('/load') else 5) as response:
        raw=response.read(1024*1024+1)
        if len(raw)>1024*1024:raise ValueError('panel_response_too_large')
        return json.loads(raw)
def login_observation(rows):
    matches=[row for row in rows if str(row.get('uin',''))==UIN and row.get('injected') is True and row.get('connected') is True and row.get('loggedIn') is True]
    candidates=[row for row in rows if str((row.get('account') or {}).get('uin',''))==UIN and not row.get('injected') and isinstance(row.get('pid'),int) and 0<row['pid']<=4194304]
    ready=len(matches)==1
    return {'reachable':True,'ready':ready,'quick':False,'phase':'ready' if ready else 'needs_hook' if candidates else 'login_required' if rows else 'client_missing','attach':bool(candidates)}
class Snowluma:
    def __init__(self):self.token=None
    def call(self,path,body=None):
        if self.token is None:
            cfg=json.loads(Path('/etc/qq-guardian/snowluma-webui.json').read_text())
            value=request('/login',{'password':cfg['password']})
            if value.get('success') is not True or value.get('mustChangePassword'):raise ValueError('panel_auth_not_ready')
            self.token=value['token']
        return request(path,body,self.token)
    def capture(self):return login_observation(self.call('/processes').get('list',[]))
    def attach(self):
        rows=self.call('/processes').get('list',[])
        if login_observation(rows)['ready']:return'already_ready'
        candidates=[r for r in rows if str((r.get('account') or {}).get('uin',''))==UIN and not r.get('injected') and isinstance(r.get('pid'),int) and 0<r['pid']<=4194304]
        if len(candidates)!=1:return'device_confirmation_required'
        result=self.call('/processes/'+str(candidates[0]['pid'])+'/load',{})
        return'accepted' if result.get('success') is True else'action_failed'
