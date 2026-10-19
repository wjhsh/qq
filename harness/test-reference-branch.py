import base64,copy,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import chat_image
CID='11111111-2222-3333-4444-555555555555';ROOT='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';TAIL='bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=')
def asset(name):return {'content_type':'image_asset_pointer','asset_pointer':'file-service://'+name}
def previous():return {'current_node':TAIL,'mapping':{ROOT:{'parent':None,'message':None},'old-user':{'parent':ROOT,'message':{'id':'old-user','author':{'role':'user'},'content':{'parts':['old description']}}},TAIL:{'parent':'old-user','message':{'id':TAIL,'author':{'role':'tool'},'status':'finished_successfully','recipient':'all','end_turn':None,'content':{'parts':[asset('old-catgirl')]}}}}}
class ReferenceBranchTest(unittest.TestCase):
 def test_reference_branch_keeps_conversation_and_excludes_prior_image_ancestors(self):self.assertEqual(chat_image.reference_branch_parent(previous()),ROOT)
 def test_incomplete_cyclic_or_nonempty_root_never_falls_back_to_old_tail(self):
  for kind in ('missing','cycle','user-root','image-root','nonuuid'):
   with self.subTest(kind=kind):
    c=previous()
    if kind=='missing':c['mapping'].pop(ROOT)
    elif kind=='cycle':c['mapping'][ROOT]['parent']=TAIL
    elif kind=='user-root':c['mapping'][ROOT]['message']={'author':{'role':'user'}}
    elif kind=='image-root':c['mapping'][ROOT]['message']={'content':{'parts':[asset('unexpected')]}}
    else:c['mapping']['not-uuid']=c['mapping'].pop(ROOT);c['mapping']['old-user']['parent']='not-uuid'
    with self.assertRaises(chat_image.ChatError):chat_image.reference_branch_parent(c)
 def test_attachment_request_uses_clean_parent_exact_prompt_and_same_cid(self):self.check(True)
 def test_text_only_followup_still_continues_from_last_image(self):self.check(False)
 def check(self,with_image):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-only'}}));client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json');(root/'session.json').write_text(json.dumps({'conversation_id':CID,'account_fingerprint':client.account_fingerprint}));mid=None;calls=[];prompt='把背景改成浅绿色，人物和服装不变。'
   def request(route,payload=None,*args,**kwargs):
    nonlocal mid
    calls.append(route)
    if route=='/backend-api/conversation/'+CID:
     if mid is None:return previous()
     c=previous();c['mapping'][mid]={'parent':ROOT if with_image else TAIL,'message':{'id':mid,'author':{'role':'user'},'content':{'parts':([asset('input')] if with_image else [])+[prompt]}}};c['mapping']['new']={'parent':mid,'message':{'author':{'role':'tool'},'content':{'parts':[asset('new-output')]}}};c['current_node']='new';return c
    if 'chat-requirements' in route:return {'token':'test'}
    if route.endswith('/prepare'):
     self.assertEqual(payload['conversation_id'],CID);self.assertEqual(payload['parent_message_id'],ROOT if with_image else TAIL);self.assertEqual(payload['partial_query']['content']['parts'][-1],prompt);return {'conduit_token':'test'}
    if route.endswith('/f/conversation'):
     self.assertEqual(payload['parent_message_id'],ROOT if with_image else TAIL);self.assertEqual(payload['conversation_id'],CID);mid=payload['messages'][0]['id'];return io.BytesIO(('data: '+json.dumps({'conversation_id':CID})+'\n\ndata: [DONE]\n').encode())
    if '/files/download/new-output?' in route:return {'download_url':'https://chatgpt.com/backend-api/estuary/content?test'}
    self.fail(route)
   download=MagicMock();download.open.return_value=io.BytesIO(PNG)
   uploaded={'file_id':'input','file_name':'reference.png','file_size':len(PNG),'mime_type':'image/png','width':1,'height':1}
   with patch.object(client,'request',side_effect=request),patch.object(client,'upload_image',return_value=uploaded),patch.object(client,'quota',return_value=({},'auto')),patch.object(chat_image,'proof',return_value='test'),patch.object(chat_image.urllib.request,'build_opener',return_value=download):state=client.generate(prompt,root/'images',root/'session.json',[{'buffer':PNG,'mime':'image/png'}] if with_image else [])
   self.assertEqual(calls.count('/backend-api/f/conversation'),1);self.assertEqual(state['conversation_id'],CID);self.assertTrue(state['session_reused']);self.assertEqual(state.get('reference_context'), 'isolated_branch' if with_image else None)
if __name__=='__main__':unittest.main()
