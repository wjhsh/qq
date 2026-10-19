import unittest
from snowluma_transport import login_observation,UIN
from guardian_policy import decide
from importlib.machinery import SourceFileLoader
from pathlib import Path
healthy=SourceFileLoader('guardian_tests',str(Path(__file__).with_name('test-guardian.py'))).load_module().healthy
class SnowTests(unittest.TestCase):
    def test_cached_account_or_pid_does_not_prove_login(self):
        for row in [{'pid':80,'account':{'uin':UIN}}, {'pid':80,'uin':UIN,'injected':True,'connected':True,'loggedIn':False}]:
            self.assertFalse(login_observation([row])['ready'])
    def test_native_confirmation_requires_exact_identity(self):
        row={'pid':80,'uin':UIN,'injected':True,'connected':True,'loggedIn':True}
        self.assertTrue(login_observation([row])['ready'])
        for key,value in [('uin','other'),('injected',False),('connected',False),('loggedIn',False)]:
            self.assertFalse(login_observation([{**row,key:value}])['ready'])
        self.assertFalse(login_observation([row,row])['ready'])
    def test_unattended_snowluma_recovery_never_uses_napcat_password_api(self):
        s=healthy();s.update(transport_mode='snowluma',login_ready=False,phase='login_required',credential_configured=True,quick_available=True)
        state={}
        for now in range(1000,4000,30):
            state,actions,status=decide(s,state,now)
            self.assertEqual(actions,[]);self.assertEqual(status['qq'],'device_confirmation_required')
    def test_protocol_attach_has_persistent_attempt_limits(self):
        s=healthy();s.update(transport_mode='snowluma',login_ready=False,phase='needs_hook',snowluma_attach_available=True);state={};actions_seen=[]
        for now in range(1000,4000,30):
            state,actions,_=decide(s,state,now);actions_seen+=actions
        self.assertEqual(actions_seen,[{'kind':'snowluma_attach','target':''}]*2)
    def test_native_api_outage_repairs_controller_without_old_client(self):
        s=healthy();s.update(transport_mode='snowluma',native_reachable=False);state={}
        for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'qq-cloud-transport'}])
    def test_container_healthy_host_forward_failed_repairs_only_bridge(self):
        s=healthy();s.update(transport_mode='snowluma',onebot_online=None,onebot_direct_online=True);state={}
        for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'qq-onebot-bridge'}])
    def test_adapter_recovery_and_agent_recovery_are_separate(self):
        for online,expected in [(False,'qq-cloud-transport'),(True,'qq-agent')]:
            s=healthy();s.update(transport_mode='snowluma',onebot_online=online,onebot_connected=False);state={}
            for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
            self.assertEqual(actions,[{'kind':'restart','target':expected}])
    def test_review_hold_also_prevents_new_hook_attempts(self):
        s=healthy();s.update(transport_mode='snowluma',login_ready=False,forced_offline_hold=True,snowluma_attach_available=True);state={}
        for now in range(1000,4000,30):
            state,actions,_=decide(s,state,now);self.assertEqual(actions,[])
if __name__=='__main__':unittest.main()
