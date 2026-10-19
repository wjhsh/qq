import json,os,tempfile,time,unittest
from pathlib import Path
from maintenance_jobs import Maintenance,snapshot

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name)
        self.source=self.base/'source';(self.source/'src').mkdir(parents=True);(self.source/'src'/'server.js').write_text('export const x=1;\n')
        self.root=self.base/'state';self.root.mkdir();self.work=self.base/'work';self.work.mkdir();self.id='a'*12;self.reloads=0
        self.m=Maintenance(self.root,self.source,validate=self.validate,reload=self.reload)
        self.m.prepare(self.id,self.work)
    def validate(self,name,data):
        if b'INVALID' in data:raise ValueError('syntax')
    def reload(self):self.reloads+=1
    def edit(self,text='export const x=2;\n'):(self.work/'project'/'src'/'server.js').write_text(text)
    def wait(self,desired):
        for _ in range(100):
            state=self.m.state(self.id)
            if state and state['status'] in desired:return state
            time.sleep(.02)
        self.fail(str(state))
    def test_review_freezes_bytes_and_apply_is_idempotent(self):
        self.edit();review=self.m.review(self.id,self.work);self.assertTrue(review['can_apply']);self.assertIn('-export const x=1',review['diff'])
        self.edit('export const x=999;\n');self.m.apply(self.id,review['review_sha']);self.wait(['applied'])
        self.assertEqual((self.source/'src/server.js').read_text(),'export const x=2;\n')
        self.m.apply(self.id,review['review_sha']);self.assertEqual(self.reloads,1)
        self.m.rollback(self.id);self.wait(['rolled_back']);self.assertEqual((self.source/'src/server.js').read_text(),'export const x=1;\n')
    def test_production_cas_conflict(self):
        self.edit();r=self.m.review(self.id,self.work);(self.source/'src/server.js').write_text('new owner change')
        with self.assertRaises(ValueError):self.m.apply(self.id,r['review_sha'])
        self.assertEqual(self.reloads,0)
    def test_invalid_syntax_blocks_apply(self):
        self.edit('INVALID');r=self.m.review(self.id,self.work);self.assertFalse(r['can_apply'])
        with self.assertRaises(ValueError):self.m.apply(self.id,r['review_sha'])
    def test_unknown_review_cannot_apply(self):
        self.edit();self.m.review(self.id,self.work)
        with self.assertRaises(ValueError):self.m.apply(self.id,'b'*64)
    def test_symlinks_and_hardlinks_rejected(self):
        file=self.work/'project/src/server.js';file.unlink();file.symlink_to(self.source/'src/server.js')
        with self.assertRaises(ValueError):self.m.review(self.id,self.work)
        file.unlink();os.link(self.source/'src/server.js',file)
        with self.assertRaises(ValueError):self.m.review(self.id,self.work)
    def test_symlink_directory_rejected(self):
        import shutil
        shutil.rmtree(self.work/'project/src');(self.work/'project/src').symlink_to(self.source/'src',target_is_directory=True)
        with self.assertRaises(ValueError):self.m.review(self.id,self.work)
    def test_credentials_and_dependencies_are_not_copied_or_applied(self):
        project=self.work/'project';(project/'.env').write_text('SECRET');(project/'scripts').mkdir();(project/'scripts/root.sh').write_text('bad')
        self.assertFalse(self.m.review(self.id,self.work)['can_apply']);self.assertFalse((self.source/'.env').exists())
        with self.assertRaises(ValueError):self.m.replace('../evil.js',b'bad')
        with self.assertRaises(ValueError):self.m.replace('scripts/x.js',b'bad')
    def test_reload_failure_restores_source(self):
        self.edit();r=self.m.review(self.id,self.work)
        def fail_first():
            self.reloads+=1
            if self.reloads==1:raise RuntimeError('health check failed')
        self.m.reload=fail_first;self.m.apply(self.id,r['review_sha']);state=self.wait(['rolled_back','failed'])
        self.assertEqual(state['status'],'rolled_back');self.assertEqual((self.source/'src/server.js').read_text(),'export const x=1;\n')
    def test_rollback_refuses_subsequent_modifications(self):
        self.edit();r=self.m.review(self.id,self.work);self.m.apply(self.id,r['review_sha']);self.wait(['applied'])
        (self.source/'src/server.js').write_text('someone changed it')
        with self.assertRaises(ValueError):self.m.rollback(self.id)
    def test_recover_interrupted_transaction(self):
        self.edit();r=self.m.review(self.id,self.work)
        folder=self.m.directory(self.id);(self.source/'src/server.js').write_text('export const x=2;\n')
        (folder/'deployment.json').write_text(json.dumps({'status':'applying','review_sha':r['review_sha'],'changed':['src/server.js']}))
        self.m.recover();self.assertEqual(self.m.state(self.id)['status'],'rolled_back')
    def test_invalid_id_cannot_cross_task(self):
        for job in ['../a','a'*13,'z'*12]:
            with self.assertRaises(ValueError):self.m.directory(job)

if __name__=='__main__':unittest.main()
