"""One image via the authenticated Chat service. No CLI, browser or generation retry.

Protocol references: lowkruc/chatgpt2api (MIT, Copyright 2026 kunkun).
Tokens are sent only to the exact official ChatGPT origin. No CAPTCHA UI or
third-party solver is automated. A denied request ends the task.
"""
import argparse,base64,hashlib,http.cookiejar,json,os,random,re,struct,time,urllib.request,urllib.error,urllib.parse,uuid
from pathlib import Path
from datetime import datetime,timezone
from chat_sessions import read_pointer,UUID
import image_inputs
MAX_BYTES=10*1024*1024
AGENT='QQ-Image-Bridge-Diagnostic/1.0'
class ChatError(ValueError):
 def __init__(self,message,code='unavailable'):super().__init__(message);self.code=code
def response_error(value):
 if not isinstance(value,dict):return None
 error=value.get('error');code=value.get('error_code') or value.get('code')
 if isinstance(error,dict):code=error.get('code') or error.get('type') or code;message=error.get('message','')
 elif error:message=str(error)
 else:message=str(value.get('detail',''))
 if not error and not code and not message:return None
 text=(str(code or '')+' '+message).lower()
 if any(s in text for s in ('captcha','verification_required','challenge_required','turnstile','arkose','sentinel')):return ChatError('Chat服务端实际要求验证，本次停止，不重试或切换Codex。','verification_required')
 if any(s in text for s in ('quota','rate_limit','usage_limit','额度','限流')):return ChatError('Chat服务端额度不足或正在限流，本次停止。','quota')
 if any(s in text for s in ('token_expired','invalid_token','unauthorized','authentication')):return ChatError('Chat服务端未接受当前授权，请检查登录凭证。','auth')
 if any(s in text for s in ('content_policy','policy_violation','content_filter','moderation_blocked','safety_violation')):return ChatError('Chat内容安全检查拦截了本次生图，没有返回可发送的图片。','blocked')
 if error or code:return ChatError('Chat服务端没有接受本次请求，本次停止。')
 return None

def turn_view(value,message_id):
 """Select only this user turn on the active branch, excluding earlier images/errors."""
 if not isinstance(value,dict) or not isinstance(value.get('mapping'),dict):return value
 mapping=value['mapping'];node=value.get('current_node');selected={};found=False
 while isinstance(node,str) and node not in selected and len(selected)<256:
  item=mapping.get(node)
  if not isinstance(item,dict):break
  selected[node]=item
  if node==message_id or (item.get('message') or {}).get('id')==message_id:found=True;break
  node=item.get('parent')
 return {'current_node':value.get('current_node') if found else None,'mapping':selected if found else {}}

def message_error(value,message_id=None):
 """Classify only actual assistant error messages on the active Chat branch.

 User text, ordinary policy discussions and abandoned branches are not errors.
 A terminal assistant error has no downloadable image, so stop collection early.
 """
 if not isinstance(value,dict):return None
 if message_id:value=turn_view(value,message_id)
 messages=[value.get('message')]
 mapping=value.get('mapping')
 if isinstance(mapping,dict):
  node=value.get('current_node');seen=set();messages=[]
  while isinstance(node,str) and node not in seen and len(seen)<256:
   seen.add(node);item=mapping.get(node)
   if not isinstance(item,dict):break
   messages.append(item.get('message'));node=item.get('parent')
 for message in messages:
  if not isinstance(message,dict) or (message.get('author') or {}).get('role')!='assistant':continue
  if (message.get('metadata') or {}).get('is_error') is not True:continue
  if message.get('end_turn') is not True and message.get('status') not in ('finished_successfully','finished_error','failed'):continue
  content=message.get('content') or {}
  text=' '.join(p for p in (content.get('parts') or []) if isinstance(p,str))+' '+str(content.get('text') or '')
  if re.search(r'violate.{0,100}(?:content|safety)\s+polic|content\s+polic(?:y|ies)|policy\s+violation|违反.{0,30}(?:政策|安全规则)|内容安全',text,re.I):
   return ChatError('Chat内容安全检查拦截了本次生图，没有返回可发送的图片；不会自动重试。','blocked')
  return ChatError('Chat返回了生成错误，没有返回可发送的图片；不会自动重试。')
 return None
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ChatError('图片下载发生重定向，本次停止，不重新生成。')
def decode_png(data):
 if not 57<=len(data)<=MAX_BYTES or data[:8]!=b'\x89PNG\r\n\x1a\n' or data[8:12]!=b'\0\0\0\r' or data[12:16]!=b'IHDR' or data[-8:-4]!=b'IEND':raise ChatError('Chat没有返回完整PNG图片，本次未发图。','no_image')
 width,height=struct.unpack('>II',data[16:24])
 if not 1<=width<=16384 or not 1<=height<=16384:raise ChatError('图片尺寸无效。')
 return width,height
