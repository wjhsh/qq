import base64,copy,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import chat_image
CID='11111111-2222-3333-4444-555555555555'
GROUP='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=')
def asset(name):return {'content_type':'image_asset_pointer','asset_pointer':'sediment://'+name}
def comparison(mid='user'):
 def message(index,name):return {'id':name,'author':{'role':'tool'},'status':'finished_successfully','end_turn':None,'recipient':'all','metadata':{'image_gen_group_id':GROUP,'generation_index':index,'image_gen_paragen_metadata':{'stream_type':'sync-finished-messages'}},'content':{'parts':[asset(name)]}}
 return {'current_node':'second','mapping':{mid:{'parent':'old','message':{'id':mid,'author':{'role':'user'},'content':{'parts':['原话']}}},'old':{'parent':None,'message':{'content':{'parts':[asset('historical')]}}},'first':{'parent':mid,'message':message(0,'first')},'second':{'parent':'first','message':message(1,'second')},'inactive':{'parent':mid,'message':message(0,'unrelated')}}}
class ChatVariantsTest(unittest.TestCase):
 def test_grouped_candidates_select_index_zero_without_old_or_inactive_assets(self):
  self.assertEqual(chat_image.select_output_asset(comparison(),'user'),('sediment://first',2))
 def test_unrelated_unindexed_or_incomplete_outputs_remain_rejected(self):
  for change in ('group','index','missing_group','in_progress','user','is_error','ungrouped_metadata'):
   with self.subTest(change=change):
    data=comparison();message=data['mapping']['second']['message'];meta=message['metadata']
    if change=='group':meta['image_gen_group_id']=CID
    elif change=='index':meta['generation_index']=0
    elif change=='missing_group':meta.pop('image_gen_group_id')
    elif change=='in_progress':message['status']='in_progress'
    elif change=='user':message['author']['role']='user'
    elif change=='is_error':meta['is_error']=True
    else:meta.pop('image_gen_paragen_metadata')
    with self.assertRaises(chat_image.ChatError):chat_image.select_output_asset(data,'user')
 def test_normal_single_output_unchanged_and_missing_turn_rejected(self):
  data=comparison();data['current_node']='first'
  self.assertEqual(chat_image.select_output_asset(data,'user'),('sediment://first',1))
  with self.assertRaises(chat_image.ChatError):chat_image.select_output_asset(data,'missing')
 def test_real_collection_path_reads_candidates_and_downloads_once_without_new_generation(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'auth.json').write_text(json.dumps({'tokens':{'access_token':'test-only'}}))
   client=chat_image.ChatImageClient(root/'auth.json',root/'receipt.json');calls=[];mid=None
   def request(route,payload=None,*args,**kwargs):
    nonlocal mid
    calls.append(route)
    if 'chat-requirements' in route:return {'token':'test'}
    if route.endswith('/prepare'):return {'conduit_token':'test'}
    if route.endswith('/f/conversation'):
     mid=payload['messages'][0]['id']
     return io.BytesIO(('data: '+json.dumps({'conversation_id':CID,'content':{'parts':[asset('second'),asset('first')]}})+'\n\ndata: [DONE]\n').encode())
    if route=='/backend-api/conversation/'+CID:return comparison(mid)
    if route.endswith('/attachment/first/download'):return {'download_url':'https://chatgpt.com/backend-api/estuary/content?test'}
    self.fail(route)
   download=MagicMock();download.open.return_value=io.BytesIO(PNG)
   with patch.object(client,'request',side_effect=request),patch.object(client,'quota',return_value=({},'auto')),patch.object(chat_image,'proof',return_value='test'),patch.object(chat_image.urllib.request,'build_opener',return_value=download):state=client.generate('原话',root/'images')
   self.assertEqual(calls.count('/backend-api/f/conversation'),1);self.assertEqual(state['output_variant_count'],2);self.assertEqual(state['selected_variant_index'],0);self.assertEqual((root/'images/chat-image.png').read_bytes(),PNG);self.assertEqual(download.open.call_count,1)
if __name__=='__main__':unittest.main()
