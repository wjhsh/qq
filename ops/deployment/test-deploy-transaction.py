"""Linux-only isolated transaction tests; every service and HTTP call is mocked."""
import importlib.util,pathlib,tempfile,json,hashlib,unittest,os,sys
spec=importlib.util.spec_from_file_location('transaction',pathlib.Path(__file__).with_name('deploy-transaction.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
class Transactions(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='hajimi-transaction-test-');self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name)
  original_chown=os.chown
  if os.geteuid()!=0:
   def fixture_chown(p,uid,gid):
    assert pathlib.Path(p).resolve().is_relative_to(self.root)
    return original_chown(p,os.getuid() if uid==0 else uid,os.getgid() if gid==0 else gid)
   d.os.chown=fixture_chown;self.addCleanup(setattr,d.os,'chown',original_chown)
  d.ROOT=str(self.root/'live');d.CFG=str(self.root/'data/config.json');d.DEPLOY_ROOT=str(self.root/'deploy');d.STAGING_ROOT=str(self.root/'deploy/staging');d.BACKUP_ROOT=str(self.root/'deploy/backups')
  self.stage=pathlib.Path(d.STAGING_ROOT)/'release-test';self.prod=pathlib.Path(d.ROOT)
  for p in [self.prod/'src',self.prod/'skills/local-voice',self.stage/'qq-agent/src',self.stage/'qq-agent/skills/local-voice',pathlib.Path(d.CFG).parent]:p.mkdir(parents=True,exist_ok=True)
  self.oldcfg={'api':{'apiKey':'fixture-only','model':'fixture'},'persona':{'roleText':'cat'},'voice':{'provider':None},'other':[1,2]}
  pathlib.Path(d.CFG).write_text(json.dumps(self.oldcfg));os.chmod(d.CFG,0o600)
  self.p1=self.prod/'src/a.mjs';self.p1.write_text('export const oldValue=1;\n');os.chmod(self.p1,0o640)
  self.p2=self.prod/'skills/local-voice/skill.json';self.p2.write_text('{"name":"old"}');os.chmod(self.p2,0o644)
  (self.stage/'qq-agent/src/a.mjs').write_text('export const newValue=2;\n')
  (self.stage/'qq-agent/src/new.mjs').write_text('export const added=true;\n')
  (self.stage/'qq-agent/skills/local-voice/skill.json').write_text('{"name":"new"}')
  self.files=[{'path':'src/a.mjs','old_sha256':digest(self.p1),'new_sha256':digest(self.stage/'qq-agent/src/a.mjs')},
   {'path':'src/new.mjs','old_sha256':None,'new_sha256':digest(self.stage/'qq-agent/src/new.mjs')},
   {'path':'skills/local-voice/skill.json','old_sha256':digest(self.p2),'new_sha256':digest(self.stage/'qq-agent/skills/local-voice/skill.json')}]
  self.manifest={'release':'release-test','revision':'fixture','files':self.files};self.save_manifest()
  self.calls=[];d.svc_active=lambda:True;d.svc_stop=lambda:self.calls.append('stop');d.svc_start=lambda:self.calls.append('start')
  d.http_status=lambda cfg:{'paused':True,'orchestrator':{'running':[],'waiting':[],'activeSessions':[]}}
  self.write=d.atomic_write;self.addCleanup(setattr,d,'atomic_write',self.write)
 def save_manifest(self):(self.stage/'manifest.json').write_text(json.dumps(self.manifest))
 def apply(self):d.do_apply('release-test',str(self.stage))
 def backup(self):return str(pathlib.Path(d.BACKUP_ROOT)/'release-test')
 def test_apply_rollback_preserves_identity_and_unrelated_new_config(self):
  self.apply();cfg=d.read_cfg();self.assertTrue(cfg['socialBehavior']['enabled']);self.assertEqual(cfg['persona'],self.oldcfg['persona']);self.assertEqual(cfg['api'],self.oldcfg['api'])
  self.assertEqual(os.stat(d.CFG).st_mode&0o777,0o600);self.assertEqual(os.stat(self.p1).st_mode&0o777,0o640)
  cfg['adminLater']='keep';cfg['socialBehavior']['newSetting']='keep';pathlib.Path(d.CFG).write_text(json.dumps(cfg))
  d.do_rollback(self.backup());restored=d.read_cfg();self.assertEqual(restored['voice']['provider'],None);self.assertEqual(restored['socialBehavior'],{'newSetting':'keep'});self.assertEqual(restored['adminLater'],'keep')
  self.assertIn('oldValue',self.p1.read_text());self.assertFalse((self.prod/'src/new.mjs').exists())
 def test_missing_sections_restore_exactly(self):
  del self.oldcfg['voice'];pathlib.Path(d.CFG).write_text(json.dumps(self.oldcfg));self.apply();d.do_rollback(self.backup());self.assertEqual(d.read_cfg(),self.oldcfg)
 def test_manifest_hash_mismatch_stops_no_service(self):
  self.files[0]['old_sha256']='0'*64;self.save_manifest();self.assertRaises(d.DeployError,self.apply);self.assertEqual(self.calls,[])
 def test_duplicate_path_rejected_before_stop(self):
  self.files.append(self.files[0]);self.save_manifest();self.assertRaises(d.DeployError,self.apply);self.assertEqual(self.calls,[])
 def test_pause_and_nested_idle_are_required(self):
  for st in [{'paused':False,'orchestrator':{'running':[],'waiting':[],'activeSessions':[]}}, {'paused':True,'running':0,'waiting':0}, {'paused':True,'orchestrator':{'running':['busy'],'waiting':[],'activeSessions':[]}}]:self.assertFalse(d.status_idle(st))
  d.http_status=lambda cfg:{'paused':False};self.assertRaises(d.DeployError,self.apply);self.assertEqual(self.calls,[])
 def test_syntax_failure_precedes_stop(self):
  p=self.stage/'qq-agent/src/a.mjs';p.write_text('this is invalid javascript %%%');self.files[0]['new_sha256']=digest(p);self.save_manifest();self.assertRaises(d.DeployError,self.apply);self.assertEqual(self.calls,[])
 def test_write_failure_rolls_back_exact_source_and_keeps_backup(self):
  count=0
  def failed_once(*args):
   nonlocal count;count+=1
   if count==2:raise OSError('fixture')
   return self.write(*args)
  d.atomic_write=failed_once;self.assertRaises(OSError,self.apply);self.assertIn('oldValue',self.p1.read_text());self.assertEqual(d.read_cfg(),self.oldcfg);self.assertTrue(pathlib.Path(self.backup()).exists());self.assertEqual(self.calls[-1],'start')
 def test_corrupt_backup_rejected_before_rollback_stop(self):
  self.apply();self.calls.clear();p=pathlib.Path(self.backup())/'src/src/a.mjs';p.write_text('tampered');self.assertRaises(d.DeployError,d.do_rollback,self.backup());self.assertEqual(self.calls,[])
 def test_rollback_rejects_user_edit_and_type_conflict(self):
  self.apply();self.calls.clear();cfg=d.read_cfg();cfg['socialBehavior']['enabled']=1;pathlib.Path(d.CFG).write_text(json.dumps(cfg));self.assertRaises(d.DeployError,d.do_rollback,self.backup());self.assertEqual(self.calls,[])
 def test_symlink_and_traversal_are_rejected(self):
  for p in ['../x.mjs','/etc/x.mjs','src/../x.mjs','src/x.py','skills/other/index.js']:self.assertFalse(d.safe_rel(p))
  outside=self.root/'outside';outside.mkdir();os.symlink(outside,self.prod/'src/redirect');self.files[0]['path']='src/redirect/a.mjs';self.save_manifest();self.assertRaises(d.DeployError,self.apply);self.assertEqual(self.calls,[])
 def test_knowledge_asset_is_exact_whitelist_and_rollback_removes_only_added_file(self):
  p=self.stage/'qq-agent/knowledge/humor-mechanisms-v1.json';p.parent.mkdir();p.write_text('{"version":1,"cards":[]}')
  self.files.append({'path':'knowledge/humor-mechanisms-v1.json','old_sha256':None,'new_sha256':digest(p)});self.save_manifest()
  self.apply();self.assertTrue((self.prod/'knowledge/humor-mechanisms-v1.json').exists());d.do_rollback(self.backup());self.assertFalse((self.prod/'knowledge/humor-mechanisms-v1.json').exists())
  for name in ['knowledge/config.json','knowledge/other.json','knowledge/../config.json']:self.assertFalse(d.safe_rel(name))
 def test_invalid_knowledge_json_stops_no_service(self):
  p=self.stage/'qq-agent/knowledge/humor-mechanisms-v1.json';p.parent.mkdir();p.write_text('broken json')
  self.files.append({'path':'knowledge/humor-mechanisms-v1.json','old_sha256':None,'new_sha256':digest(p)});self.save_manifest();self.assertRaises(d.DeployError,self.apply);self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