def asset_refs(value):
 found=[]
 def walk(v):
  if isinstance(v,dict):
   if v.get('content_type')=='image_asset_pointer' and isinstance(v.get('asset_pointer'),str) and v['asset_pointer'].startswith(('file-service://','sediment://')):found.append(v['asset_pointer'])
   for item in v.values():walk(item)
  elif isinstance(v,list):
   for item in v:walk(item)
 walk(value);return list(dict.fromkeys(found))

def select_output_asset(conversation,message_id,excluded=()):
 """Select one output on this turn; recognize Chat's indexed comparison variants."""
 view=turn_view(conversation,message_id);refs=[r for r in asset_refs(view) if r not in excluded]
 if len(refs)==1:return refs[0],1
 variants=[]
 for item in (view.get('mapping') or {}).values():
  message=item.get('message') or {};meta=message.get('metadata') or {}
  content_refs=[r for r in asset_refs(message.get('content')) if r not in excluded]
  if not content_refs:continue
  if (message.get('author') or {}).get('role') not in ('tool','assistant') or message.get('status')!='finished_successfully' or message.get('recipient')!='all' or meta.get('is_error') is True:break
  group=meta.get('image_gen_group_id');index=meta.get('generation_index')
  if len(content_refs)!=1 or not isinstance(group,str) or not UUID.fullmatch(group) or type(index) is not int or not 0<=index<4 or not isinstance(meta.get('image_gen_paragen_metadata'),dict):break
  variants.append((index,group,content_refs[0]))
 else:
  if 2<=len(variants)<=4 and len({v[1] for v in variants})==1 and len({v[0] for v in variants})==len(variants) and {v[2] for v in variants}==set(refs) and any(v[0]==0 for v in variants):
   return min(variants)[2],len(variants)
 raise ChatError('Chat本轮返回的多张图片无法确认属于同一组候选，本次不发图。','no_image')

def continuation_ready(conversation):
 """Chat can finish with an image tool result and no final assistant text."""
 if not isinstance(conversation,dict) or conversation.get('async_status') not in (None,'completed','finished','succeeded'):return False
 parent=conversation.get('current_node');mapping=conversation.get('mapping') or {};tail=(mapping.get(parent) or {}).get('message') or {}
 if not UUID.fullmatch(str(parent)):return False
 role=(tail.get('author') or {}).get('role');status=tail.get('status')
 if role=='assistant' and tail.get('end_turn') is True and status in ('finished_successfully','finished_error','failed'):return True
 return role in ('tool','assistant') and status=='finished_successfully' and tail.get('end_turn') is not False and tail.get('recipient')=='all' and (tail.get('metadata') or {}).get('is_error') is not True and len(asset_refs(tail))==1

def reference_branch_parent(conversation):
 """Keep the Chat conversation, excluding old image turns from reference edits."""
 mapping=conversation.get('mapping') or {};node=conversation.get('current_node');seen=set()
 while isinstance(node,str) and node not in seen and len(seen)<256:
  seen.add(node);item=mapping.get(node)
  if not isinstance(item,dict):break
  if item.get('parent') is None:
   message=item.get('message') or {};role=(message.get('author') or {}).get('role')
   if UUID.fullmatch(node) and role in (None,'system','developer') and not asset_refs(message):return node
   break
  node=item.get('parent')
 raise ChatError('无法确认当前Chat对话的干净参考图分支，本次不提交生成。')
def download_headers(url,auth_headers):
 p=urllib.parse.urlsplit(url);host=p.hostname or ''
 if p.scheme!='https' or p.username or p.password or p.port not in (None,443) or not any(host==d.lstrip('.') or host.endswith(d) for d in ('.chatgpt.com','.openai.com','.oaiusercontent.com','.blob.core.windows.net')):raise ChatError('图片下载地址不在可信范围内。')
 return dict(auth_headers) if host=='chatgpt.com' else {'User-Agent':AGENT}
