"""Offline regression tests for the local gateway restrictions."""
import io,json,os,sys,tempfile,time,unittest,urllib.error
from pathlib import Path
from unittest import mock

HERE=Path(__file__).resolve().parent
sys.path.insert(0,os.environ['WORKBUDDY_RUNTIME'])
import guarded_gateway
import wb_proxy as gateway
import wb_accounts


class GatewayPolicyTest(unittest.TestCase):
    def test_refusal_is_returned_once_without_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            account=wb_accounts.Account({'uid':'local-policy-test','accessToken':'test-only','realm':'cn','expiresAt':time.time()+3600},str(Path(directory)/'test.json'))
            class Pool:
                accounts=[account]
                affinity=type('Affinity',(),{'demote':lambda *args:None})()
                def count_ready(self,*args,**kwargs):return 1
                def pick_for_session(self,*args,**kwargs):return account
                def apply_daily_token_limit(self,*args,**kwargs):return 0
                def apply_daily_credit_limit(self,*args,**kwargs):return 0
                def apply_model_daily_token_limit(self,*args,**kwargs):return 0
                def apply_remaining_weights(self,*args,**kwargs):return {}
            bodies=[]
            def refused(request,**kwargs):
                bodies.append(json.loads(request.data))
                raise urllib.error.HTTPError('https://upstream.invalid',403,'refused',{},io.BytesIO(b'content policy rejected'))
            with mock.patch.object(gateway,'POOL',Pool()),mock.patch.object(gateway,'ACCOUNTS_DIR',directory),mock.patch.object(wb_accounts,'urlopen',refused):
                gateway.PROMPT_DEGRADE.reset()
                with self.assertRaises(gateway.ContentRejected):
                    gateway.open_upstream({'model':'deepseek-v4.1-flash','messages':[{'role':'system','content':'PRESERVE_SYSTEM'},{'role':'user','content':'hello'}]},session_key='test-session',target_realm='cn')
                self.assertEqual(len(bodies),1)
                self.assertEqual(bodies[0]['messages'][0]['content'],'PRESERVE_SYSTEM')
                self.assertFalse(gateway.PROMPT_DEGRADE.active())

    def test_profile_disables_unrequested_activity_and_switching(self):
        guarded_gateway.harden()
        self.assertFalse(gateway.auto_switch_product_enabled())
        self.assertFalse(gateway._free_model_credit_fallback_enabled())
        self.assertFalse(gateway.local_web_tools_enabled())
        self.assertIs(gateway.wb_accounts.CreditsRefresher.start,guarded_gateway.idle)
        self.assertIs(guarded_gateway.wb_scheduler.Scheduler.start,guarded_gateway.idle)
        messages=[{'role':'system','content':'KEEP'}]
        gateway.PROMPT_DEGRADE.trigger()
        self.assertEqual(gateway.apply_prompt_mode(messages),messages)
        gateway.PROMPT_DEGRADE.reset()


if __name__=='__main__':unittest.main()
