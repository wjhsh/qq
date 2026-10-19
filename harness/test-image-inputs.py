import base64,hashlib,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
from PIL import Image
import image_inputs,chat_image,harness,codex_engine

def png(color='blue'):
 out=io.BytesIO();Image.new('RGB',(32,24),color).save(out,format='PNG');return out.getvalue()
def encoded(data):return {'base64':base64.b64encode(data).decode(),'mime':'image/png','sha256':hashlib.sha256(data).hexdigest()}

class ImageInputsTest(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
 def test_bounded_input_decoding_and_manifest_verification(self):
  data=png();rows=image_inputs.decode_inputs([encoded(data)]);self.assertEqual((rows[0]['width'],rows[0]['height']),(32,24))
  directory=self.root/'image-inputs';directory.mkdir();(directory/'input-0.png').write_bytes(data)
  manifest=self.root/'image-inputs.json';manifest.write_text(json.dumps([{'file':'input-0.png','mime':'image/png','sha256':rows[0]['sha256']}]))
  self.assertEqual(image_inputs.load_manifest(manifest)[0]['buffer'],data)
  for bad in ([encoded(data)]*5,[{**encoded(data),'mime':'image/jpeg'}],[{**encoded(data),'sha256':'wrong'}],[{**encoded(data),'url':'http://127.0.0.1'}],[encoded(b'not an image')]):
   with self.assertRaises(image_inputs.ImageInputError):image_inputs.decode_inputs(bad)
  manifest.write_text(json.dumps([{'file':'../auth.json','mime':'image/png','sha256':'x'}]))
  with self.assertRaises(ValueError):image_inputs.load_manifest(manifest)

 def test_broker_persists_metadata_not_image_bytes_and_prepares_private_inputs(self):
  broker=harness.Broker(self.root,execute=False);data=png();payload=[encoded(data)]
  with patch.object(codex_engine,'status',return_value={'authenticated':True}):
   item=broker.submit('原话',engine='chatgpt',mode='image',request_id='a'*32,input_images=payload)
   self.assertEqual(broker.submit('原话',engine='chatgpt',mode='image',request_id='a'*32,input_images=payload)['id'],item['id'])
   with self.assertRaises(ValueError):broker.submit('原话',engine='chatgpt',mode='image',request_id='a'*32,input_images=[encoded(png('red'))])
  state=(self.root/'state'/(item['id']+'.json')).read_text();self.assertNotIn(payload[0]['base64'],state)
  with patch.object(harness.shutil,'chown'):broker.prepare(item)
  job=self.root/'jobs'/item['id'];self.assertEqual(image_inputs.load_manifest(job/'image-inputs.json')[0]['buffer'],data);self.assertFalse((self.root/'input-staging'/item['id']).exists())
  self.assertFalse(broker.files(item['id']))

 def test_reference_upload_does_not_send_auth_to_external_signed_host(self):
  auth=self.root/'auth.json';auth.write_text(json.dumps({'tokens':{'access_token':'test-only'}}));client=chat_image.ChatImageClient(auth,self.root/'receipt.json');uploader=MagicMock();uploader.open.return_value=io.BytesIO(b'')
  def request(route,payload=None,*args,**kwargs):
   if route=='/backend-api/files':return {'file_id':'file_reference','upload_url':'https://test.blob.core.windows.net/private?signed=never-log'}
   self.assertEqual(route,'/backend-api/files/file_reference/uploaded');return {}
  with patch.object(client,'request',side_effect=request),patch.object(chat_image.urllib.request,'build_opener',return_value=uploader):reference=client.upload_image({'buffer':png(),'mime':'image/png'},0)
  self.assertEqual(reference['width'],32);self.assertEqual(uploader.open.call_args.args[0].get_method(),'PUT');self.assertIsNone(uploader.open.call_args.args[0].get_header('Authorization'))

 def test_multimodal_request_excludes_input_image_from_output_collection(self):
  auth=self.root/'auth.json';auth.write_text(json.dumps({'tokens':{'access_token':'test-only'}}));client=chat_image.ChatImageClient(auth,self.root/'receipt.json');raw='把蓝色圆球改成红色';input_data=png();mid=None
  cid='11111111-2222-3333-4444-555555555555';reference={'file_id':'file_input','file_name':'reference-1.png','file_size':len(input_data),'mime_type':'image/png','width':32,'height':24};calls=[]
  def asset(name):return {'content_type':'image_asset_pointer','asset_pointer':'file-service://'+name}
  def request(route,payload=None,*args,**kwargs):
   nonlocal mid
   calls.append(route)
   if 'chat-requirements' in route:return {'token':'test'}
   if route.endswith('/prepare'):
    self.assertEqual(payload['partial_query']['content']['content_type'],'multimodal_text');self.assertEqual(payload['partial_query']['content']['parts'][-1],raw);return {'conduit_token':'test'}
   if route.endswith('/f/conversation'):
    message=payload['messages'][0];mid=message['id'];self.assertEqual(message['metadata']['attachments'][0]['id'],'file_input');self.assertEqual(message['content']['parts'][-1],raw)
    return io.BytesIO(('data: '+json.dumps({'conversation_id':cid,'message':{'author':{'role':'user'},'content':{'parts':[asset('file_input')]}}})+'\n\ndata: [DONE]\n').encode())
   if route=='/backend-api/conversation/'+cid:return {'current_node':'result','mapping':{mid:{'parent':None,'message':{'id':mid,'author':{'role':'user'},'content':{'parts':[asset('file_input'),raw]}}},'result':{'parent':mid,'message':{'author':{'role':'tool'},'content':{'parts':[asset('file_output')]}}}}}
   if '/files/download/file_output?' in route:return {'download_url':'https://chatgpt.com/backend-api/estuary/content?test'}
   self.fail('Input image or extra generation must never be downloaded as output: '+route)
  download=MagicMock();download.open.return_value=io.BytesIO(png('red'))
  with patch.object(client,'request',side_effect=request),patch.object(client,'quota',return_value=({},'auto')),patch.object(client,'upload_image',return_value=reference),patch.object(chat_image,'proof',return_value='test'),patch.object(chat_image.urllib.request,'build_opener',return_value=download):state=client.generate(raw,self.root/'output',input_images=[{'buffer':input_data,'mime':'image/png'}])
  self.assertEqual(state['input_image_count'],1);self.assertEqual(state['generation_submissions'],1);self.assertEqual(calls.count('/backend-api/f/conversation'),1);self.assertEqual((self.root/'output/chat-image.png').read_bytes(),png('red'))

if __name__=='__main__':unittest.main()
