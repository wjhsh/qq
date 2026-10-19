"""Bounded Pi progress and authoritative systemd failure classification."""
import json,re,subprocess

def progress_event(event, stamp):
    kind=event.get('type')
    if kind not in ['tool_execution_start','tool_execution_end']:return None
    return {'tool':str(event.get('toolName',''))[:80],
            'phase':'started' if kind.endswith('_start') else 'failed' if event.get('isError') else 'finished',
            'at':stamp}

def classify_failure(job_id, rc, errors, journal=None):
    if not re.fullmatch(r'[a-f0-9]{12}',job_id):raise ValueError('invalid job id')
    if rc==0 and not errors:return {'code':'','message':''}
    if journal is None:
        try:
            result=subprocess.run(['journalctl','--no-pager','-u','qq-task-'+job_id+'.service',
                '-n','30','-o','json'],capture_output=True,text=True,timeout=5)
            journal=result.stdout if result.returncode==0 else ''
        except (OSError,subprocess.SubprocessError):journal=''
    manager=[]
    for line in journal.splitlines():
        try:row=json.loads(line)
        except (ValueError,TypeError):continue
        if str(row.get('_PID',''))=='1':manager.append(str(row.get('MESSAGE','')))
    joined='\n'.join(manager)
    if 'Service reached runtime time limit' in joined or "Failed with result 'timeout'" in joined:
        return {'code':'task_timeout','message':'任务达到10分钟执行上限，已停止；请查看最后工具进度并缩小任务范围。没有自动重试。'}
    if 'oom-kill' in joined or 'killed by the OOM killer' in joined:
        return {'code':'memory_limit','message':'任务超过内存限制，已停止；请缩小数据量或分批处理。没有自动重试。'}
    detail='\n'.join(errors)[-2000:] if errors else f'进程退出码 {rc}'
    return {'code':'model_error' if errors else 'process_exit','message':detail}
