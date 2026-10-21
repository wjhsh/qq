import json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import maintenance_context as context,codex_engine
class ContextTest(unittest.TestCase):
 def test_diagnostics_exposes_counts_without_credentials_or_chat_bodies(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);agent=root/'agent';(agent/'sessions').mkdir(parents=True);(root/'state').mkdir()
   (agent/'config.json').write_text(json.dumps({'api':{'apiKey':'SECRET_KEY','model':'gemini-test','preferredRecovery':{'enabled':False,'model':'gemini-3.8-flash-high','endpointKey':'PRIVATE_ENDPOINT'},'requestGuard':{'enabled':True,'minIntervalMs':1500,'maxQueue':8,'rateLimitCooldownMs':120000,'unavailableCooldownMs':60000,'networkCooldownMs':15000,'baseUrls':['https://198.51.100.20/PRIVATE_ROUTE'],'apiKey':'PRIVATE_GUARD_KEY'}},'password':'PRIVATE_PASSWORD','maxConcurrentRuns':2}))
   (agent/'sessions/a.json').write_text(json.dumps({'chatKey':'private:123456789','status':'error','startedAt':1,'endedAt':1001,'sent':[],'error':'HTTP 500 Internal error encountered. SECRET_KEY','systemPrompt':'PRIVATE_PROMPT','triggerText':'PRIVATE_CHAT'}))
   (root/'state/a.json').write_text(json.dumps({'id':'a'*12,'status':'failed','prompt':'PRIVATE_TASK','error_code':'blocked','result':'PRIVATE_RESULT'}))
   mem=root/'meminfo';mem.write_text('MemTotal: 2048000 kB\nMemAvailable: 819200 kB\n')
   log=json.dumps({'MESSAGE':'HTTP 503 auth_unavailable SECRET_KEY PRIVATE_CHAT','__REALTIME_TIMESTAMP':'123'})
   with patch.object(context,'run',return_value=log),patch.object(context,'agent_status',return_value={'qq_connected':True}),patch.object(context,'gateway_egress_status',return_value={'status':'unknown'}):out=context.collect(root,agent,mem)
   text=json.dumps(out)
   for value in ['SECRET_KEY','PRIVATE_PASSWORD','PRIVATE_PROMPT','PRIVATE_CHAT','PRIVATE_TASK','PRIVATE_RESULT','123456789','PRIVATE_ENDPOINT','PRIVATE_GUARD_KEY','198.51.100.20','PRIVATE_ROUTE','baseUrls']:self.assertNotIn(value,text)
   self.assertEqual(out['recent_sessions'][0]['error_category'],'upstream_internal')
   self.assertEqual(out['memory_mib']['MemAvailable'],800)
   self.assertEqual(out['recent_logs']['qq-agent']['event_counts']['provider_unavailable'],1)
   self.assertEqual(out['chat_policy']['preferred_recovery'],{'enabled':False,'model':'gemini-3.8-flash-high'})
   self.assertEqual(out['chat_policy']['request_guard'],{'enabled':True,'minIntervalMs':1500,'maxQueue':8,'rateLimitCooldownMs':120000,'unavailableCooldownMs':60000,'networkCooldownMs':15000})
 def test_policy_rejects_untyped_or_unbounded_values(self):
  out=context.protection_policy({'preferredRecovery':{'enabled':'true','model':'https://PRIVATE_HOST/PRIVATE_KEY'},'requestGuard':{'enabled':1,'minIntervalMs':{'key':'PRIVATE_KEY'},'maxQueue':True,'rateLimitCooldownMs':float('inf'),'unavailableCooldownMs':-1,'networkCooldownMs':999999999}})
  self.assertEqual(out['preferred_recovery'],{'enabled':None,'model':None})
  self.assertTrue(all(value is None for value in out['request_guard'].values()))
 def test_egress_uses_only_fixed_read_only_command_and_whitelisted_booleans(self):
  family={'jump_present':True,'chain_matches':True,'output_jump_first':True,'PRIVATE_KEY':'198.51.100.20'}
  raw={'action':'check','gateway_uid':994,'families':{'4':family,'6':family},'PRIVATE_KEY':'PRIVATE_PASSWORD'}
  with patch.object(context.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps(raw),'PRIVATE_ERROR')) as probe:
   out=context.gateway_egress_status()
  probe.assert_called_once_with(['python3','/opt/codex-qq/ops/gateway-egress-guard.py','check'],capture_output=True,text=True,timeout=8)
  self.assertEqual(out['status'],'verified');self.assertIn('checked_at',out)
  self.assertEqual(set(out['families']),{'ipv4','ipv6'})
  for value in ['PRIVATE','198.51.100.20','gateway_uid']:self.assertNotIn(value,json.dumps(out))
 def test_egress_failed_or_invalid_response_stays_unknown(self):
  valid={'action':'check','families':{str(n):{'jump_present':True,'chain_matches':True,'output_jump_first':True} for n in [4,6]}}
  invalid=[None,[],{'action':'apply','families':valid['families']},{'action':'check','families':{'4':valid['families']['4']}},{'action':'check','families':{'4':{'jump_present':1,'chain_matches':True,'output_jump_first':True},'6':valid['families']['6']}}]
  cases=[subprocess.CompletedProcess([],1,json.dumps(valid),'PRIVATE_ERROR'),subprocess.CompletedProcess([],0,'PRIVATE_BAD_JSON','')]
  cases.extend(subprocess.CompletedProcess([],0,json.dumps(row),'PRIVATE_ERROR') for row in invalid)
  for completed in cases:
   with self.subTest(response=completed.stdout),patch.object(context.subprocess,'run',return_value=completed):out=context.gateway_egress_status()
   self.assertEqual(out['status'],'unknown');self.assertNotIn('families',out);self.assertNotIn('PRIVATE',json.dumps(out))
  for failure in [OSError('PRIVATE_PATH'),subprocess.TimeoutExpired('PRIVATE_COMMAND',8)]:
   with patch.object(context.subprocess,'run',side_effect=failure):out=context.gateway_egress_status()
   self.assertEqual(out['status'],'unknown');self.assertNotIn('PRIVATE',json.dumps(out))
 def test_service_active_does_not_verify_rules(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);mem=root/'meminfo';mem.write_text('')
   with patch.object(context,'run',return_value='ActiveState=active\nSubState=running'),patch.object(context,'agent_status',return_value={'available':False}),patch.object(context.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','PRIVATE_ERROR')):out=context.collect(root,root,mem)
   self.assertEqual(out['services']['codex-gateway']['ActiveState'],'active')
   self.assertEqual(out['gateway_egress_guard']['status'],'unknown')
 def test_partial_or_mismatched_rules_are_not_verified(self):
  raw={'action':'check','families':{str(n):{'jump_present':True,'chain_matches':True,'output_jump_first':n==4} for n in [4,6]}}
  with patch.object(context.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps(raw),'')):out=context.gateway_egress_status()
  self.assertEqual(out['status'],'not_verified')
 def test_guard_messages_are_sanitized_categories(self):
  self.assertEqual(context.category('GOOGLE_REQUEST_GUARD_COOLDOWN PRIVATE_CHAT'),'request_guard')
  self.assertEqual(context.category('Google 网关已保护冷却约 120 秒 PRIVATE_CHAT'),'request_guard')
 def test_high_effort_is_used_with_same_model(self):
  args=codex_engine.arguments();self.assertIn('gpt-6.1-sol',args);self.assertIn('model_reasoning_effort="high"',args)
if __name__=='__main__':unittest.main()
