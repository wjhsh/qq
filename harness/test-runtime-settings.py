import json,tempfile,unittest
from pathlib import Path
from runtime_settings import RuntimeSettings
class SettingsTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.data=self.root/'data';self.data.mkdir();(self.data/'messages').mkdir()
  self.cfg={'allow':{'groups':['12345']},'api':{'apiKey':'DO_NOT_EXPORT'},'server':{'token':'DO_NOT_EXPORT'},'personaUnified':False,
   'customPersonas':[{'id':'cat','name':'猫','text':'猫的身份','customRules':'','systemPromptOverride':'','participation':'medium'}],
   'personaByChat':{'group:12345':{'roleCardId':'cat'}},'botInteraction':{'enabled':True,'byGroup':{}}}
  (self.data/'config.json').write_text(json.dumps(self.cfg))
  (self.data/'messages/group_12345.json').write_text(json.dumps({'messages':[{'senderId':'34567','senderName':'木折','text':'下回叫瓦神','self':False}]}))
  self.settings=RuntimeSettings(self.root,data=self.data,stop=lambda:None,reload=lambda:None)
  self.job='a'*12;self.work=self.root/'work';self.work.mkdir();self.settings.prepare(self.job,self.work)
 def request(self,ops):
  (self.work/'settings-change.json').write_text(json.dumps({'operations':ops}))
  return self.settings.review(self.job,self.work)
 def test_private_configuration_never_enters_agent_context(self):
  self.assertNotIn('DO_NOT_EXPORT',(self.work/'group-settings-context.json').read_text())
 def test_scoped_memory_is_applied_and_other_config_preserved(self):
  review=self.request([{'action':'remember','groupId':'12345','userId':'34567','content':'在本群称呼为瓦神。'}])
  self.assertTrue(review['can_apply']);self.settings.apply(self.job,review['review_sha'])
  self.assertEqual(json.loads((self.data/'memory/group_12345/34567.json').read_text())['impressions'][0]['content'],'在本群称呼为瓦神。')
  self.assertEqual(json.loads((self.data/'config.json').read_text())['api']['apiKey'],'DO_NOT_EXPORT')
 def test_unknown_group_member_and_shell_fields_are_rejected(self):
  for op in [{'action':'remember','groupId':'99999','userId':'34567','content':'a'},
   {'action':'remember','groupId':'12345','userId':'99999','content':'a'},
   {'action':'remember','groupId':'12345','userId':'34567','content':'a','command':'whoami'}]:
   with self.assertRaises(ValueError):self.request([op])
 def test_configuration_change_after_review_cannot_be_overwritten(self):
  review=self.request([{'action':'bot','groupId':'12345','userId':'34567','enabled':True}])
  self.cfg['botInteraction']['byGroup']['12345']=['77777'];(self.data/'config.json').write_text(json.dumps(self.cfg))
  with self.assertRaises(ValueError):self.settings.apply(self.job,review['review_sha'])
  self.assertEqual(json.loads((self.data/'config.json').read_text())['botInteraction']['byGroup']['12345'],['77777'])
 def test_failed_reload_restores_previous_files(self):
  review=self.request([{'action':'remember','groupId':'12345','userId':'34567','content':'在本群称呼为瓦神。'}])
  calls=[]
  def reload():
   calls.append(1)
   if len(calls)==1:raise RuntimeError('validation failed')
  self.settings.reload=reload
  with self.assertRaises(RuntimeError):self.settings.apply(self.job,review['review_sha'])
  self.assertFalse((self.data/'memory/group_12345/34567.json').exists());self.assertEqual(len(calls),2)
if __name__=='__main__':unittest.main()
