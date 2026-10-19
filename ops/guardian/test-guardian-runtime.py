import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import guardian
REAL_TRANSPORT_MODE=guardian.transport_mode
class Client:
    def __init__(self,result):self.result=result;self.calls=[]
    def call(self,route,body):self.calls.append((route,body));return self.result
class RuntimeTests(unittest.TestCase):
    def test_snowluma_never_receives_qq_password_or_old_client_restart(self):
        client=Client({})
        with patch.object(guardian,'transport_mode',return_value='snowluma'),patch.object(guardian.subprocess,'run') as runner:
            for action in [{'kind':'password_login'},{'kind':'quick_login'},{'kind':'restart','target':'napcat-qq'}]:
                with self.assertRaises(ValueError):guardian.perform(client,action)
            runner.assert_not_called();self.assertEqual(client.calls,[])
    def setUp(self):
        mode=patch.object(guardian,'transport_mode',return_value='napcat');mode.start();self.addCleanup(mode.stop)
    def test_official_trial_probes_do_not_access_old_qq_endpoints(self):
        client=Client({})
        with patch.object(guardian,'transport_mode',return_value='official_qq_trial'),patch.object(guardian,'console') as console,patch.object(guardian,'onebot') as onebot,patch.object(guardian,'proxy_local',return_value=True),patch.object(guardian,'gateway',return_value={'ready':True,'error':''}),patch.object(guardian,'reachable',return_value=True),patch.object(guardian,'credential',return_value=None):
            result=guardian.sample(client)
        self.assertEqual(client.calls,[]);console.assert_not_called();onebot.assert_not_called()
        self.assertTrue(result['proxy_outbound_ok']);self.assertEqual(result['transport_mode'],'official_qq_trial');self.assertFalse(result['login_ready'])
    def test_transport_switch_after_sampling_blocks_stale_qq_actions(self):
        client=Client({})
        with patch.object(guardian,'transport_mode',return_value='official_qq_trial'),patch.object(guardian.subprocess,'run') as runner:
            for action in [{'kind':'password_login'},{'kind':'quick_login'},{'kind':'restart','target':'napcat-qq'},{'kind':'restart','target':'qq-agent'},{'kind':'restart','target':'qq-onebot-bridge'},{'kind':'restart','target':'qq-cloud-transport'},{'kind':'snowluma_attach'}]:
                with self.assertRaises(ValueError):guardian.perform(client,action)
            runner.assert_not_called();self.assertEqual(client.calls,[])
    def test_invalid_transport_configuration_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(guardian,'CONFIG',Path(directory)):
            file=Path(directory)/'transport.json';file.write_text('{')
            self.assertEqual(REAL_TRANSPORT_MODE(),'invalid')
    def test_password_only_sent_to_fixed_local_login_api(self):
        client=Client({'code':0,'data':None})
        with patch.object(guardian,'credential',return_value={'uin':guardian.UIN,'password_md5':'a'*32}):
            self.assertEqual(guardian.perform(client,{'kind':'password_login'}),'accepted')
        self.assertEqual(client.calls,[('/QQLogin/PasswordLogin',{'uin':guardian.UIN,'passwordMd5':'a'*32})])
    def test_captcha_and_new_device_challenges_stored_privately(self):
        for data,expected in [({'needCaptcha':True,'proofWaterUrl':'https://ssl.captcha.qq.com/x'},'captcha_required'),({'needNewDevice':True,'jumpUrl':'https://accounts.qq.com/x'},'device_confirmation_required')]:
            client=Client({'code':0,'data':data});writes=[]
            with patch.object(guardian,'credential',return_value={'password_md5':'b'*32}),patch.object(guardian,'write_json',side_effect=lambda p,v: writes.append((p,v))):
                self.assertEqual(guardian.perform(client,{'kind':'password_login'}),expected)
            self.assertEqual(writes[0][0],guardian.PRIVATE/'challenge.json')
    def test_invalid_session_is_classified_without_reauthenticating_google(self):
        self.assertEqual(guardian.perform(Client({'code':-1,'message':'你的用户身份已失效'}),{'kind':'quick_login'}),'invalid_session')
    def test_wrong_password_stops_repeated_attempts(self):
        with patch.object(guardian,'credential',return_value={'password_md5':'c'*32}):
            self.assertEqual(guardian.perform(Client({'code':-1,'message':'账号或密码错误'}),{'kind':'password_login'}),'password_rejected')
    def test_no_generic_shell_or_ssh_restart_is_available(self):
        with patch.object(guardian.subprocess,'run') as runner:
            for action in [{'kind':'restart','target':'sshd'},{'kind':'restart','target':'qq-agent; reboot'},{'kind':'shell','target':'whoami'}]:
                with self.assertRaises(ValueError):guardian.perform(Client({}),action)
            runner.assert_not_called()
    def test_credential_file_checks_target_account(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(guardian,'CONFIG',Path(directory)):
            guardian.write_json(Path(directory)/'credential.json',{'uin':'other','password_md5':'d'*32})
            self.assertIsNone(guardian.credential())
            self.assertEqual((Path(directory)/'credential.json').stat().st_mode&0o777,0o600)
    def test_readonly_quick_login_handles_string_and_object_accounts(self):
        for accounts in [[guardian.UIN],[{'uin':guardian.UIN}],[{'qq':guardian.UIN}]]:
            class Native:
                def call(self,route):return{'data':{'isLogin':False,'coreReady':False,'loginPhase':'waiting_qrcode'}} if route.endswith('CheckLoginStatus') else {'data':accounts}
            self.assertTrue(guardian.capture_login(Native())['quick'])
    def test_native_kick_diagnostic_is_recognized_with_or_without_account_prefix(self):
        for prefix in ['', '机器人 | ']:
            evidence=json.dumps({'fields':['tipsTitle','tipsDesc','reason'],'values':{'tipsTitle':'下线通知','tipsDesc':'登录已失效','reason':1}})
            row=json.dumps({'__REALTIME_TIMESTAMP':'2000','MESSAGE':'10-18 21:30:00 [warn] '+prefix+'[QQGuardian] KickEvidence '+evidence})
            self.assertEqual(guardian.trusted_kick_time(row,1000),2000)
            self.assertEqual(guardian.trusted_kick_time(row,2000),0)
    def test_quoted_group_messages_cannot_pause_native_login(self):
        evidence=json.dumps({'fields':['tipsTitle','tipsDesc'],'values':{}})
        for message in ['10-18 21:30:00 [info] 机器人 | 接收 <- 群聊 [123] [QQGuardian] KickEvidence '+evidence,
                        '10-18 21:30:00 [warn] [QQGuardian] KickEvidence {}',
                        '[QQGuardian] KickEvidence '+evidence]:
            row=json.dumps({'__REALTIME_TIMESTAMP':'2000','MESSAGE':message})
            self.assertEqual(guardian.trusted_kick_time(row,1000),0)
    def test_new_forced_logout_creates_durable_hold(self):
        evidence=json.dumps({'fields':['tipsTitle','tipsDesc'],'values':{}})
        raw=json.dumps({'__REALTIME_TIMESTAMP':'2000','MESSAGE':'10-18 21:30:00 [warn] [QQGuardian] KickEvidence '+evidence})
        result=type('Result',(),{'stdout':raw,'returncode':0,'stderr':''})()
        with patch.object(guardian.subprocess,'run',return_value=result),patch.object(guardian,'event'):
            state=guardian.watch_kicks({'kick_watch_since_us':1000},3000)
        self.assertTrue(state['forced_offline_hold']);self.assertEqual(state['kick_watch_since_us'],3000)
    def test_missing_new_events_preserves_existing_hold(self):
        result=type('Result',(),{'stdout':'','returncode':0,'stderr':''})()
        with patch.object(guardian.subprocess,'run',return_value=result),patch.object(guardian,'event') as emit:
            state=guardian.watch_kicks({'kick_watch_since_us':1000,'forced_offline_hold':True},3000)
        self.assertTrue(state['forced_offline_hold']);emit.assert_not_called()
    def test_empty_journal_grep_is_a_healthy_watch(self):
        result=type('Result',(),{'stdout':'','returncode':1,'stderr':''})()
        with patch.object(guardian.subprocess,'run',return_value=result),patch.object(guardian,'event') as emit:
            state=guardian.watch_kicks({'kick_watch_since_us':1000},3000)
        self.assertEqual(state['kick_watch_since_us'],3000);emit.assert_not_called()
    def test_incident_capture_does_not_store_group_messages_quoting_native_errors(self):
        raw='\n'.join(json.dumps({'MESSAGE':msg}) for msg in [
          '10-18 21:00:00 [info] 机器人 | 接收 <- 群聊 [123] KickedOffLine 私人消息',
          '10-18 21:00:01 [error] [KickedOffLine] 登录失效'])
        def result_for(command,**kwargs):return type('Result',(),{'stdout':'yes' if command[0]=='timedatectl' else raw})()
        writes=[]
        class Native:
            def call(self,*args):return{'data':{}}
        with tempfile.TemporaryDirectory() as directory,patch.object(guardian,'PRIVATE',Path(directory)),patch.object(guardian.subprocess,'run',side_effect=result_for),patch.object(guardian,'write_json',side_effect=lambda p,v:writes.append(v)):
            guardian.incident(Native(),{})
        self.assertEqual(len(writes[0]['events']),1)
        self.assertNotIn('私人消息',json.dumps(writes))
if __name__=='__main__':unittest.main()
