import configparser,importlib.util,shlex,unittest,tempfile
from unittest.mock import patch
from unittest.mock import Mock
from pathlib import Path
spec=importlib.util.spec_from_file_location('native_client',Path(__file__).with_name('native-client.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BASE='''; preserve baseline exactly
[supervisord]
nodaemon=true
[program:qq]
command=qq --no-sandbox %(ENV_SNOWLUMA_QQ_FLAGS)s
user=snowluma
environment=HOME="/app",DISPLAY="%(ENV_DISPLAY)s"
autostart=true
[program:snowluma]
command=/usr/local/bin/node /app/runtime/index.mjs
autostart=false
'''
class Tests(unittest.TestCase):
    def test_baseline_is_exact_not_a_rebuilt_configuration(self):self.assertEqual(m.profile_config(BASE,'baseline'),BASE)
    def test_compact_only_changes_the_qq_command(self):
        old=m.load_config(BASE);new=m.load_config(m.profile_config(BASE,'compact'))
        for section in old.sections():
            for key,value in old.items(section):
                if (section,key)!=('program:qq','command'):self.assertEqual(new.get(section,key),value)
    def test_compact_keeps_verified_startup_without_experimental_heap_flags(self):
        command=m.load_config(m.profile_config(BASE,'compact')).get('program:qq','command');args=shlex.split(command)
        self.assertEqual(m.profile_config(BASE,'compact'),BASE)
        self.assertFalse(any(a.startswith('--js-flags=') for a in args));self.assertIn('%(ENV_SNOWLUMA_QQ_FLAGS)s',args)
        self.assertEqual(args.count('qq'),1)
    def test_invalid_profiles_and_arbitrary_commands_are_rejected(self):
        for value in ['../compact','compact;reboot',None,'','root']:
            with self.assertRaises(ValueError):m.profile_config(BASE,value)
            with self.assertRaises(ValueError):m.operate(value)
    def test_embedded_metrics_and_window_scripts_compile(self):
        compile(m.METRICS,'metrics','exec');compile(m.WINDOWS,'windows','exec')
    def test_window_selector_never_matches_arbitrary_chat_titles(self):
        import re
        pattern=r'(0x[0-9a-f]+) "(?:QQ|qq)": .*? (\d+)x(\d+)\+'
        self.assertTrue(re.search(pattern,'0x800039 "QQ": ("qq" "QQ") 720x640+280+70'))
        self.assertIsNone(re.search(pattern,'0x4 "Other app": ("other" "Other") 720x640+0+0'))
    def test_status_does_not_create_any_state_or_lock_files(self):
        with tempfile.TemporaryDirectory() as d,patch.object(m,'ROOT',Path(d)/'absent'),patch.object(m,'native') as native,patch.object(m,'metrics',return_value={}):
            native.return_value.capture.return_value={'ready':False}
            self.assertFalse(m.operate('status')['native']['ready']);self.assertFalse((Path(d)/'absent').exists())
    def test_desktop_can_open_even_when_controller_is_unavailable(self):
        with tempfile.TemporaryDirectory() as d,patch.object(m,'ROOT',Path(d)),patch.object(m,'native') as native,patch.object(m,'metrics',return_value={}),patch.object(m,'desktop',return_value={'ok':True}),patch.object(m,'windows',return_value={}):
            native.return_value.capture.side_effect=OSError('offline')
            result=m.operate('desktop-on')
            self.assertEqual(result['phase'],'succeeded');self.assertFalse(result['after_native']['ready'])
    def test_failed_minimize_records_terminal_failure(self):
        with tempfile.TemporaryDirectory() as d,patch.object(m,'ROOT',Path(d)),patch.object(m,'native') as native,patch.object(m,'metrics',return_value={}):
            native.return_value.capture.return_value={'ready':False}
            with self.assertRaises(ValueError):m.operate('minimize')
            self.assertEqual(m.read_state('status.json')['phase'],'failed')
    def test_post_restart_attach_only_targets_the_single_managed_qq(self):
        c=Mock();c.call.side_effect=[{'list':[{'pid':80,'name':'qq','uin':'0','injected':False}]},{'success':True}]
        with patch.object(m,'metrics',return_value={'main_pids':[80]}):self.assertTrue(m.attach_managed_client(c))
        self.assertEqual(c.call.call_args.args,('/processes/80/load',{}))
    def test_unmanaged_other_account_or_ambiguous_process_cannot_attach(self):
        for pids,row in [([80],{'pid':81,'name':'qq','injected':False}),([80,81],{'pid':80,'name':'qq','injected':False}),([80],{'pid':80,'name':'qq','injected':False,'uin':'12345'}),([80],{'pid':80,'name':'qq','injected':False,'account':{'uin':'12345'}})]:
            c=Mock();c.call.return_value={'list':[row]}
            with patch.object(m,'metrics',return_value={'main_pids':pids}):self.assertFalse(m.attach_managed_client(c))
            self.assertEqual(c.call.call_count,1)
    def test_mode_switch_preserves_unrelated_controller_optimization(self):
        current=BASE.replace('command=/usr/local/bin/node /app/runtime/index.mjs','command=/usr/bin/python3 /app/data/config/snowluma-launcher.py')
        for profile in ['compact','baseline']:self.assertEqual(m.profile_config(current,profile,BASE),current)
    def test_restore_only_qq_command_leaves_other_sections_byte_exact(self):
        current=BASE.replace('command=qq --no-sandbox %(ENV_SNOWLUMA_QQ_FLAGS)s','command=qq --old-experimental-flag').replace('autostart=false','autostart=true')
        expected=BASE.replace('autostart=false','autostart=true')
        self.assertEqual(m.profile_config(current,'compact',BASE),expected)
if __name__=='__main__':unittest.main()
