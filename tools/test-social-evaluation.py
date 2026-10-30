"""Offline protocol checks before spending model quota on replay batches."""
import importlib.util,pathlib,unittest,json,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('evaluation',ROOT/'tools/evaluate-social-phase2.py')
evaluation=importlib.util.module_from_spec(spec);spec.loader.exec_module(evaluation)
class Protocol(unittest.TestCase):
 def test_exact_and_fenced_plans(self):
  value={'items':[{'id':'E01','tool':'finish','args':{'summary':'done'}}]}
  for text in [json.dumps(value),'```json\n'+json.dumps(value)+'\n```']:
   self.assertEqual(evaluation.parse(text),value)
 def test_invalid_shape_and_json_cannot_be_counted_as_normal_silence(self):
  for text in ['[]','null','{}','{"items":null}','{"items":{}}','analysis first\n{"items":[]}','{"items":[']:
   with self.subTest(text=text):self.assertRaises(ValueError,evaluation.parse,text)
 def test_frozen_splits_have_disjoint_ids_and_unchanged_hashes(self):
  directory=ROOT/'tests/fixtures/social-expression';manifest=json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
  groups=[]
  for split in ['development','holdout']:
   raw=(directory/(split+'.json')).read_bytes();self.assertEqual(hashlib.sha256(raw.replace(b'\r\n',b'\n')).hexdigest(),manifest['sha256'][split])
   rows=json.loads(raw);self.assertTrue(all(len(row['turns'])==3 for row in rows));groups.append({r['id'] for r in rows})
  self.assertFalse(groups[0]&groups[1])
if __name__=='__main__':unittest.main()
