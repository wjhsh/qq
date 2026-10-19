import copy,unittest
from guardian_policy import decide,auth_result,observe

def healthy():return{'native_reachable':True,'login_ready':True,'phase':'ready','onebot_online':True,'onebot_connected':True,'agent_reachable':True,
  'proxy_local_ready':True,'proxy_outbound_ok':True,'gateway_ready':True,'gateway_error':'','credential_configured':False,'credential_generation':''}
class RecoveryTests(unittest.TestCase):
    def test_transport_trial_never_revives_old_qq_or_calls_credentials(self):
        for mode in ['official_qq_trial','invalid','snowluma_pending']:
            s=healthy();s.update(transport_mode=mode,native_reachable=False,login_ready=False,agent_reachable=False,quick_available=True,credential_configured=True)
            state={}
            for now in range(1000,2000,30):
                state,actions,status=decide(s,state,now)
                self.assertEqual(actions,[]);self.assertTrue(status['auth_recovery_paused'])
                self.assertNotEqual(status['qq'],'online')
    def test_transport_trial_still_repairs_google_proxy(self):
        s=healthy();s.update(transport_mode='official_qq_trial',native_reachable=False,agent_reachable=False,proxy_outbound_ok=False);state={}
        for now in [1000,1030,1060]:state,actions,status=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'proxy_auto','target':''}]);self.assertEqual(status['qq'],'official_qq_trial')
    def test_healthy_has_no_mutation(self):
        state,actions,status=decide(healthy(),{},1000);self.assertEqual(actions,[]);self.assertEqual(status['qq'],'online')
    def test_single_transient_failure_does_not_restart(self):
        s=healthy();s.update(native_reachable=False,proxy_outbound_ok=False,gateway_ready=False)
        self.assertEqual(decide(s,{},1000)[1],[])
    def test_native_api_hang_three_scans_restarts_only_napcat(self):
        s=healthy();s['native_reachable']=False;state={}
        for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'napcat-qq'}])
        self.assertEqual(decide(s,state,1090)[1],[])
    def test_invalid_ticket_without_password_is_human_required_not_restart_loop(self):
        s=healthy();s.update(login_ready=False,phase='waiting_qrcode',quick_available=False)
        state={}
        for now in [1000,1030,1060,2000]:
            state,actions,status=decide(s,state,now);self.assertEqual(actions,[]);self.assertEqual(status['qq'],'credentials_required')
    def test_quick_login_is_tried_before_password(self):
        s=healthy();s.update(login_ready=False,phase='waiting_qrcode',quick_available=True,credential_configured=True,credential_generation='one')
        state,actions,_=decide(s,{},1000);self.assertEqual(actions[0]['kind'],'quick_login')
        state=auth_result(state,'quick_login','invalid_session')
        state,actions,_=decide(s,state,1030);self.assertEqual(actions[0]['kind'],'password_login')
    def test_captcha_and_device_checks_are_never_bypassed_or_retried(self):
        for result in ['captcha_required','device_confirmation_required','password_rejected']:
            s=healthy();s.update(login_ready=False,phase='waiting_qrcode',credential_configured=True,credential_generation='one')
            state,actions,_=decide(s,{},1000);state=auth_result(state,'password_login',result)
            for now in [1030,1600,3000]:
                state,actions,status=decide(s,state,now);self.assertEqual(actions,[]);self.assertEqual(status['qq'],result)
    def test_new_credential_generation_reenables_login(self):
        s=healthy();s.update(login_ready=False,phase='waiting_qrcode',credential_configured=True,credential_generation='new')
        state,actions,_=decide(s,{'credential_generation':'old','auth_blocked':'password_rejected'},1000)
        self.assertEqual(actions[0]['kind'],'password_login')
    def test_qr_scanned_or_initializing_is_not_interrupted(self):
        for phase in ['qrcode_scanned','initializing','reconnecting','generating_qrcode']:
            s=healthy();s.update(login_ready=False,phase=phase,credential_configured=True,credential_generation='one')
            self.assertEqual(decide(s,{},1000)[1],[])
    def test_stuck_login_has_bounded_restart(self):
        s=healthy();s.update(login_ready=False,phase='initializing')
        state,_,_=decide(s,{},1000);state,actions,_=decide(s,state,1400)
        self.assertEqual(actions,[{'kind':'restart','target':'napcat-qq'}]);self.assertEqual(decide(s,state,1430)[1],[])
    def test_onebot_disconnect_restarts_agent_when_qq_online(self):
        s=healthy();s['onebot_connected']=False;state={}
        for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'qq-agent'}])
    def test_adapter_offline_restarts_napcat_when_native_claims_ready(self):
        s=healthy();s['onebot_online']=False;state={}
        for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'napcat-qq'}])
    def test_google_outbound_outage_uses_local_control(self):
        s=healthy();s['proxy_outbound_ok']=False;state={}
        for now in [1000,1030,1060]:state,actions,status=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'proxy_auto','target':''}]);self.assertEqual(status['qq'],'online')
    def test_local_proxy_dead_is_restarted(self):
        s=healthy();s.update(proxy_outbound_ok=False,proxy_local_ready=False);state={}
        for now in [1000,1030,1060]:state,actions,_=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'codex-mihomo'}])
    def test_quota_region_and_auth_errors_do_not_restart_gateway(self):
        for kind in ['quota','region','auth']:
            s=healthy();s.update(gateway_ready=False,gateway_error=kind);state={}
            for now in range(1000,1300,30):
                state,actions,status=decide(s,state,now);self.assertEqual(actions,[]);self.assertEqual(status['gateway'],kind)
    def test_service_repairs_capped_and_persisted_across_scans(self):
        s=healthy();s['native_reachable']=False;state={};attempts=0
        for now in range(1000,4000,30):
            state,actions,_=decide(s,state,now);state=copy.deepcopy(state);attempts+=len(actions)
        self.assertEqual(attempts,3)
    def test_password_network_failure_keeps_backoff_without_challenge_loop(self):
        s=healthy();s.update(login_ready=False,phase='waiting_qrcode',credential_configured=True,credential_generation='one')
        state,_,_=decide(s,{},1000);state=auth_result(state,'password_login','network_error')
        self.assertEqual(decide(s,state,1030)[1],[]);self.assertEqual(decide(s,state,1301)[1][0]['kind'],'password_login')
    def test_maintenance_pause_does_not_mutate_services(self):
        s=healthy();s.update(paused=True,native_reachable=False,proxy_outbound_ok=False)
        self.assertEqual(decide(s,{},1000)[1],[])
    def test_multiple_failures_allow_one_mutation_per_scan(self):
        s=healthy();s.update(native_reachable=False,agent_reachable=False,gateway_ready=False,proxy_outbound_ok=False,proxy_local_ready=False);state={}
        for now in [1000,1030,1060,1090]:
            state,actions,_=decide(s,state,now);self.assertLessEqual(len(actions),1)
    def test_bad_ticket_does_not_clear_any_auth_or_generate_new_guid(self):
        s=healthy();s.update(login_ready=False,phase='waiting_qrcode')
        state,actions,_=decide(s,{},1000);self.assertEqual(actions,[])
        self.assertTrue(all(a.get('target') not in ['ssh','sshd'] for a in actions))
    def test_platform_risk_block_prevents_all_qq_login_or_native_restart_attempts(self):
        s=healthy();s.update(risk_blocked=True,native_reachable=False,login_ready=False,quick_available=True,credential_configured=True,credential_generation='one')
        state={}
        for now in range(1000,2000,30):
            state,actions,status=decide(s,state,now);self.assertEqual(actions,[]);self.assertEqual(status['qq'],'risk_device_blocked')
    def test_risk_block_keeps_proxy_recovery_enabled(self):
        s=healthy();s.update(risk_blocked=True,login_ready=False,proxy_outbound_ok=False);state={}
        for now in [1000,1030,1060]:state,actions,status=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'proxy_auto','target':''}]);self.assertEqual(status['qq'],'risk_device_blocked')
    def test_manual_login_is_reported_online_while_auth_retries_paused(self):
        s=healthy();s['risk_blocked']=True
        state,actions,status=decide(s,{'auth_blocked':'captcha_required'},1000)
        self.assertEqual(status['qq'],'online');self.assertTrue(status['auth_recovery_paused'])
        self.assertEqual(state['auth_blocked'],'');self.assertEqual(actions,[])
    def test_observation_requires_both_native_and_onebot_online(self):
        s=healthy();s.update(risk_blocked=True,onebot_online=False)
        state={}
        for now in [1000,1030,1060]:state,actions,status=decide(s,state,now)
        self.assertEqual(status['qq'],'onebot_disconnected');self.assertEqual(actions,[])
    def test_observation_can_reconnect_agent_without_restarting_qq(self):
        s=healthy();s.update(risk_blocked=True,onebot_connected=False);state={}
        for now in [1000,1030,1060]:state,actions,status=decide(s,state,now)
        self.assertEqual(actions,[{'kind':'restart','target':'qq-agent'}])
    def test_unknown_onebot_probe_is_not_reported_online(self):
        s=healthy();s['onebot_online']=None
        self.assertEqual(decide(s,{},1000)[2]['qq'],'onebot_disconnected')
    def test_new_forced_logout_is_not_mislabeled_as_confirmed_device_risk(self):
        s=healthy();s.update(login_ready=False,forced_offline_hold=True,quick_available=True,credential_configured=True,credential_generation='one')
        state,actions,status=decide(s,{},1000)
        self.assertEqual(status['qq'],'forced_offline_review_required')
        self.assertTrue(status['auth_recovery_paused']);self.assertEqual(actions,[])
    def test_online_duration_survives_state_serialization(self):
        import json
        state,public=observe({}, {'qq':'online'},1000)
        state=json.loads(json.dumps(state));state,public=observe(state,{'qq':'online'},1035)
        self.assertEqual(public['qq_observation']['continuous_online_seconds'],35)
        self.assertEqual(public['qq_observation']['online_seconds'],35)
    def test_disconnect_resets_continuity_and_records_interruption(self):
        state,_=observe({}, {'qq':'online'},1000)
        state,_=observe(state,{'qq':'online'},1060)
        state,public=observe(state,{'qq':'risk_device_blocked'},1090)
        self.assertEqual(public['qq_observation']['continuous_online_seconds'],0)
        self.assertEqual(public['qq_observation']['interruptions'],1)
        state,public=observe(state,{'qq':'online'},1120)
        self.assertEqual(public['qq_observation']['longest_online_seconds'],60)
        self.assertEqual(public['qq_observation']['continuous_online_seconds'],0)
    def test_unobserved_gap_and_clock_reversal_do_not_claim_long_uptime(self):
        for next_time in [1400,999]:
            state,_=observe({}, {'qq':'online'},1000)
            state,public=observe(state,{'qq':'online'},next_time)
            self.assertEqual(public['qq_observation']['continuous_online_seconds'],0)
            self.assertEqual(public['qq_observation']['monitoring_gaps'],1)
            self.assertEqual(public['qq_observation']['observed_seconds'],0)
if __name__=='__main__':unittest.main()
