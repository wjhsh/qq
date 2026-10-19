import base64,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import chat_image
import harness,codex_engine
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=')

class VerificationTest(unittest.TestCase):
 def test_interactive_challenge_stops_before_prepare_or_generation(self):
  for challenge in ('turnstile','arkose'):
   with self.subTest(challenge=challenge),tempfile.TemporaryDirectory() as directory:
    root=Path(directory);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-token'}}))
    client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json')
    calls=[]
    def request(route,*args,**kwargs):
     calls.append(route)
     self.assertEqual(route,'/backend-api/sentinel/chat-requirements')
     return {challenge:{'required':True},'token':'test-requirement'}
    with patch.object(client,'quota',return_value=({},'auto')),patch.object(client,'request',side_effect=request),patch.object(chat_image,'proof',return_value='test-proof'):
     with self.assertRaisesRegex(chat_image.ChatError,'交互验证'):client.generate('cat',root/'images')
    self.assertEqual(calls,['/backend-api/sentinel/chat-requirements'])
    self.assertEqual(client.state['generation_submissions'],0)

 def test_auth_is_sent_only_to_exact_origin_and_redirects_are_refused(self):
  auth={'Authorization':'Bearer test-only'}
  self.assertEqual(chat_image.download_headers('https://chatgpt.com/backend-api/estuary/content',auth),auth)
  for url in ('https://files.oaiusercontent.com/image','https://test.blob.core.windows.net/a','https://sub.chatgpt.com/a'):
   self.assertNotIn('Authorization',chat_image.download_headers(url,auth))
  for url in ('http://chatgpt.com/a','https://chatgpt.com.evil.test/a','https://chatgpt.com@evil.test/a','https://chatgpt.com:8443/a','https://127.0.0.1/a'):
   with self.assertRaises(chat_image.ChatError):chat_image.download_headers(url,auth)
  with self.assertRaises(chat_image.ChatError):chat_image.NoRedirect().redirect_request(None,None,None,None,None,None)

 def test_duplicate_receipt_blocks_network_calls(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-token'}}));(root/'receipt.json').write_text('{}')
   client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json')
   with patch.object(client,'request') as request:
    with self.assertRaisesRegex(chat_image.ChatError,'不会重复'):client.generate('cat',root/'images')
   request.assert_not_called()

 def test_png_is_validated_before_export(self):
  self.assertEqual(chat_image.decode_png(PNG),(1,1))
  for data in (b'not-image',PNG[:-12],PNG[:8]+b'xxxx'+PNG[12:]):
   with self.assertRaises(chat_image.ChatError):chat_image.decode_png(data)

 def test_one_submission_downloads_one_image_without_cli(self):
  from unittest.mock import MagicMock
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-token'}}));client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json')
   calls=[];cid='a'*8+'-'+ 'b'*4+'-'+ 'c'*4+'-'+ 'd'*4+'-'+ 'e'*12
   def request(route,payload=None,extra=None,stream=False):
    calls.append(route)
    if 'chat-requirements' in route:return {'token':'test','turnstile':{'required':False}}
    if route.endswith('/prepare'):return {'conduit_token':'test'}
    if route.endswith('/f/conversation'):return io.BytesIO(('data: '+json.dumps({'conversation_id':cid,'content':{'content_type':'image_asset_pointer','asset_pointer':'file-service://file_test'}})+'\n\ndata: [DONE]\n').encode())
    if '/files/download/' in route:return {'download_url':'https://chatgpt.com/backend-api/estuary/content?test=signed'}
    self.fail(route)
   download=MagicMock();download.open.return_value=io.BytesIO(PNG)
   with patch.object(client,'quota',return_value=({'remaining':1000},'auto')),patch.object(client,'request',side_effect=request),patch.object(chat_image,'proof',return_value='test-proof'),patch.object(chat_image.urllib.request,'build_opener',return_value=download):
    result=client.generate('cat',root/'images')
   self.assertEqual(calls.count('/backend-api/f/conversation'),1);self.assertEqual(result['generation_submissions'],1)
   self.assertEqual((root/'images/chat-image.png').read_bytes(),PNG)
   self.assertNotIn('test-token',(root/'receipt.json').read_text())
   self.assertEqual(download.open.call_args.args[0].get_header('Authorization'),'Bearer test-token')

 def test_broker_chat_engine_is_image_only_with_readonly_auth_and_no_google_key(self):
  args='\n'.join(harness.job_command('a'*12,'chatgpt','image'))
  for value in ('BindReadOnlyPaths=','CODEX_HOME=/workspace/codex','MemoryMax=512M','RuntimeMaxSec=240','chat_image.py'):self.assertIn(value,args)
  self.assertNotIn('EnvironmentFile=',args);self.assertNotIn(codex_engine.CLI,args)
  with self.assertRaises(ValueError):harness.job_command('a'*12,'chatgpt','task')
  with tempfile.TemporaryDirectory() as directory:
   broker=harness.Broker(Path(directory),execute=False)
   with patch.object(codex_engine,'status',return_value={'authenticated':True}):
    with self.assertRaises(ValueError):broker.submit('task',engine='chatgpt')
    self.assertEqual(broker.submit('cat',engine='chatgpt',mode='image')['model'],'chatgpt-chat-image')

if __name__=='__main__':unittest.main()
