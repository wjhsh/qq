import json,unittest
from unittest.mock import patch
from task_diagnostics import classify_failure,progress_event

job='a'*12
def row(message,pid=1):return json.dumps({'_PID':str(pid),'MESSAGE':message})
class DiagnosticsTest(unittest.TestCase):
    def test_success_does_not_query_journal(self):
        with patch('task_diagnostics.subprocess.run') as run:
            self.assertEqual(classify_failure(job,0,[]),{'code':'','message':''});run.assert_not_called()
    def test_authoritative_manager_timeout_is_explained(self):
        result=classify_failure(job,1,[],row('Service reached runtime time limit. Stopping.'))
        self.assertEqual(result['code'],'task_timeout');self.assertIn('10分钟',result['message'])
    def test_process_text_cannot_forge_timeout_or_oom(self):
        result=classify_failure(job,1,[],row("Failed with result 'timeout'",4321))
        self.assertEqual(result['code'],'process_exit')
    def test_oom_and_model_errors_remain_failures(self):
        self.assertEqual(classify_failure(job,1,[],row("Failed with result 'oom-kill'"))['code'],'memory_limit')
        self.assertEqual(classify_failure(job,0,['quota exhausted'],'')['code'],'model_error')
    def test_invalid_id_cannot_reach_journal(self):
        with self.assertRaises(ValueError):classify_failure('../root',1,[],None)
    def test_tool_progress_is_bounded_and_omits_arguments(self):
        event={'type':'tool_execution_start','toolName':'bash','args':{'command':'private content'}}
        self.assertEqual(progress_event(event,'now'),{'tool':'bash','phase':'started','at':'now'})
        self.assertEqual(progress_event({'type':'tool_execution_end','toolName':'bash','isError':True},'then')['phase'],'failed')
        self.assertIsNone(progress_event({'type':'message_end'},'now'))

if __name__=='__main__':unittest.main()