def proof(seed,difficulty,device,prefix):
 if not isinstance(difficulty,str) or not re.fullmatch(r'[a-fA-F0-9]{2,32}',difficulty) or len(difficulty)%2:raise ChatError('客户端校验格式不受支持。')
 target=bytes.fromhex(difficulty)
 config=[3000,datetime.now(timezone.utc).strftime('%a %b %d %Y %H:%M:%S GMT+0000'),4294705152,0,AGENT,'https://chatgpt.com/backend-api/sentinel/sdk.js','','en-US','en-US',0,'webdriver\u2212true','location','window',time.monotonic()*1000,device,'',os.cpu_count() or 2,time.time()*1000-time.monotonic()*1000]
 started=time.monotonic()
 for i in range(100000):
  if time.monotonic()-started>3:break
  config[3]=i;config[9]=i>>1;encoded=base64.b64encode(json.dumps(config,separators=(',',':'),ensure_ascii=False).encode())
  if hashlib.sha3_512(seed.encode()+encoded).digest()[:len(target)]<=target:return prefix+encoded.decode()
 raise ChatError('客户端计算校验超过预算，本次停止。')
class ChatImageClient:
 def __init__(self,auth_file,receipt_file,opener=None,deadline_seconds=220,progress=None):
  auth=json.loads(Path(auth_file).read_text());token=auth.get('tokens',{}).get('access_token')
  if not token or not isinstance(token,str) or re.search(r'[\r\n]',token):raise ChatError('Chat授权不存在或格式无效。','auth')
  account=auth.get('tokens',{}).get('account_id','qq-image-bridge')
  device_file=Path(auth_file).parent/'chat-device-id'
  self.device=device_file.read_text().strip() if device_file.exists() else str(uuid.uuid5(uuid.NAMESPACE_URL,account+'/qq-image-bridge'))
  self.headers={'Authorization':'Bearer '+token,'User-Agent':AGENT,'Accept':'application/json','Content-Type':'application/json','Origin':'https://chatgpt.com','Referer':'https://chatgpt.com/','OAI-Device-Id':self.device,'OAI-Language':'en-US'}
  self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),NoRedirect())
  self.deadline=time.monotonic()+deadline_seconds;self.receipt=Path(receipt_file);self.progress=progress or (lambda phase:None)
  self.account_fingerprint=hashlib.sha256(('qq-chat-account-v1:'+account).encode()).hexdigest()[:32]
  self.state={'channel':'chatgpt_chat','transport':'authenticated_chat_backend','codex_executions':0,'generation_submissions':0,'account_fingerprint':self.account_fingerprint,'session_reused':False};self.claimed_receipt=False
 def save(self,phase):
  self.state['phase']=phase;self.receipt.write_text(json.dumps(self.state,ensure_ascii=False));self.receipt.chmod(0o600);self.progress(phase)
 def request(self,route,payload=None,extra=None,stream=False):
  if time.monotonic()>self.deadline:raise ChatError('Chat生图等待超时，不会重新生成。','timeout')
  if not route.startswith('/backend-api/') or '\\' in route or re.search(r'[\r\n]',route):raise ChatError('Chat接口路径无效。')
  headers={**self.headers,'X-OpenAI-Target-Path':route.split('?')[0],'X-OpenAI-Target-Route':route.split('?')[0],**(extra or {})}
  request=urllib.request.Request('https://chatgpt.com'+route,headers=headers,data=None if payload is None else json.dumps(payload).encode())
  try:response=self.opener.open(request,timeout=min(65,max(1,self.deadline-time.monotonic())))
  except urllib.error.HTTPError as error:
   code=error.code
   try:body=json.loads(error.read(16384))
   except Exception:body={}
   finally:error.close()
   classified=response_error(body)
   if classified:raise classified from None
   raise ChatError('Chat生图额度不足或限流（HTTP 429）。' if code==429 else 'Chat服务端拒绝请求（HTTP '+str(code)+'），本次停止。','quota' if code==429 else 'auth' if code==401 else 'unavailable') from None
  if stream:return response
  with response:data=response.read(2*1024*1024+1)
  if len(data)>2*1024*1024:raise ChatError('Chat接口响应过大。')
  if not data:return {}
  parsed=json.loads(data);error=response_error(parsed)
  if error:raise error
  return parsed
 def upload_image(self,image,index):
  meta=image_inputs.inspect_image(image['buffer'],image['mime']);name='reference-'+str(index+1)+meta['ext']
  reserved=self.request('/backend-api/files',{'file_name':name,'file_size':meta['bytes'],'use_case':'multimodal','width':meta['width'],'height':meta['height']})
  fid=reserved.get('file_id');url=reserved.get('upload_url','')
  if not isinstance(fid,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,180}',fid):raise ChatError('Chat没有返回有效的参考图片上传凭据，本次停止。','reference_image')
  headers={**download_headers(url,self.headers),'Content-Type':meta['mime'],'x-ms-blob-type':'BlockBlob','x-ms-version':'2020-04-08'}
  uploader=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'}),NoRedirect())
  try:
   with uploader.open(urllib.request.Request(url,data=image['buffer'],headers=headers,method='PUT'),timeout=min(40,max(1,self.deadline-time.monotonic()))) as response:response.read(16384)
  except urllib.error.HTTPError as error:
   try:body=json.loads(error.read(16384))
   except Exception:body={}
   finally:error.close()
   classified=response_error(body)
   if classified:raise classified from None
   raise ChatError('Chat参考图片上传被拒绝，本次停止，不提交生图。','reference_image') from None
  self.request('/backend-api/files/'+fid+'/uploaded',{})
  return {'file_id':fid,'file_name':name,'file_size':meta['bytes'],'mime_type':meta['mime'],'width':meta['width'],'height':meta['height']}
 def quota(self,conversation_id=None):
  data=self.request('/backend-api/conversation/init',{'gizmo_id':None,'requested_default_model':None,'conversation_id':conversation_id,'timezone_offset_min':-480})
  rows=data.get('limits_progress') or []
  quota=next(({k:r.get(k) for k in ('remaining','reset_after')} for r in rows if isinstance(r,dict) and r.get('feature_name')=='image_gen'),{})
  return quota,data.get('default_model_slug') or 'auto'
 def generate(self,prompt,image_dir,session_file=None,input_images=None):
  if not isinstance(prompt,str) or not 1<=len(prompt.strip())<=2200:raise ChatError('生图描述无效。')
  if self.receipt.exists():raise ChatError('这项生图任务已有执行记录，不会重复提交。')
  with self.receipt.open('x') as receipt:receipt.write('{}')
  self.claimed_receipt=True
  self.receipt.chmod(0o600)
  directory=Path(image_dir);directory.mkdir(parents=True,exist_ok=True)
  self.state['prompt_sha256']=hashlib.sha256(prompt.encode()).hexdigest()
  inputs=input_images or []
  if not isinstance(inputs,list) or len(inputs)>image_inputs.MAX_IMAGES or sum(len(image.get('buffer',b'')) for image in inputs)>image_inputs.MAX_TOTAL_BYTES:raise ChatError('参考图片数量或大小无效。','reference_image')
  self.state.update(input_image_count=len(inputs),input_sha256=[hashlib.sha256(image['buffer']).hexdigest() for image in inputs])
  cid='';parent=str(uuid.uuid4());before_refs=set();before_message_ids=set()
  if session_file:
   session=read_pointer(session_file)
   if session:
    cid=session.get('conversation_id','')
    if not UUID.fullmatch(str(cid)) or session.get('account_fingerprint')!=self.account_fingerprint:raise ChatError('Chat生图对话记录与当前账号不符，本次未生成。','auth')
    previous=self.request('/backend-api/conversation/'+cid)
    parent=previous.get('current_node');mapping=previous.get('mapping') or {};tail=(mapping.get(parent) or {}).get('message') or {}
    if not continuation_ready(previous):
     raise ChatError('这个Chat生图对话的上一轮仍未结束，请等它结束后再发新要求；本次没有提交生图。','conversation_pending')
    before_refs=set(asset_refs(previous));before_message_ids={m['message']['id'] for m in mapping.values() if isinstance(m,dict) and isinstance(m.get('message'),dict) and isinstance(m['message'].get('id'),str)}
    if inputs:
     parent=reference_branch_parent(previous)
     self.state.update(reference_context='isolated_branch',reference_parent_message_id=parent)
    self.state.update(conversation_id=cid,session_reused=True)
  self.save('checking_quota');self.state['quota_before'],model=self.quota(cid or None);self.state['chat_model']=model
  p=proof(str(random.random()),'0fffff',self.device,'gAAAAAC')
  requirements=self.request('/backend-api/sentinel/chat-requirements',{'p':p})
  self.state['requirements']={name:bool((requirements.get(name) or {}).get('required')) for name in ('arkose','turnstile','proofofwork')}
  turnstile=requirements.get('turnstile') or {}
  # Interactive challenges are never automated. A dx client-validation
  # announcement alone is not evidence that a human CAPTCHA was presented.
  # The normal prepare endpoint must issue its own conduit permit below;
  # every subsequent backend refusal or verification error remains terminal.
  interactive=self.state['requirements']['arkose'] or (self.state['requirements']['turnstile'] and (not isinstance(turnstile.get('dx'),str) or not turnstile['dx'] or any(turnstile.get(k) for k in ('site_key','sitekey','captcha_url','challenge_url'))))
  if interactive:raise ChatError('Chat服务端要求交互验证，本次未提交生图，请管理员处理。','verification_required')
  extra={'OpenAI-Sentinel-Chat-Requirements-Token':requirements['token']}
  challenge=requirements.get('proofofwork') or {}
  if challenge.get('required'):extra['OpenAI-Sentinel-Proof-Token']=proof(challenge['seed'],challenge['difficulty'],self.device,'gAAAAAB')
  uploaded=[]
  if inputs:
   self.save('uploading')
   for index,image in enumerate(inputs):uploaded.append(self.upload_image(image,index))
   before_refs.update(prefix+image['file_id'] for image in uploaded for prefix in ('file-service://','sediment://'))
  mid=str(uuid.uuid4())
  common={'action':'next','parent_message_id':parent,'model':model,'timezone_offset_min':-480,'timezone':'Asia/Shanghai','conversation_mode':{'kind':'primary_assistant'},'system_hints':['picture_v2'],'supports_buffering':True,'supported_encodings':[],'client_contextual_info':{'app_name':'chatgpt.com'}}
  if cid:common['conversation_id']=cid
  parts=[{'content_type':'image_asset_pointer','asset_pointer':'file-service://'+image['file_id'],'width':image['width'],'height':image['height'],'size_bytes':image['file_size']} for image in uploaded]+[prompt]
  content={'content_type':'multimodal_text' if uploaded else 'text','parts':parts}
  metadata={'system_hints':['picture_v2'],'serialization_metadata':{'custom_symbol_offsets':[]}}
  if uploaded:metadata['attachments']=[{'id':image['file_id'],'mimeType':image['mime_type'],'name':image['file_name'],'size':image['file_size'],'width':image['width'],'height':image['height']} for image in uploaded]
  prepare={**common,'fork_from_shared_post':False,'client_prepare_state':'success','partial_query':{'id':mid,'author':{'role':'user'},'content':content,'metadata':metadata}}
  self.save('preparing');prepared=self.request('/backend-api/f/conversation/prepare',prepare,extra);conduit=prepared.get('conduit_token')
  error=response_error(prepared)
  if error:raise error
  if str(prepared.get('status','')).lower() in ('error','failed','blocked','challenge_required'):raise ChatError('Chat没有批准请求，本次停止。','verification_required')
  if not conduit:raise ChatError('Chat没有确认生图请求，本次停止。')
  self.state['prepare_permit_received']=True
  payload={**common,'client_prepare_state':'sent','messages':[{'id':mid,'author':{'role':'user'},'create_time':time.time(),'content':content,'metadata':metadata}],'enable_message_followups':True}
  self.state['generation_submissions']=1;self.state['message_id']=mid;self.save('generating')
  response=self.request('/backend-api/f/conversation',payload,{**extra,'X-Conduit-Token':conduit,'Accept':'text/event-stream','X-Oai-Turn-Trace-Id':str(uuid.uuid4())},stream=True)
  pointers=[];size=0
  with response:
   for line in response:
    size+=len(line)
    if size>10*1024*1024 or time.monotonic()>self.deadline:raise ChatError('Chat返回超过输出或等待限制。')
    if not line.startswith(b'data:'):continue
    data=line[5:].strip()
    if data==b'[DONE]':break
    try:event=json.loads(data)
    except ValueError:continue
    if not isinstance(event,dict):continue
    error=response_error(event)
    if error:raise error
    candidate=event.get('conversation_id')
    if isinstance(candidate,str) and UUID.fullmatch(candidate):
     if cid and candidate!=cid:raise ChatError('Chat返回了不匹配的生图对话，本次停止。')
     if 'conversation_id' not in self.state:self.state['conversation_id']=candidate;self.save('generating')
     cid=candidate
    if (event.get('message') or {}).get('id') in before_message_ids:continue
    event=turn_view(event,mid)
    error=message_error(event,mid)
    if error:raise error
    pointers=list(dict.fromkeys(pointers+[ref for ref in asset_refs(event) if ref not in before_refs]))
  self.save('collecting')
  while not pointers and cid and time.monotonic()<self.deadline:
   conversation=self.request('/backend-api/conversation/'+cid)
   error=message_error(conversation,mid)
   if error:raise error
   pointers=[ref for ref in asset_refs(turn_view(conversation,mid)) if ref not in before_refs]
   if not pointers:time.sleep(3)
  if not cid or not pointers:raise ChatError('Chat没有返回图片；不会自动重试。','no_image')
  if len(pointers)!=1:
   # SSE may contain both comparison candidates. Read the final active turn
   # and require the official group/index metadata before choosing index zero.
   conversation=self.request('/backend-api/conversation/'+cid)
   error=message_error(conversation,mid)
   if error:raise error
   selected,count=select_output_asset(conversation,mid,before_refs)
   pointers=[selected];self.state.update(output_variant_count=count,selected_variant_index=0)
  kind,value=pointers[0].split('://',1)
  if not re.fullmatch(r'[A-Za-z0-9_-]{1,180}',value):raise ChatError('图片引用格式无效。')
  route='/backend-api/conversation/'+cid+'/attachment/'+value+'/download' if kind=='sediment' else '/backend-api/files/download/'+value+'?conversation_id='+cid+'&inline=false'
  url=self.request(route).get('download_url','');headers=download_headers(url,self.headers);self.save('downloading')
  download=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'}),NoRedirect())
  with download.open(urllib.request.Request(url,headers=headers),timeout=min(35,max(1,self.deadline-time.monotonic()))) as response:data=response.read(MAX_BYTES+1)
  width,height=decode_png(data);target=directory/'chat-image.png'
  with target.open('xb') as stream:stream.write(data)
  target.chmod(0o600)
  self.state['image']={'bytes':len(data),'width':width,'height':height};self.save('finished')
  # An optional quota-query failure must not discard an already generated image.
  try:self.state['quota_after'],_=self.quota(cid);self.save('finished')
  except Exception:pass
  return self.state
