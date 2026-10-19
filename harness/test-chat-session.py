import io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import chat_image,chat_sessions,harness,codex_engine

CID='11111111-2222-3333-4444-555555555555';PARENT='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';OLDMID='bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
PNG=__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=')
def msg(role='assistant',parts=None,**extra):return {'author':{'role':role},'content':{'content_type':'multimodal_text','parts':parts or []},'status':'finished_successfully','end_turn':True,**extra}
def asset(ref):return {'content_type':'image_asset_pointer','asset_pointer':'file-service://'+ref}
def old_conversation(failed=False):
 return {'current_node':PARENT,'mapping':{PARENT:{'parent':OLDMID,'message':msg(id=PARENT,parts=['content policies' if failed else asset('old')],metadata={'is_error':failed})},OLDMID:{'parent':None,'message':msg('user',id=OLDMID)}}}

class ChatSessionTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.auth=self.root/'auth.json';self.auth.write_text(json.dumps({'tokens':{'access_token':'private-test-token','account_id':'test-account'}}))
  self.fingerprint=chat_sessions.account_fingerprint(self.auth)
 def pointer(self):
  p=self.root/'session.json';p.write_text(json.dumps({'conversation_id':CID,'account_fingerprint':self.fingerprint}));return p

 def test_active_turn_excludes_old_images_and_old_refusals(self):
  data=old_conversation(failed=True);mid='new-user';data['mapping'].update({mid:{'parent':PARENT,'message':msg('user',id=mid)},'new-image':{'parent':mid,'message':msg(parts=[asset('new')])}});data['current_node']='new-image'
  self.assertIsNone(chat_image.message_error(data,mid));self.assertEqual(chat_image.asset_refs(chat_image.turn_view(data,mid)),['file-service://new'])
  self.assertFalse(chat_image.asset_refs(chat_image.turn_view(data,'not-yet-visible')))

 def test_reuses_conversation_and_parent_with_exact_prompt_and_only_new_asset(self):self.check_reuse(False)
 def test_completed_image_tool_tail_without_assistant_text_can_continue(self):self.check_reuse(True)
 def check_reuse(self,image_tail):
  client=chat_image.ChatImageClient(self.auth,self.root/'receipt.json');calls=[];mid=None
  raw='画一颗蓝色星星\n保持原话  不加风格。'
  def request(route,payload=None,extra=None,stream=False):
   nonlocal mid
   calls.append((route,payload))
   if route=='/backend-api/conversation/'+CID:
    if mid is None:
     previous=old_conversation()
     if image_tail:previous['mapping'][PARENT]['message']=msg('tool',id=PARENT,parts=[asset('old')],end_turn=None,recipient='all')
     return previous
    data=old_conversation();data['mapping'][mid]={'parent':PARENT,'message':msg('user',id=mid)};data['mapping']['new']={'parent':mid,'message':msg(parts=[asset('new')])};data['current_node']='new';return data
   if 'chat-requirements' in route:return {'token':'test'}
   if route.endswith('/prepare'):
    self.assertEqual(payload['conversation_id'],CID);self.assertEqual(payload['parent_message_id'],PARENT);self.assertEqual(payload['partial_query']['content']['parts'],[raw]);return {'conduit_token':'test'}
   if route.endswith('/f/conversation'):
    self.assertEqual(payload['conversation_id'],CID);self.assertEqual(payload['parent_message_id'],PARENT);self.assertEqual(payload['messages'][0]['content']['parts'],[raw]);mid=payload['messages'][0]['id']
    return io.BytesIO(('data: '+json.dumps({'conversation_id':CID,'message':msg(id=PARENT,parts=[asset('old')])})+'\n\ndata: [DONE]\n').encode())
   if '/files/download/new?' in route:return {'download_url':'https://chatgpt.com/backend-api/estuary/content?test'}
   self.fail(route)
  download=MagicMock();download.open.return_value=io.BytesIO(PNG)
  with patch.object(client,'request',side_effect=request),patch.object(client,'quota',return_value=({},'auto')),patch.object(chat_image,'proof',return_value='test'),patch.object(chat_image.urllib.request,'build_opener',return_value=download):
   state=client.generate(raw,self.root/'images',self.pointer())
  self.assertTrue(state['session_reused']);self.assertEqual(state['conversation_id'],CID);self.assertEqual(state['generation_submissions'],1)
  self.assertEqual((self.root/'images/chat-image.png').read_bytes(),PNG);self.assertEqual(sum(r=='/backend-api/f/conversation' for r,p in calls),1)
  self.assertNotIn('private-test-token',(self.root/'receipt.json').read_text())

 def test_pending_previous_turn_stops_before_new_generation(self):
  client=chat_image.ChatImageClient(self.auth,self.root/'receipt.json');previous=old_conversation();previous['mapping'][PARENT]['message']['end_turn']=False
  with patch.object(client,'request',return_value=previous) as request:
   with self.assertRaises(chat_image.ChatError) as error:client.generate('new',self.root/'images',self.pointer())
  self.assertEqual(error.exception.code,'conversation_pending');self.assertEqual(request.call_count,1);self.assertEqual(client.state['generation_submissions'],0)

 def test_incomplete_async_or_failed_tool_results_remain_blocked(self):
  complete=old_conversation();complete['mapping'][PARENT]['message']=msg('tool',id=PARENT,parts=[asset('old')],end_turn=None,recipient='all')
  self.assertTrue(chat_image.continuation_ready(complete))
  for field,value in [('async_status','running'),('status','in_progress'),('role','user'),('is_error',True),('parts',[])]:
   data=json.loads(json.dumps(complete));tail=data['mapping'][PARENT]['message']
   if field=='async_status':data[field]=value
   elif field=='role':tail['author']['role']=value
   elif field=='is_error':tail['metadata']={field:value}
   elif field=='parts':tail['content']['parts']=value
   else:tail[field]=value
   self.assertFalse(chat_image.continuation_ready(data),field)

 def test_wrong_account_pointer_is_rejected_without_network(self):
  pointer=self.pointer();self.auth.write_text(json.dumps({'tokens':{'access_token':'new-token','account_id':'other-account'}}));client=chat_image.ChatImageClient(self.auth,self.root/'receipt.json')
  with patch.object(client,'request') as request:
   with self.assertRaises(chat_image.ChatError):client.generate('new',self.root/'images',pointer)
  request.assert_not_called()

 def test_scoped_pointer_survives_restart_and_isolates_scope_and_account(self):
  job=self.root/'job';job.mkdir();key='a'*32;store=chat_sessions.ChatSessions(self.root/'sessions',self.auth)
  store.checkout(job,key);self.assertEqual(chat_sessions.read_pointer(job/'chat-session.json'),{})
  receipt={'conversation_id':CID,'message_id':OLDMID,'account_fingerprint':self.fingerprint,'generation_submissions':1,'phase':'failed'}
  (job/'chat-image-receipt.json').write_text(json.dumps(receipt));self.assertTrue(store.commit(job,key))
  restarted=chat_sessions.ChatSessions(self.root/'sessions',self.auth);restarted.checkout(job,key);self.assertEqual(chat_sessions.read_pointer(job/'chat-session.json')['conversation_id'],CID)
  restarted.checkout(job,'b'*32);self.assertEqual(chat_sessions.read_pointer(job/'chat-session.json'),{})
  self.auth.write_text(json.dumps({'tokens':{'access_token':'new-token','account_id':'other-account'}}));restarted.checkout(job,key);self.assertEqual(chat_sessions.read_pointer(job/'chat-session.json'),{})
  with self.assertRaises(ValueError):restarted.commit(job,key)
  for p in (self.root/'sessions').rglob('*.json'):self.assertNotIn('private-test-token',p.read_text())

 def test_no_submission_or_missing_conversation_never_replaces_pointer(self):
  job=self.root/'job';job.mkdir();store=chat_sessions.ChatSessions(self.root/'sessions',self.auth)
  (job/'chat-image-receipt.json').write_text(json.dumps({'account_fingerprint':self.fingerprint,'generation_submissions':0,'conversation_id':CID,'message_id':OLDMID}))
  self.assertFalse(store.commit(job,'a'*32));self.assertFalse((self.root/'sessions').exists())

 def test_session_scope_is_checked_in_broker_idempotency(self):
  (self.root/'broker').mkdir()
  broker=harness.Broker(self.root/'broker',execute=False)
  with patch.object(codex_engine,'status',return_value={'authenticated':True}):
   first=broker.submit('exact text',engine='chatgpt',mode='image',request_id='a'*32,image_session_key='b'*32)
   self.assertEqual(broker.submit('exact text',engine='chatgpt',mode='image',request_id='a'*32,image_session_key='b'*32)['id'],first['id'])
   for key in ('c'*32,None):
    with self.assertRaises(ValueError):broker.submit('exact text',engine='chatgpt',mode='image',request_id='a'*32,image_session_key=key)
   with self.assertRaises(ValueError):broker.submit('text',engine='chatgpt',mode='image',image_session_key='../bad')

if __name__=='__main__':unittest.main()
