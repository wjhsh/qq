import importlib.util,json,sys,tempfile,unittest
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import pi_channels
spec=importlib.util.spec_from_file_location('workbuddy_harness_test',HERE/'harness.py')
harness=importlib.util.module_from_spec(spec);spec.loader.exec_module(harness)


class ChannelTest(unittest.TestCase):
    def test_credentials_and_routes_stay_separate(self):
        google=harness.job_command('a'*12,'pi')
        workbuddy=harness.job_command('b'*12,'pi-workbuddy')
        self.assertIn('EnvironmentFile=/etc/qq-harness/model.env',google)
        self.assertIn('EnvironmentFile=/etc/qq-harness/workbuddy.env',workbuddy)
        self.assertNotIn('EnvironmentFile=/etc/qq-harness/model.env',workbuddy)
        self.assertEqual(workbuddy[workbuddy.index('--provider')+1],'workbuddy')
        self.assertEqual(workbuddy[workbuddy.index('--model')+1],'deepseek-v4.1-flash')
        for required in ['-/var/lib/qq-workbuddy','-/etc/qq-workbuddy','MemoryMax=512M','RuntimeMaxSec=600']:
            self.assertIn(required,'\n'.join(workbuddy))

    def test_broker_freezes_engine_and_rejects_cross_channel_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            broker=harness.Broker(Path(directory),execute=False)
            item=broker.submit('Return a small text file','task','c'*32,'pi-workbuddy')
            self.assertEqual(item['model'],'deepseek-v4.1-flash')
            self.assertEqual(broker.submit(item['prompt'],'task','c'*32,'pi-workbuddy')['id'],item['id'])
            with self.assertRaises(ValueError):broker.submit(item['prompt'],'task','c'*32,'pi')
            with self.assertRaises(ValueError):broker.submit('draw a tree','image',None,'pi-workbuddy')

    def test_pi_only_receives_its_frontend_key_reference(self):
        cfg=pi_channels.models('pi-workbuddy',harness.MODEL)
        self.assertEqual(set(cfg['providers']),{'workbuddy'})
        selected=cfg['providers']['workbuddy']
        self.assertEqual(selected['apiKey'],'${WORKBUDDY_API_KEY}')
        self.assertNotIn('refreshToken',json.dumps(cfg))
        self.assertEqual(selected['models'][0]['samplingParams']['thinking']['type'],'disabled')
        with self.assertRaises(ValueError):pi_channels.models('arbitrary','m')


if __name__=='__main__':unittest.main()
