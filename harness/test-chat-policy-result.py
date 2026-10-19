import io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import chat_image,harness,codex_engine

REFUSAL='We’re so sorry, but the image we created may violate our content policies. If you think we got it wrong, please retry or edit your prompt.'
def message(text=REFUSAL,role='assistant',is_error=True):
 return {'author':{'role':role},'content':{'content_type':'text','parts':[text]},'metadata':{'is_error':is_error},'status':'finished_successfully','end_turn':True}

class ChatPolicyResult(unittest.TestCase):
 def test_real_terminal_refusal_maps_to_blocked(self):
  self.assertEqual(chat_image.message_error({'message':message()}).code,'blocked')
  self.assertEqual(chat_image.response_error({'error':{'code':'content_policy_violation'}}).code,'blocked')

 def test_user_text_ordinary_discussion_and_inactive_branch_are_not_errors(self):
  for item in (message(role='user'),message(is_error=False),{'author':{'role':'assistant'},'content':{'parts':[REFUSAL]},'metadata':{'is_error':True},'status':'in_progress','end_turn':False}):
   self.assertIsNone(chat_image.message_error({'message':item}))
  conversation={'current_node':'good','mapping':{'good':{'parent':'user','message':message('done',is_error=False)},'user':{'parent':None,'message':message(role='user')},'abandoned':{'parent':'user','message':message()}}}
  self.assertIsNone(chat_image.message_error(conversation))
  conversation['current_node']='abandoned'
  self.assertEqual(chat_image.message_error(conversation).code,'blocked')

 def test_nonpolicy_terminal_error_is_not_mislabeled_as_moderation(self):
  self.assertEqual(chat_image.message_error({'message':message('Image generation failed, please try again.')}).code,'unavailable')

 def check_flow(self,refusal_in_stream):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-only'}}));client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json');calls=[]
   cid='11111111-2222-3333-4444-555555555555';mid=None
   def request(route,payload=None,*args,**kwargs):
    nonlocal mid
    calls.append(route)
    if 'chat-requirements' in route:return {'token':'test'}
    if route.endswith('/prepare'):return {'conduit_token':'test'}
    if route.endswith('/f/conversation'):
     mid=payload['messages'][0]['id']
     event={'conversation_id':cid}
     if refusal_in_stream:event['message']=message()
     return io.BytesIO(('data: '+json.dumps(event)+'\n\ndata: [DONE]\n').encode())
    if route=='/backend-api/conversation/'+cid:return {'current_node':'error','mapping':{'error':{'message':message(),'parent':mid},mid:{'message':{'id':mid,'author':{'role':'user'}},'parent':None}}}
    self.fail('Unexpected generation, download or fallback request: '+route)
   with patch.object(client,'quota',return_value=({},'auto')),patch.object(client,'request',side_effect=request),patch.object(chat_image,'proof',return_value='test'),patch.object(chat_image.time,'sleep') as sleep:
    with self.assertRaises(chat_image.ChatError) as error:client.generate('test',root/'images')
   self.assertEqual(error.exception.code,'blocked');self.assertEqual(client.state['generation_submissions'],1);self.assertEqual(client.state['conversation_id'],cid)
   self.assertEqual(calls.count('/backend-api/f/conversation'),1);self.assertEqual(calls.count('/backend-api/conversation/'+cid),0 if refusal_in_stream else 1)
   sleep.assert_not_called();self.assertFalse((root/'images/chat-image.png').exists())

 def test_stream_refusal_stops_without_collection_wait_or_retry(self):self.check_flow(True)
 def test_conversation_refusal_stops_after_one_read_without_wait_or_retry(self):self.check_flow(False)

 def test_broker_preserves_blocked_code_from_worker(self):self.check_broker_code('blocked')
 def test_broker_preserves_pending_conversation_code_from_worker(self):self.check_broker_code('conversation_pending')
 def check_broker_code(self,code):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);broker=harness.Broker(root,execute=False)
   with patch.object(codex_engine,'status',return_value={'authenticated':True}):item=broker.submit('test image',mode='image',engine='chatgpt')
   job=root/'jobs'/item['id'];job.mkdir();(job/'request.txt').write_text('test image')
   events=[{'type':'turn.failed','error':{'message':'Chat任务未提交。','code':code}}]
   process=MagicMock();process.stdout=io.BytesIO(('\n'.join(json.dumps(e) for e in events)+'\n').encode());process.wait.return_value=1
   with patch.object(broker.queue,'get',side_effect=[item['id'],StopIteration]),patch.object(broker,'wait_capacity',return_value=True),patch.object(broker,'prepare'),patch.object(harness.subprocess,'Popen',return_value=process),patch.object(harness.threading,'Thread'),patch.object(harness,'classify_failure',return_value={'message':'refusal','code':'agent_error'}):
    with self.assertRaises(StopIteration):broker.worker()
   saved=broker.get(item['id']);self.assertEqual(saved['status'],'failed');self.assertEqual(saved['error_code'],code,saved.get('error'));self.assertFalse(saved['files'])

if __name__=='__main__':unittest.main()
