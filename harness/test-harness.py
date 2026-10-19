import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from cloud_controls import Controls, quota_models

spec = importlib.util.spec_from_file_location('harness', Path(__file__).with_name('harness.py'))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class BrokerTest(unittest.TestCase):
    def test_repeated_mobile_submission_is_not_executed_twice(self):
        a=self.broker.submit('test','task','a'*32);b=self.broker.submit('test','task','a'*32)
        self.assertEqual(a['id'],b['id']);self.assertEqual(self.broker.queue.qsize(),1)
        with self.assertRaises(ValueError):self.broker.submit('different','task','a'*32)
        with self.assertRaises(ValueError):self.broker.submit('test','root')
    def test_legacy_restart_alias_targets_only_current_transport(self):
        with patch.object(harness,'transport_mode',return_value='snowluma'),patch.object(harness.threading,'Thread'):
            result=self.broker.restart('napcat-qq')
            self.assertEqual(result['service'],'qq-cloud-transport')
            with self.assertRaises(ValueError):self.broker.restart('qq-cloud-transport')
    def test_transport_maintenance_prevents_client_restart(self):
        for mode in ['official_qq_trial','unknown']:
            with patch.object(harness,'transport_mode',return_value=mode):
                for service in ['napcat-qq','qq-cloud-transport','qq-onebot-bridge']:
                    with self.assertRaises(ValueError):harness.maintenance_service(service)
    def test_delayed_old_request_cannot_restart_new_transport_after_switch(self):
        delayed=[]
        with patch.object(harness,'transport_mode',return_value='napcat'),patch.object(harness.threading,'Thread',side_effect=lambda target,**kwargs:type('Thread',(),{'start':lambda self:delayed.append(target)})()):
            self.broker.restart('napcat-qq')
        with patch.object(harness,'transport_mode',return_value='snowluma'),patch.object(harness.time,'sleep'),patch.object(harness,'command') as run:
            delayed[0]();run.assert_not_called()
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.broker = harness.Broker(self.root, execute=False)

    def test_queue_cancel_and_restart_never_replays(self):
        item = self.broker.submit('write a small report')
        restored = harness.Broker(self.root, execute=False)
        self.assertEqual(restored.get(item['id'])['status'], 'interrupted')
        self.assertEqual(restored.queue.qsize(), 0)
        other = self.broker.submit('other')
        self.assertEqual(self.broker.cancel(other['id'])['status'], 'cancelled')

    def test_input_and_restart_allowlist(self):
        for text in ('', 'x' * 6001, None, 4):
            with self.assertRaises(ValueError):
                self.broker.submit(text)
        for service in ('ssh', 'qq-agent; touch /tmp/owned', '../../bin/sh', None):
            with self.assertRaises(ValueError):
                self.broker.restart(service)

    def test_artifact_paths_and_symlinks(self):
        item = self.broker.submit('test')
        work = self.root / 'jobs' / item['id'] / 'work'
        work.mkdir(parents=True)
        (work / 'ok.txt').write_text('test')
        (work / 'escape').symlink_to(self.root / 'state', target_is_directory=True)
        self.broker.cancel(item['id'])
        self.assertEqual(self.broker.artifact(item['id'], 'ok.txt')['base64'], 'dGVzdA==')
        for name in ('../state', '/etc/passwd', 'escape/' + item['id'] + '.json', ''):
            with self.assertRaises(ValueError):
                self.broker.artifact(item['id'], name)

    def test_sandbox_hides_credentials_and_bounds_jobs(self):
        args = harness.job_command('a' * 12)
        text = '\n'.join(args)
        for required in ('User=qq-harness', 'MemoryMax=512M', 'RuntimeMaxSec=600', 'ProtectSystem=strict',
            '-/var/lib/codex-gateway', '-/var/lib/qq-agent', '-/etc/qq-harness', 'NoNewPrivileges=yes', '--no-mcp'):
            self.assertIn(required, text)
        with self.assertRaises(ValueError):
            harness.job_command('a;evil')

    def test_missing_google_quota_is_unknown_and_invalid_routes_fail_closed(self):
        models = quota_models({'models': {'gemini-3-flash': {'quotaInfo': {}},
            'gemini-3.1-flash-image': {'quotaInfo': {'remainingFraction': 0}}}})
        self.assertIsNone(models[0]['remaining_percent'])
        self.assertEqual(models[1]['remaining_percent'], 0)
        control = Controls()
        for target in ('DIRECT', 'A;whoami', None, '../../etc'):
            with self.assertRaises(ValueError):
                control.switch(target)


if __name__ == '__main__':
    unittest.main()
