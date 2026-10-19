import base64,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import image_jobs,harness,codex_engine
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=')
class ImageJobsTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.auth=self.root/'auth';self.images=self.auth/'generated_images';self.images.mkdir(parents=True)
  self.job=self.root/'job';(self.job/'work').mkdir(parents=True);(self.root/'broker').mkdir()
 def test_collects_only_new_native_image_and_preserves_existing_images(self):
  (self.images/'old.png').write_bytes(PNG);image_jobs.prepare(self.job,'cat',self.auth)
  (self.images/'new.png').write_bytes(PNG)
  result=image_jobs.collect(self.job,self.auth);self.assertEqual(result['model'],'gpt-image-2');self.assertEqual((self.job/'work/gpt-image.png').read_bytes(),PNG)
  self.assertTrue((self.images/'old.png').exists())
 def test_no_image_and_symlinked_image_fail_closed(self):
  image_jobs.prepare(self.job,'cat',self.auth)
  with self.assertRaises(ValueError):image_jobs.collect(self.job,self.auth)
  secret=self.root/'outside.png';secret.write_bytes(PNG);(self.images/'escape.png').symlink_to(secret)
  with self.assertRaises(ValueError):image_jobs.collect(self.job,self.auth)
 def test_missing_and_ambiguous_image_errors_have_distinct_codes(self):
  image_jobs.prepare(self.job,'cat',self.auth)
  with self.assertRaises(image_jobs.ImageOutputError) as error:image_jobs.collect(self.job,self.auth)
  self.assertEqual(error.exception.code,'image_no_output')
  for name in ('one.png','two.png'):(self.images/name).write_bytes(PNG)
  with self.assertRaises(image_jobs.ImageOutputError) as error:image_jobs.collect(self.job,self.auth)
  self.assertEqual(error.exception.code,'image_ambiguous_output')
 def test_collection_failure_preserves_model_explanation_and_turn_usage(self):
  broker=harness.Broker(self.root/'broker',execute=False)
  with patch.object(codex_engine,'status',return_value={'authenticated':True}):item=broker.submit('cat',mode='image',engine='codex')
  job=broker.root/'jobs'/item['id'];job.mkdir();(job/'request.txt').write_text('image test')
  events=[{'type':'item.completed','item':{'type':'agent_message','text':'当前无法调用图片工具。'}},
   {'type':'turn.completed','usage':{'input_tokens':123,'cached_input_tokens':45,'output_tokens':67}}]
  process=MagicMock();process.stdin=io.BytesIO();process.stdout=io.BytesIO(('\n'.join(json.dumps(e) for e in events)+'\n').encode());process.wait.return_value=0
  with patch.object(broker.queue,'get',side_effect=[item['id'],StopIteration]),patch.object(broker,'wait_capacity',return_value=True),patch.object(broker,'prepare'),patch.object(harness.subprocess,'Popen',return_value=process),patch.object(harness.threading,'Thread'),patch.object(image_jobs,'collect',side_effect=image_jobs.ImageOutputError('no image','image_no_output')):
   with self.assertRaises(StopIteration):broker.worker()
  saved=broker.get(item['id']);self.assertEqual(saved['status'],'failed');self.assertEqual(saved['error_code'],'image_no_output')
  self.assertEqual(saved['result'],'当前无法调用图片工具。');self.assertEqual(saved['codex_usage']['input_tokens'],123)
  self.assertEqual(saved['usage_scope'],'codex_turn_reported');self.assertEqual(saved['process_exit_code'],0)
 def test_invalid_png_is_not_exported(self):
  image_jobs.prepare(self.job,'cat',self.auth);(self.images/'new.png').write_bytes(b'x'*100)
  with self.assertRaises(ValueError):image_jobs.collect(self.job,self.auth)
  self.assertFalse((self.job/'work/gpt-image.png').exists())
 def test_image_mode_disables_shell_and_subagents_and_has_its_own_deadline(self):
  args='\n'.join(harness.job_command('a'*12,'codex','image'))
  for key in ['features.shell_tool=false','features.multi_agent=false','RuntimeMaxSec=240','MemoryMax=512M']:self.assertIn(key,args)
  self.assertNotIn('features.shell_tool=false','\n'.join(codex_engine.arguments()))
 def test_image_submission_requires_codex_and_limits_description(self):
  broker=harness.Broker(self.root/'broker',execute=False)
  with self.assertRaises(ValueError):broker.submit('cat',mode='image',engine='pi')
  with patch.object(codex_engine,'status',return_value={'authenticated':True}):
   with self.assertRaises(ValueError):broker.submit('x'*2201,mode='image',engine='codex')
   result=broker.submit('cat',mode='image',engine='codex');self.assertEqual(result['mode'],'image')
 def test_only_collected_image_has_the_larger_artifact_limit(self):
  broker=harness.Broker(self.root/'broker',execute=False)
  with patch.object(codex_engine,'status',return_value={'authenticated':True}):item=broker.submit('cat',mode='image',engine='codex')
  work=broker.root/'jobs'/item['id']/'work';work.mkdir(parents=True);item['status']='succeeded';broker.items[item['id']]=item
  for name in ['gpt-image.png','other.bin']:(work/name).write_bytes(b'x'*(2*1024*1024+1))
  self.assertTrue(broker.artifact(item['id'],'gpt-image.png')['base64'])
  with self.assertRaises(ValueError):broker.artifact(item['id'],'other.bin')
if __name__=='__main__':unittest.main()
