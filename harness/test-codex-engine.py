import unittest
from unittest.mock import patch
import codex_engine,harness
class CodexTest(unittest.TestCase):
 def test_engine_uses_same_limits_and_does_not_pass_google_key(self):
  args=harness.job_command('a'*12,'codex');text='\n'.join(args)
  for value in ['MemoryMax=512M','User=qq-harness','RuntimeMaxSec=600','CODEX_HOME=/workspace/codex','--ignore-user-config','gpt-6.1-sol']:self.assertIn(value,text)
  self.assertNotIn('EnvironmentFile=/etc/qq-harness/model.env',text)
  self.assertIn('codex-auth:/workspace/codex',text)
  with self.assertRaises(ValueError):harness.job_command('a'*12,'other')
 def test_progress_never_exposes_shell_arguments(self):
  event=codex_engine.event({'type':'item.started','item':{'type':'command_execution','command':'private token'}},'now')
  self.assertNotIn('private',str(event));self.assertEqual(event['progress']['phase'],'started')
 def test_final_text_and_failure_are_distinct(self):
  self.assertEqual(codex_engine.event({'type':'item.completed','item':{'type':'agent_message','text':'完成'}},'now')['text'],'完成')
  self.assertIn('error',codex_engine.event({'type':'turn.failed','error':{'message':'auth expired'}},'now'))
 def test_usage_keeps_only_nonnegative_numeric_token_fields(self):
  report=codex_engine.event({'type':'turn.completed','usage':{'input_tokens':123,'cached_input_tokens':45,'output_tokens':67,'total_tokens':-1,'api_key':'private','reasoning_output_tokens':True}},'now')
  self.assertEqual(report,{'usage':{'input_tokens':123,'cached_input_tokens':45,'output_tokens':67}})
 def test_cli_item_error_keeps_diagnostics_without_forcing_a_successful_image_to_fail(self):
  report=codex_engine.event({'type':'item.completed','item':{'type':'error','message':'Temporary tool warning'}},'now')
  self.assertEqual(report,{'diagnostic':'Temporary tool warning'})
if __name__=='__main__':unittest.main()