def emit(value):print(json.dumps(value,ensure_ascii=False),flush=True)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--prompt-file',required=True);parser.add_argument('--image-dir',required=True);parser.add_argument('--session-file');parser.add_argument('--input-manifest');args=parser.parse_args()
 receipt=Path(args.prompt_file).with_name('chat-image-receipt.json')
 client=None
 try:
  client=ChatImageClient(Path(os.environ.get('CODEX_HOME','/workspace/codex'))/'auth.json',receipt,progress=lambda phase:emit({'type':'image.progress','phase':phase}))
  try:inputs=image_inputs.load_manifest(args.input_manifest)
  except (ValueError,OSError):raise ChatError('参考图片清单或文件校验失败，本次未提交生图。','reference_image') from None
  state=client.generate(Path(args.prompt_file).read_bytes().decode('utf-8'),args.image_dir,args.session_file,inputs)
  emit({'type':'image.metadata','metadata':{k:state.get(k) for k in ('channel','transport','codex_executions','prepare_permit_received','chat_model','requirements','quota_before','quota_after','generation_submissions','session_reused','prompt_sha256','input_image_count','input_sha256')}})
  emit({'type':'item.completed','item':{'type':'agent_message','text':'Chat模式已生成一张图片。'}})
  return 0
 except Exception as error:
  message=str(error)[:800] if isinstance(error,ChatError) else 'Chat生图连接或处理失败（'+type(error).__name__+'），本次不重试。'
  if client and client.claimed_receipt:
   client.state['error']=message;client.state['error_code']=getattr(error,'code','unavailable');client.save('failed')
   emit({'type':'image.metadata','metadata':{k:client.state.get(k) for k in ('channel','transport','codex_executions','prepare_permit_received','chat_model','requirements','quota_before','quota_after','generation_submissions','session_reused','prompt_sha256','input_image_count','input_sha256')}})
  emit({'type':'turn.failed','error':{'message':message,'code':getattr(error,'code','unavailable')}});return 1
if __name__=='__main__':raise SystemExit(main())
