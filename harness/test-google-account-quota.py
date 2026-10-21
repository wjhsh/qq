import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import cloud_controls as cloud

class AccountQuotaTest(unittest.TestCase):
 def fixture(self,root):
  (root/'accounts').mkdir()
  for number,prefix in [(1,''),(2,'account2')]:
   (root/'accounts'/f'antigravity-{number}.json').write_text(json.dumps({'prefix':prefix,'disabled':False,'refresh_token':f'PRIVATE_REFRESH_{number}','access_token':f'PRIVATE_ACCESS_{number}','project_id':f'PRIVATE_PROJECT_{number}','email':f'PRIVATE_EMAIL_{number}'}))
  return lambda value: root/'accounts' if value=='/var/lib/codex-gateway/accounts' else root/'config.json' if value=='/var/lib/qq-agent/config.json' else Path(value)
 def test_selected_account_queries_only_its_own_credentials_and_exposes_no_identity(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);paths=self.fixture(root);control=cloud.Controls();calls=[]
   def request(url,**kwargs):
    calls.append(kwargs);return {'models':{'gemini-test':{'displayName':'test','quotaInfo':{'remainingFraction':.8}}}}
   with patch.object(cloud,'Path',side_effect=paths),patch.object(control,'json',side_effect=request):
    for number in (1,2):
     (root/'config.json').write_text(json.dumps({'api':{'model':('account2/' if number==2 else '')+'gemini-test'}}))
     value=control.google();self.assertEqual(value['account_label'],'账号'+str(number));self.assertEqual(value['account_count'],2)
     self.assertEqual(calls[-1]['headers']['Authorization'],'Bearer PRIVATE_ACCESS_'+str(number))
     self.assertNotIn('PRIVATE_',json.dumps(value))
 def test_missing_or_duplicate_selected_account_never_falls_back(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);paths=self.fixture(root);control=cloud.Controls()
   (root/'accounts/antigravity-2.json').unlink()
   with patch.object(cloud,'Path',side_effect=paths),patch.object(control,'json') as request:
    value=control.google(2);self.assertFalse(value['available']);request.assert_not_called()
    (root/'accounts/antigravity-duplicate.json').write_text((root/'accounts/antigravity-1.json').read_text())
    value=control.google(1);self.assertFalse(value['available']);request.assert_not_called()
 def test_selection_is_captured_with_an_account_specific_cache_key(self):
  control=cloud.Controls();selected=[1];calls=[]
  def google(number=None):calls.append(number);return {'available':True,'account_label':'账号'+str(number)}
  with patch.object(control,'google_account_number',side_effect=lambda:selected[0]),patch.object(control,'google',side_effect=google),patch.object(control,'traffic',return_value={'available':True}),patch.object(cloud,'qq_usage',return_value={}):
   self.assertEqual(control.quotas()['google']['account_label'],'账号1')
   selected[0]=2;self.assertEqual(control.quotas()['google']['account_label'],'账号2')
   selected[0]=1;self.assertEqual(control.quotas()['google']['account_label'],'账号1')
   self.assertEqual(calls,[1,2])
 def test_unknown_selection_does_not_query_a_different_account(self):
  control=cloud.Controls()
  with patch.object(control,'google_account_number',return_value=None),patch.object(control,'google') as google,patch.object(control,'traffic',return_value={}),patch.object(cloud,'qq_usage',return_value={}):
   self.assertFalse(control.quotas()['google']['available']);google.assert_not_called()
  with patch.object(control,'google_account_number',return_value=None),patch.object(control,'json') as request:
   self.assertFalse(control.google()['available']);request.assert_not_called()

if __name__=='__main__':unittest.main()
