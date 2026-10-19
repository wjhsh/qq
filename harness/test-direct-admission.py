import unittest,tempfile,json,io,urllib.error
from pathlib import Path
from unittest.mock import patch,MagicMock
import chat_image,harness
PNG=__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=')
class DirectAdmission(unittest.TestCase):
 def test_backend_verification_response_is_terminal_even_with_http_200(self):
  for payload in [{'error':{'code':'verification_required'}},{'error_code':'challenge_required','error':'verify'}]:
   error=chat_image.response_error(payload);self.assertEqual(error.code,'verification_required')
 def test_no_conduit_permit_means_zero_generation_submissions(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-only'}}));client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json');calls=[]
   def request(route,*args,**kwargs):
    calls.append(route)
    if 'chat-requirements' in route:return {'token':'test','turnstile':{'required':True,'dx':'client-validation-announcement'}}
    if route.endswith('/prepare'):return {'status':'failed'}
    self.fail('Generation must not occur')
   with patch.object(client,'quota',return_value=({},'auto')),patch.object(client,'request',side_effect=request),patch.object(chat_image,'proof',return_value='test-client-proof'):
    with self.assertRaises(chat_image.ChatError):client.generate('cat',root/'images')
   self.assertEqual(client.state['generation_submissions'],0);self.assertEqual(len(calls),2)
 def test_normal_server_permit_allows_one_request_and_real_error_stops_it(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-only'}}));client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json');calls=[]
   def request(route,*args,**kwargs):
    calls.append(route)
    if 'chat-requirements' in route:return {'token':'test','turnstile':{'required':True,'dx':'client-validation-announcement'}}
    if route.endswith('/prepare'):return {'status':'success','conduit_token':'server-test-permit'}
    if route.endswith('/f/conversation'):return io.BytesIO(b'data: {"error":{"code":"verification_required"}}\n\n')
    self.fail(route)
   with patch.object(client,'quota',return_value=({},'auto')),patch.object(client,'request',side_effect=request),patch.object(chat_image,'proof',return_value='test-client-proof'):
    with self.assertRaises(chat_image.ChatError) as e:client.generate('cat',root/'images')
   self.assertEqual(e.exception.code,'verification_required');self.assertTrue(client.state['prepare_permit_received']);self.assertEqual(calls.count('/backend-api/f/conversation'),1)
 def test_http_verification_failure_is_not_misreported_as_expired_login(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'auth.json';p.write_text(json.dumps({'tokens':{'access_token':'test-only'}}));opener=MagicMock();opener.open.side_effect=urllib.error.HTTPError('https://chatgpt.com/backend-api/f/conversation',403,'Forbidden',{},io.BytesIO(b'{"error":{"code":"verification_required"}}'))
   c=chat_image.ChatImageClient(p,Path(d)/'receipt.json',opener=opener)
   with self.assertRaises(chat_image.ChatError) as e:c.request('/backend-api/f/conversation',{})
   self.assertEqual(e.exception.code,'verification_required')
 def test_native_image_budget_is_blocked_before_codex_can_run(self):
  with self.assertRaisesRegex(ValueError,'关闭'):harness.job_command('a'*12,'codex','image')
  with tempfile.TemporaryDirectory() as d:
   b=harness.Broker(Path(d),execute=False)
   with self.assertRaisesRegex(ValueError,'关闭'):b.submit('cat',engine='codex',mode='image')
 def test_chat_command_does_not_start_codex_or_browser(self):
  command='\n'.join(harness.job_command('a'*12,'chatgpt','image'))
  self.assertIn('chat_image.py',command);self.assertIn('BindReadOnlyPaths=',command)
  for forbidden in ['chat_browser_image','/codex/node_modules','playwright','qq-chat-browser']:self.assertNotIn(forbidden,command)
if __name__=='__main__':unittest.main()
