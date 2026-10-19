import importlib.util,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
from resource_policy import admission_reason,full_pressure,parse_memory
spec=importlib.util.spec_from_file_location('harness',Path(__file__).with_name('harness.py'));harness=importlib.util.module_from_spec(spec);spec.loader.exec_module(harness)

class PolicyTests(unittest.TestCase):
    def good(self,**kw):return dict({'memory_available_mib':640,'disk_free_mib':2048,'memory_full_avg10':0.,'swap_used_mib':1024},**kw)
    def test_exact_thresholds_admit(self):self.assertEqual(admission_reason(self.good()),'')
    def test_low_memory_waits(self):
        d=self.good();d['memory_available_mib']=639;self.assertIn('内存',admission_reason(d))
    def test_low_disk_waits(self):
        d=self.good();d['disk_free_mib']=2047;self.assertIn('磁盘',admission_reason(d))
    def test_pressure_waits(self):
        d=self.good();d['memory_full_avg10']=1.;self.assertIn('回收',admission_reason(d))
    def test_unknown_metrics_fail_closed(self):
        for key in ['memory_available_mib','disk_free_mib','memory_full_avg10']:
            d=self.good();d[key]=None;self.assertIn('无法读取',admission_reason(d))
    def test_historical_swap_use_does_not_prevent_work(self):
        d=self.good();d['swap_used_mib']=2000;self.assertEqual(admission_reason(d),'')
    def test_metric_parsing(self):
        self.assertEqual(parse_memory('MemAvailable: 2048000 kB\nSwapFree: 30 kB')['MemAvailable'],2048000)
        self.assertEqual(full_pressure('some avg10=99\nfull avg10=0.25 avg60=1 total=30'),.25)
        for value in ['nan','inf','-1','invalid']:self.assertIsNone(full_pressure('full avg10='+value))
    def test_tasks_use_aggregate_budget_and_lower_priority(self):
        args=' '.join(harness.job_command('a'*12))
        for expected in ['Slice=qqtasks.slice','MemorySwapMax=128M','CPUWeight=20','IOWeight=20','Nice=10','OOMScoreAdjust=500','OOMPolicy=kill']:self.assertIn(expected,args)

class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.b=harness.Broker(self.root,execute=False);self.item=self.b.items[self.b.submit('resource test')['id']]
        self.low={'memory_available_mib':400,'disk_free_mib':4096,'memory_full_avg10':0.}
        self.good={'memory_available_mib':800,'disk_free_mib':4096,'memory_full_avg10':0.}
    def test_wait_does_not_create_workspace_and_resumes(self):
        class Event:
            def wait(_,seconds):self.assertEqual(seconds,10);self.assertEqual(self.item['status'],'queued');self.assertIn('内存',self.item['waiting_reason']);self.assertFalse((self.root/'jobs'/self.item['id']).exists())
            def clear(_):pass
        self.b.capacity_changed=Event()
        with patch.object(harness,'resource_snapshot',side_effect=[self.low,self.good]):self.assertTrue(self.b.wait_capacity(self.item))
        self.assertEqual(self.item['waiting_reason'],'');self.assertEqual(self.item['status'],'queued')
    def test_cancel_wakes_wait_without_launching_job(self):
        result=[]
        with patch.object(harness,'resource_snapshot',return_value=self.low),patch.object(harness,'job_command') as launch:
            t=threading.Thread(target=lambda:result.append(self.b.wait_capacity(self.item)),daemon=True);t.start()
            for _ in range(50):
                if self.item.get('waiting_reason'):break
                time.sleep(.01)
            self.b.cancel(self.item['id']);t.join(1);self.assertFalse(t.is_alive());self.assertEqual(result,[False]);launch.assert_not_called()
        self.assertFalse((self.root/'jobs'/self.item['id']).exists())
    def test_queue_count_includes_resource_waiting_head(self):
        self.b.queue.get();self.item['waiting_reason']='waiting'
        with patch.object(harness,'command',return_value=type('R',(),{'stdout':'ActiveState=active'})()),patch.object(harness,'resource_snapshot',return_value=self.good):
            s=self.b.status()
        self.assertEqual(s['queue'],1);self.assertEqual(s['waiting_resources'],1);self.assertEqual(s['running'],0)

if __name__=='__main__':unittest.main()
