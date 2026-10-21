"""Server Codex CLI. Auth stays in a persistent private home, outside task exports."""
import os,subprocess
from pathlib import Path
CLI='/opt/codex-qq/codex/node_modules/.bin/codex'
AUTH=Path('/var/lib/qq-harness/codex-auth')
MODEL='gpt-6.1-sol'

def status():
    installed=Path(CLI).is_file()
    return {'installed':installed,'authenticated':installed and (AUTH/'auth.json').is_file(),
        'model':MODEL,'reasoning_effort':'high','engine':'codex','note':'使用服务器保存的Codex登录，计入该ChatGPT账号额度；与Google聊天额度分开。'}

def arguments(image=False):
    # systemd already limits uid, writable paths, credentials, CPU and memory.
    args = [CLI,'-a','never','exec','--json','--ephemeral','--ignore-user-config','--ignore-rules',
        '--sandbox','danger-full-access','--skip-git-repo-check','--model',MODEL,
        '-c','model_reasoning_effort="high"']
    if image:args += ['-c','features.shell_tool=false','-c','features.multi_agent=false','-c','features.image_generation=true','-c','features.skip_host_skill_discovery=true']
    return args + ['-']

def event(value,at):
    kind=value.get('type');item=value.get('item',{})
    if not isinstance(item,dict):item={}
    if kind=='turn.completed' and isinstance(value.get('usage'),dict):
        # This is the CLI's reported turn usage, not a promise that nested
        # image-model usage or subscription allowance is included.
        keys=('input_tokens','cached_input_tokens','output_tokens','total_tokens','reasoning_output_tokens')
        return {'usage':{k:v for k,v in value['usage'].items() if k in keys and type(v) is int and v>=0}}
    if kind=='item.completed' and item.get('type')=='error':
        # CLI item errors can be nonfatal warnings (a later image can still
        # succeed), but keep the explanation when output is missing.
        return {'diagnostic':str(item.get('message','') or item.get('error',''))[:1000]}
    if kind in ['error','turn.failed']:
        error=value.get('error',{})
        return {'error':str((error.get('message','') if isinstance(error,dict) else error) or value.get('message',''))[:1000] or 'Codex任务失败'}
    if kind=='item.completed' and item.get('type')=='agent_message':return {'text':str(item.get('text',''))[-16000:]}
    if kind in ['item.started','item.completed'] and item.get('type') in ['command_execution','file_change','mcp_tool_call','web_search','image_generation']:
        return {'progress':{'tool':item['type'],'phase':'started' if kind=='item.started' else ('failed' if item.get('status')=='failed' else 'finished'),'at':at}}
    return {}
