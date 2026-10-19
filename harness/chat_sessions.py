"""Private Chat conversation pointers, scoped by QQ chat, sender and account.

The broker alone persists pointers. Tasks receive just their scoped pointer in
their existing workspace, without access to the session directory or other users.
"""
import hashlib,json,os,re,time
from pathlib import Path
UUID=re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
KEY=re.compile(r'[a-f0-9]{32}')

def account_fingerprint(auth_file):
 auth=json.loads(Path(auth_file).read_text());account=(auth.get('tokens') or {}).get('account_id')
 if not isinstance(account,str) or not account:raise ValueError('Chat会话复用需要有效的账号标识')
 return hashlib.sha256(('qq-chat-account-v1:'+account).encode()).hexdigest()[:32]

def read_pointer(path):
 path=Path(path)
 if path.is_symlink() or path.stat().st_size>16384:raise ValueError('Chat会话记录无效')
 value=json.loads(path.read_text())
 if not isinstance(value,dict):raise ValueError('Chat会话记录无效')
 return value

def atomic_pointer(path,value):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(value));temporary.chmod(0o600);os.replace(temporary,path)

class ChatSessions:
 def __init__(self,root,auth_file):self.root=Path(root);self.auth_file=Path(auth_file)
 def pointer_path(self,key):
  if not isinstance(key,str) or not KEY.fullmatch(key):raise ValueError('Chat生图会话标识无效')
  fingerprint=account_fingerprint(self.auth_file)
  return self.root/fingerprint/(key+'.json'),fingerprint
 def checkout(self,job,key):
  pointer={}
  if key:
   path,fingerprint=self.pointer_path(key)
   if path.exists():
    pointer=read_pointer(path)
    if pointer.get('account_fingerprint')!=fingerprint or not UUID.fullmatch(str(pointer.get('conversation_id',''))):raise ValueError('Chat会话记录与当前账号不符')
  atomic_pointer(Path(job)/'chat-session.json',pointer)
 def commit(self,job,key):
  if not key:return False
  path,fingerprint=self.pointer_path(key);receipt_path=Path(job)/'chat-image-receipt.json'
  if not receipt_path.exists():return False
  receipt=read_pointer(receipt_path);cid=receipt.get('conversation_id');mid=receipt.get('message_id')
  if receipt.get('account_fingerprint')!=fingerprint:raise ValueError('Chat任务回执与当前账号不符')
  if receipt.get('generation_submissions')!=1 or not UUID.fullmatch(str(cid or '')) or not UUID.fullmatch(str(mid or '')):return False
  atomic_pointer(path,{'version':1,'account_fingerprint':fingerprint,'conversation_id':cid,'last_message_id':mid,'updated':int(time.time())})
  return True
