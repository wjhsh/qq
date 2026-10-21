"""Small authenticated loopback broker; Pi jobs run as a separate sandboxed uid."""
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import stat
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from cloud_controls import Controls
from maintenance_jobs import Maintenance
from qq_client_control import QQMaintenance
from resource_policy import snapshot as resource_snapshot, admission_reason
from task_diagnostics import classify_failure, progress_event
import maintenance_context
import codex_engine
import image_jobs
import image_inputs
import image_admission
import pi_channels
from chat_sessions import ChatSessions
from runtime_settings import RuntimeSettings

ROOT = Path('/var/lib/qq-harness')
SERVICES = ('qq-agent', 'napcat-qq', 'qq-cloud-transport', 'qq-onebot-bridge', 'codex-gateway', 'codex-mihomo')
ID = re.compile(r'^[a-f0-9]{12}$')
TERMINAL = {'succeeded', 'failed', 'cancelled', 'interrupted'}
MODEL = 'gemini-3.8-flash-high'
PI = '/opt/codex-qq/pi/node_modules/.bin/pi'
CHAT_IMAGE_WORKER = Path(__file__).with_name('chat_image.py')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def transport_mode():
    try:return json.loads(Path('/etc/qq-guardian/transport.json').read_text()).get('mode','napcat')
    except FileNotFoundError:return 'napcat'
    except (OSError,ValueError,TypeError):return 'unknown'


def maintenance_service(service):
    if service not in SERVICES:raise ValueError('服务名不在维护清单内')
    mode=transport_mode()
    if service in ['napcat-qq','qq-cloud-transport','qq-onebot-bridge']:
        if mode=='snowluma':return 'qq-cloud-transport' if service=='napcat-qq' else service
        if mode!='napcat' or service!='napcat-qq':raise ValueError('接入层正在维护或不支持该服务')
    return service


def atomic(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.chmod(temp, 0o600)
    temp.replace(path)


def command(args, timeout=12):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def job_command(job_id, engine='pi', mode='task'):
    if engine=='codex' and mode=='image':raise ValueError('Codex原生生图已由主人关闭，请使用Chat生图。')
    if engine not in [*pi_channels.PI_ENGINES,'codex','chatgpt']:raise ValueError('Unknown engine')
    if not ID.fullmatch(job_id):
        raise ValueError('invalid job id')
    props = {
        'User': 'qq-harness', 'Group': 'qq-harness', 'WorkingDirectory': '/workspace/work',
        'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'PrivateTmp': 'yes', 'PrivateDevices': 'yes',
        'NoNewPrivileges': 'yes', 'ProtectKernelTunables': 'yes', 'ProtectKernelModules': 'yes',
        'ProtectControlGroups': 'yes', 'RestrictSUIDSGID': 'yes', 'CapabilityBoundingSet': '',
        'RestrictAddressFamilies': 'AF_UNIX AF_INET AF_INET6', 'UMask': '0077',
        'MemoryHigh': '384M', 'MemoryMax': '512M', 'CPUQuota': '75%', 'TasksMax': '48',
        'Slice': 'qqtasks.slice', 'CPUWeight': '20', 'IOWeight': '20', 'Nice': '10',
        'MemorySwapMax': '128M', 'OOMScoreAdjust': '500', 'OOMPolicy': 'kill',
        'RuntimeMaxSec': '600', 'LimitFSIZE': '52428800', 'LimitNOFILE': '1024',
        'BindPaths': f'{ROOT}/jobs/{job_id}:/workspace',
        'ProtectProc': 'invisible',
        'ReadWritePaths': '/workspace',
        'InaccessiblePaths': '-/etc/qq-harness -/etc/codex-gateway -/etc/codex-mihomo '
            '-/var/lib/codex-gateway -/var/lib/codex-mihomo -/var/lib/qq-agent '
            '-/opt/codex-qq/QQ-agent -/opt/codex-qq/cliproxy -/run/systemd/private -/run/dbus/system_bus_socket '
            '-/var/lib/qq-workbuddy -/etc/qq-workbuddy -/var/lib/qq-harness/codex-auth -/opt/codex-qq/snowluma-trial -/etc/qq-guardian -/run/docker.sock -/var/run/docker.sock',
        'EnvironmentFile': '/etc/qq-harness/model.env',
        'Environment': 'HOME=/workspace/home PI_CODING_AGENT_DIR=/workspace/pi PI_OFFLINE=1 PI_TELEMETRY=0 '
            'NODE_OPTIONS=--max-old-space-size=256 HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 '
            'NO_PROXY=127.0.0.1,localhost',
    }
    if engine in pi_channels.PI_ENGINES:
        props['EnvironmentFile']=pi_channels.profile(engine,MODEL)['envFile']
    if engine=='codex':
        props.pop('EnvironmentFile',None)
        props['BindPaths']+=' '+str(codex_engine.AUTH)+':/workspace/codex'
        props['Environment']+=' CODEX_HOME=/workspace/codex'
    if engine=='chatgpt':
        if mode!='image':raise ValueError('Chat only supports image jobs')
        props.pop('EnvironmentFile',None)
        props['BindReadOnlyPaths']=str(codex_engine.AUTH)+':/workspace/codex'
        props['Environment']+=' CODEX_HOME=/workspace/codex'
    if mode=='image':props['RuntimeMaxSec']='240'
    args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', f'--unit=qq-task-{job_id}']
    for key, value in props.items():
        args += ['--property', f'{key}={value}']
    if engine=='codex':return args+codex_engine.arguments(image=mode=='image')
    if engine=='chatgpt':return args+['/usr/bin/python3','-B',str(CHAT_IMAGE_WORKER),'--prompt-file','/workspace/request.txt','--image-dir','/workspace/chat-output/generated_images','--session-file','/workspace/chat-session.json','--input-manifest','/workspace/image-inputs.json']
    return args + [PI, '--mode', 'json', '--no-session', '--no-extensions', '--no-mcp',
        '--extension', '/opt/codex-qq/harness/pi-task-guard.mjs',
        '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
        '--offline', '--tools', 'read,bash,edit,write,grep,find,ls', '--provider', pi_channels.profile(engine,MODEL)['provider'], '--model', pi_channels.profile(engine,MODEL)['model'],
        '--thinking', 'off', '--append-system-prompt',
        '你是通过QQ接单的文件与编程助手。工作目录是/workspace/work。只在此目录保存交付文件。'
        '你没有服务器管理权限，不要索取或读取账号凭证、不要修改聊天角色或系统服务。'
        '按工作区实际提供的任务类型和资料执行。源码维护只改源码副本；若提供group-settings-context.json和群设置方案格式，则据此生成方案，不能直接修改真实服务器。缺少必要资料时说明，不搜索真实服务器或绕过权限。'
        'bash命令默认60秒、最长120秒。避免后台常驻、无限循环和扫描整个文件系统；工作区缺少必要资料时直接说明，不反复执行相同失败操作。'
        '不要向QQ、邮箱或其他人发送消息。不要安装常驻服务。任务最多10分钟；完成后用中文简要说明结果和文件名。',
        '-p', '@/workspace/request.txt']


class Broker:
    def __init__(self, root=ROOT, execute=True):
        self.root = root
        self.lock = threading.RLock()
        self.items = {}
        self.queue = queue.Queue(maxsize=10)
        self.cooldowns = {}
        self.capacity_changed = threading.Event()
        self.controls = Controls()
        self.maintenance = Maintenance(root)
        self.settings = RuntimeSettings(root)
        self.chat_sessions = ChatSessions(root/'chat-sessions',codex_engine.AUTH/'auth.json')
        self.qq_client = QQMaintenance(root)
        if execute:self.maintenance.recover()
        for name in ('state', 'jobs'):
            (root / name).mkdir(parents=True, exist_ok=True)
        for path in (root / 'state').glob('*.json'):
            item = json.loads(path.read_text())
            if item['status'] not in TERMINAL:
                item.update(status='interrupted', finished=now(), error='服务重启，任务没有自动重放；请检查结果后再提交。')
                atomic(path, item)
                if execute:
                    command(['systemctl', 'stop', f'qq-task-{item["id"]}.service'])
            self.items[item['id']] = item
        if execute:
            threading.Thread(target=self.worker, daemon=True).start()

    def save(self, item):
        atomic(self.root / 'state' / f'{item["id"]}.json', item)

    def submit(self, prompt, mode='task', request_id=None, engine='pi', image_session_key=None, input_images=None):
        if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 6000:
            raise ValueError('任务内容需为1至6000字')
        if mode == 'image':
            image_admission.require_image_prompt(prompt)
        if engine not in [*pi_channels.PI_ENGINES,'codex','chatgpt']:raise ValueError('执行引擎无效')
        if engine=='codex' and mode=='image':raise ValueError('Codex原生生图已由主人关闭，请使用Chat生图。')
        if engine in ['codex','chatgpt'] and not codex_engine.status()['authenticated']:raise ValueError('服务器Chat授权尚未就绪')
        if engine=='chatgpt' and mode!='image':raise ValueError('Chat只支持独立生图任务')
        if mode not in ['task','maintenance','settings','diagnostics','image']:raise ValueError('任务类型无效')
        if mode=='image' and (engine not in ['codex','chatgpt'] or len(prompt.strip())>2200):raise ValueError('生图仅支持Chat/Codex和最多2200字描述')
        if request_id is not None and (not isinstance(request_id,str) or not re.fullmatch(r'[a-f0-9]{32}',request_id)):raise ValueError('请求编号无效')
        if image_session_key is not None and (engine!='chatgpt' or mode!='image' or not isinstance(image_session_key,str) or not re.fullmatch(r'[a-f0-9]{32}',image_session_key)):raise ValueError('生图会话标识无效')
        if input_images and (engine!='chatgpt' or mode!='image'):raise image_inputs.ImageInputError('参考图片仅用于Chat生图任务')
        inputs=image_inputs.decode_inputs(input_images)
        input_meta=[{'file':f'input-{i}'+row['ext'],**{k:row[k] for k in ('mime','width','height','bytes','sha256')}} for i,row in enumerate(inputs)]
        with self.lock:
            if request_id:
                prior=next((x for x in self.items.values() if x.get('request_id')==request_id),None)
                if prior:
                    if prior['prompt']!=prompt.strip() or prior.get('mode','task')!=mode or prior.get('engine','pi')!=engine or prior.get('image_session_key')!=image_session_key or prior.get('image_inputs',[])!=input_meta:raise ValueError('请求编号内容冲突')
                    return dict(prior)
            if self.queue.full():
                raise ValueError('队列已满，请先查询或取消任务')
            if shutil.disk_usage(self.root).free < 2 * 1024**3:
                raise ValueError('服务器磁盘剩余不足2GiB，请先整理任务文件')
            item = {'id': secrets.token_hex(6), 'status': 'queued', 'prompt': prompt.strip(),
                'created': now(), 'engine':engine, 'model': 'chatgpt-chat-image' if engine=='chatgpt' else codex_engine.MODEL if engine=='codex' else pi_channels.profile(engine,MODEL)['model'], 'result': '', 'files': [], 'mode': mode, 'request_id':request_id}
            if image_session_key:item['image_session_key']=image_session_key
            if inputs:
                staging=self.root/'input-staging'/item['id'];staging.mkdir(parents=True,mode=0o700)
                for row,meta in zip(inputs,input_meta):
                    target=staging/meta['file'];target.write_bytes(row['buffer']);target.chmod(0o600)
                item['image_inputs']=input_meta
            self.items[item['id']] = item
            self.save(item)
            self.queue.put_nowait(item['id'])
            return dict(item)

    def get(self, job_id):
        with self.lock:
            if not ID.fullmatch(job_id) or job_id not in self.items:
                raise ValueError('任务编号不存在')
            result=dict(self.items[job_id])
            if result.get('mode') in ['maintenance','settings']:result['deployment']=(self.settings if result['mode']=='settings' else self.maintenance).state(job_id)
            return result

    def changes(self,job_id):
        item=self.get(job_id)
        if item.get('mode') not in ['maintenance','settings'] or item['status'] not in TERMINAL:raise ValueError('请等待维护任务结束后查看差异')
        return (self.settings if item['mode']=='settings' else self.maintenance).review(job_id,self.root/'jobs'/job_id/'work')

    def apply(self,job_id,review_sha):
        item=self.get(job_id)
        if item.get('mode') not in ['maintenance','settings'] or item['status'] not in TERMINAL:raise ValueError('请等待维护任务结束')
        return (self.settings if item['mode']=='settings' else self.maintenance).apply(job_id,review_sha)

    def cancel(self, job_id):
        with self.lock:
            item = self.items[self.get(job_id)['id']]
            if item['status'] in TERMINAL:
                return dict(item)
            running = item['status'] == 'running'
            item.update(status='cancelled', finished=now(), error='主人取消了任务')
            self.save(item)
        self.capacity_changed.set()
        if running:
            command(['systemctl', 'stop', f'qq-task-{job_id}.service'])
        return self.get(job_id)

    def guard(self, item, done):
        # Recheck cancellation after unit creation, including the short systemd-run race.
        while not done.wait(2):
            try:
                size = count = 0
                for current, directories, files in os.walk(self.root / 'jobs' / item['id'], followlinks=False):
                    directories[:] = [d for d in directories if not (Path(current) / d).is_symlink()]
                    count += len(directories) + len(files)
                    for name in files:
                        path = Path(current) / name
                        if not path.is_symlink():
                            size += path.stat().st_size
                    if size > 128 * 1024**2 or count > 4000:
                        break
                with self.lock:
                    cancelled = item['status'] == 'cancelled'
                    if size > 128 * 1024**2 or count > 4000:
                        item['limit_error'] = '任务工作区超过128MiB或4000文件上限'
                        self.save(item)
                if cancelled or item.get('limit_error'):
                    command(['systemctl', 'stop', f'qq-task-{item["id"]}.service'])
            except (OSError, subprocess.SubprocessError):
                pass

    def prepare(self, item):
        job = self.root / 'jobs' / item['id']
        job.mkdir(mode=0o700)
        for name in ('work', 'home', 'pi'):
            (job / name).mkdir(mode=0o700)
        prefix=self.maintenance.prepare(item['id'],job/'work') if item.get('mode')=='maintenance' else self.settings.prepare(item['id'],job/'work') if item.get('mode')=='settings' else ''
        if item.get('mode') in ['diagnostics','maintenance']:
            prefix=maintenance_context.prepare(job/'work',self.root)+prefix
        image_source=codex_engine.AUTH
        if item.get('engine')=='chatgpt':
            image_source=job/'chat-output';image_source.mkdir(mode=0o700)
        request_text=image_jobs.prepare(job,item['prompt'],image_source) if item.get('mode')=='image' else ('你在华为云QQ项目的独立任务环境。只在/workspace/work保存交付文件。可按任务研究公开资料、编程和生成文档；目录为空不代表必须停止。诊断与维护先阅读提供的维护说明和快照。不可直接访问生产配置、QQ凭证或系统管理；源码仅修改副本。不要发消息或启动常驻程序。受512MiB内存、128MiB/4000文件、10分钟限制，不安装大型环境。中文说明结果、依据和验证，缺少关键条件才指出具体缺项。\n' if item.get('engine')=='codex' else '')+prefix+item['prompt']
        if item.get('engine')=='chatgpt':
            request_text=item['prompt']
            self.chat_sessions.checkout(job,item.get('image_session_key'))
            rows=item.get('image_inputs',[])
            if rows:
                target_dir=job/'image-inputs';target_dir.mkdir(mode=0o700)
                for row in rows:
                    source=self.root/'input-staging'/item['id']/row['file']
                    if source.is_symlink() or source.stat().st_size!=row['bytes']:raise image_inputs.ImageInputError('参考图片文件校验失败')
                    os.replace(source,target_dir/row['file'])
                (self.root/'input-staging'/item['id']).rmdir()
            (job/'image-inputs.json').write_text(json.dumps(rows))
        (job / 'request.txt').write_text(request_text, encoding='utf-8')
        if item.get('engine','pi') in pi_channels.PI_ENGINES:
            (job / 'pi' / 'models.json').write_text(json.dumps(pi_channels.models(item.get('engine','pi'),MODEL)),encoding='utf-8')
        (job / 'pi' / 'settings.json').write_text(json.dumps({'quietStartup': True, 'retry': {'enabled': False}}))
        shutil.chown(job, user='qq-harness', group='qq-harness')
        for path in job.rglob('*'):
            shutil.chown(path, user='qq-harness', group='qq-harness')
            path.chmod(0o700 if path.is_dir() else 0o600)

    def wait_capacity(self,item):
        while True:
            reason=admission_reason(resource_snapshot(self.root))
            with self.lock:
                if item['status']=='cancelled':return False
                if reason!=item.get('waiting_reason',''):
                    item['waiting_reason']=reason;item['updated']=now();self.save(item)
                if not reason:return True
            self.capacity_changed.wait(10)
            self.capacity_changed.clear()

    def worker(self):
        while True:
            job_id = self.queue.get()
            with self.lock:
                item = self.items[job_id]
                if item['status'] == 'cancelled':
                    self.queue.task_done()
                    continue
            if not self.wait_capacity(item):
                self.queue.task_done()
                continue
            with self.lock:
                if item['status']=='cancelled':
                    self.queue.task_done()
                    continue
                item.update(status='running', started=now())
                self.save(item)
            try:
                done = threading.Event()
                self.prepare(item)
                with self.lock:
                    # Cancellation and process creation are serialized to avoid an orphan task.
                    if item['status'] == 'cancelled':
                        continue
                    process = subprocess.Popen(job_command(job_id,item.get('engine','pi'),item.get('mode','task')), stdin=subprocess.PIPE if item.get('engine')=='codex' else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    if item.get('engine')=='codex':
                        process.stdin.write((self.root/'jobs'/job_id/'request.txt').read_bytes());process.stdin.close()
                threading.Thread(target=self.guard, args=(item, done), daemon=True).start()
                total = 0
                last_text = ''
                errors = []
                diagnostics = []
                for raw in iter(lambda: process.stdout.readline(1048576), b''):
                    total += len(raw)
                    if total > 4 * 1024 * 1024:
                        command(['systemctl', 'stop', f'qq-task-{job_id}.service'])
                        raise ValueError('任务输出超出4MiB限制，已停止')
                    line = raw.decode('utf-8', 'replace')
                    try:
                        event = json.loads(line)
                    except ValueError:
                        diagnostics.append(line[:1000])
                        diagnostics = diagnostics[-4:]
                        continue
                    if not isinstance(event, dict):
                        diagnostics = (diagnostics + [line[:1000]])[-4:]
                        continue
                    if item.get('engine') in ['codex','chatgpt']:
                        parsed=codex_engine.event(event,now())
                        if item.get('engine')=='chatgpt' and event.get('type')=='image.metadata':
                            metadata=event.get('metadata',{})
                            item['chat_image_metadata']={k:metadata.get(k) for k in ('channel','transport','codex_executions','prepare_permit_received','chat_model','requirements','quota_before','quota_after','generation_submissions','session_reused','prompt_sha256','input_image_count','input_sha256')} if isinstance(metadata,dict) else {}
                        if item.get('engine')=='chatgpt' and event.get('type')=='image.progress':
                            phase=str(event.get('phase',''))
                            if phase in ('checking_quota','uploading','preparing','generating','collecting','downloading','finished','failed'):
                                parsed['progress']={'tool':'chat_image/'+phase,'phase':'failed' if phase=='failed' else 'finished' if phase=='finished' else 'started','at':now()}
                        if item.get('engine')=='chatgpt' and event.get('type')=='turn.failed' and isinstance(event.get('error'),dict) and event['error'].get('code') in ('verification_required','auth','quota','timeout','no_image','blocked','busy','conversation_pending','reference_image'):
                            item['chat_error_code']=event['error']['code']
                        label=str(event.get('type',''))
                        if re.fullmatch(r'[a-z_.]{1,60}',label):
                            counts=item.setdefault('event_types',{})
                            if label in counts or len(counts)<30:counts[label]=counts.get(label,0)+1
                        if parsed.get('usage') is not None:
                            item['codex_usage']=parsed['usage'];item['usage_scope']='codex_turn_reported'
                        if parsed.get('diagnostic'):
                            diagnostics=(diagnostics+[parsed['diagnostic']])[-4:]
                        if parsed.get('text'):last_text=parsed['text']
                        if parsed.get('error'):errors.append(parsed['error'])
                        if parsed.get('progress'):
                            with self.lock:
                                item['last_tool']=parsed['progress']['tool'];item['last_tool_phase']=parsed['progress']['phase']
                                item['tool_progress']=(item.get('tool_progress',[])+[parsed['progress']])[-24:];item['updated']=now();self.save(item)
                        continue
                    if event.get('type') == 'message_end':
                        msg = event.get('message', {})
                        if msg.get('role') == 'assistant':
                            text = '\n'.join(x.get('text', '') for x in msg.get('content', []) if x.get('type') == 'text')
                            if text:
                                last_text = text[-16000:]
                            if msg.get('errorMessage'):
                                errors.append(str(msg['errorMessage'])[:1000])
                    elif event.get('type') in ('tool_execution_start', 'tool_execution_end'):
                        with self.lock:
                            item['last_tool'] = str(event.get('toolName', ''))[:80]
                            progress = progress_event(event, now())
                            item['tool_progress'] = (item.get('tool_progress', []) + [progress])[-24:]
                            item['last_tool_phase'] = progress['phase']
                            item['updated'] = now()
                            self.save(item)
                rc = process.wait(timeout=20)
                if item.get('limit_error'):
                    errors.append(item['limit_error'])
                # Keep the model's explanation and reported usage even if
                # image collection fails afterwards. Never retain image data
                # or raw tool arguments in diagnostic metadata.
                item.update(result=last_text,diagnostics=diagnostics,process_exit_code=rc)
                if item.get('mode')=='image' and rc==0 and not errors:
                    image_source=self.root/'jobs'/job_id/'chat-output' if item.get('engine')=='chatgpt' else codex_engine.AUTH
                    item['image_output']=image_jobs.collect(self.root/'jobs'/job_id,image_source)
                    if item.get('engine')=='chatgpt':item['image_output'].update(model='chatgpt-chat-image',channel='chatgpt_chat')
                if not last_text and rc == 0 and not errors:
                    errors.append('模型未返回最终文本；请查看工具进度和已生成文件。')
                failure = classify_failure(job_id, rc, errors)
                if item.get('chat_error_code'):failure['code']=item['chat_error_code']
                files = self.files(job_id)
                with self.lock:
                    if item['status'] != 'cancelled':
                        item.update(status='succeeded' if rc == 0 and last_text and not errors else 'failed',
                            result=last_text, error=failure['message'], error_code=failure['code'], diagnostics=diagnostics,
                            files=files, finished=now())
                        self.save(item)
            except Exception as exc:
                with self.lock:
                    if item['status'] != 'cancelled':
                        item.update(status='failed', error=str(exc)[:1500], error_code=getattr(exc,'code','task_error'), finished=now())
                        self.save(item)
            finally:
                if 'done' in locals():
                    done.set()
                if item.get('engine')=='chatgpt' and item.get('image_session_key'):
                    try:
                        saved=self.chat_sessions.commit(self.root/'jobs'/job_id,item['image_session_key'])
                        if saved:
                            with self.lock:item['chat_session_saved']=True;self.save(item)
                    except Exception:
                        # Session bookkeeping must never discard a completed
                        # image or initiate a second generation.
                        with self.lock:item['chat_session_save_error']=True;self.save(item)
                self.queue.task_done()

    def files(self, job_id):
        base = self.root / 'jobs' / job_id / 'work'
        result = []
        # Never follow symlinks created by an agent.
        for current, directories, files in os.walk(base, followlinks=False):
            directories[:] = [d for d in directories if not (Path(current) / d).is_symlink()]
            for name in files:
                path = Path(current) / name
                if not path.is_symlink() and path.is_file():
                    result.append({'name': str(path.relative_to(base)), 'bytes': path.stat().st_size})
                    if len(result) >= 100:
                        return result
        return result

    def artifact(self, job_id, name):
        item=self.get(job_id)
        if item['status'] not in TERMINAL:
            raise ValueError('请等待任务结束后再取文件')
        base = self.root / 'jobs' / job_id / 'work'
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:
            raise ValueError('文件名无效')
        limit=image_jobs.MAX_IMAGE_BYTES if item.get('mode')=='image' and name==image_jobs.OUTPUT_NAME else 2*1024*1024
        # Open every component without following symlinks, including concurrent replacements.
        directory = None
        file = None
        try:
            directory = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            for part in relative.parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            file = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            info = os.fstat(file)
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise ValueError('文件不存在或超过下载大小限制')
            with os.fdopen(file, 'rb') as stream:
                file = None
                data = stream.read(limit + 1)
            if len(data) > limit:
                raise ValueError('文件超过下载大小限制')
        except OSError as exc:
            raise ValueError('文件不可读取；不支持符号链接') from exc
        finally:
            if file is not None:
                os.close(file)
            if directory is not None:
                os.close(directory)
        import base64
        return {'name': relative.name, 'base64': base64.b64encode(data).decode()}

    def status(self):
        rows = {}
        active=('qq-agent','qq-cloud-transport','qq-onebot-bridge','codex-gateway','codex-mihomo') if transport_mode()=='snowluma' else ('qq-agent','napcat-qq','codex-gateway','codex-mihomo')
        for name in active + ('qq-harness',):
            result = command(['systemctl', 'show', name, '--property=ActiveState,SubState,MemoryCurrent,NRestarts'])
            rows[name] = dict(x.split('=', 1) for x in result.stdout.splitlines() if '=' in x)
        memory = dict(x.split(':', 1) for x in Path('/proc/meminfo').read_text().splitlines() if ':' in x)
        disk = shutil.disk_usage(self.root)
        resources=resource_snapshot(self.root)
        with self.lock:
            queued=sum(x['status']=='queued' for x in self.items.values())
            running=sum(x['status']=='running' for x in self.items.values())
            waiting=sum(x['status']=='queued' and bool(x.get('waiting_reason')) for x in self.items.values())
        return {'services': rows, 'memory_available': memory.get('MemAvailable', '').strip(),
            'disk_free_gib': round(disk.free / 2**30, 2), 'queue': queued, 'running':running,'waiting_resources':waiting,'resources':resources,'model': MODEL,
            'codex':codex_engine.status(),'workbuddy':{'model':pi_channels.WORKBUDDY_MODEL,'configured':Path('/etc/qq-harness/workbuddy.env').exists()},'time': now()}

    def restart(self, service):
        requested=service
        service=maintenance_service(service)
        with self.lock:
            if time.monotonic() - self.cooldowns.get(service, -9999) < 60:
                raise ValueError('同一服务一分钟内只重启一次')
            self.cooldowns[service] = time.monotonic()
        def delayed():
            time.sleep(4)
            try:
                if maintenance_service(requested)!=service:return
            except ValueError:return
            command(['systemctl', 'restart', service], timeout=45)
        threading.Thread(target=delayed, daemon=True).start()
        return {'scheduled': True, 'service': service, 'delay_seconds': 4}


def handler(broker, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, code, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.dispatch('GET')

        def do_POST(self):
            self.dispatch('POST')

        def dispatch(self, method):
            self.connection.settimeout(15)
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                return self.reply(401, {'ok': False, 'error': 'unauthorized'})
            try:
                url = urlsplit(self.path)
                parts = url.path.strip('/').split('/')
                body = {}
                if method == 'POST':
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= (12*1024*1024 if parts==['jobs'] else 32768):
                        raise ValueError('请求体大小无效')
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise ValueError('需要JSON对象')
                if method == 'GET' and parts == ['status']:
                    value = broker.status()
                elif method == 'GET' and parts == ['health']:
                    value = {'ready': True}
                elif method == 'GET' and parts == ['qq', 'client']:
                    value = broker.qq_client.snapshot()
                elif method == 'POST' and parts == ['qq', 'client']:
                    value = broker.qq_client.schedule(body.get('action'))
                elif method == 'GET' and parts == ['quotas']:
                    value = {'traffic': broker.controls.cached('traffic', 300, broker.controls.traffic)} if parse_qs(url.query).get('source') == ['traffic'] else broker.controls.quotas()
                elif method == 'GET' and parts == ['network', 'route']:
                    value = broker.controls.route()
                elif method == 'POST' and parts == ['network', 'route']:
                    value = broker.controls.switch(body.get('target'))
                elif method == 'GET' and parts == ['jobs']:
                    with broker.lock:
                        value = [{k: v for k, v in x.items() if k not in ('prompt', 'result', 'error')}
                            for x in sorted(broker.items.values(), key=lambda x: x['created'], reverse=True)[:20]]
                elif method == 'POST' and parts == ['jobs']:
                    value = broker.submit(body.get('prompt'),body.get('mode','task'),body.get('request_id'),body.get('engine','pi'),body.get('image_session_key'),body.get('input_images'))
                elif len(parts) == 2 and parts[0] == 'jobs' and method == 'GET':
                    value = broker.get(parts[1])
                elif len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'cancel' and method == 'POST':
                    value = broker.cancel(parts[1])
                elif len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'file' and method == 'GET':
                    value = broker.artifact(parts[1], parse_qs(url.query).get('name', [''])[0])
                elif len(parts)==3 and parts[0]=='jobs' and parts[2]=='changes' and method=='GET':
                    value=broker.changes(parts[1])
                elif len(parts)==3 and parts[0]=='jobs' and parts[2]=='apply' and method=='POST':
                    value=broker.apply(parts[1],body.get('review_sha'))
                elif len(parts)==3 and parts[0]=='jobs' and parts[2]=='rollback' and method=='POST':
                    item=broker.get(parts[1])
                    if item.get('mode')!='maintenance':raise ValueError('不是维护任务')
                    value=broker.maintenance.rollback(parts[1])
                elif method == 'POST' and parts == ['maintenance', 'restart']:
                    value = broker.restart(body.get('service'))
                else:
                    return self.reply(404, {'ok': False, 'error': 'not found'})
                self.reply(200, {'ok': True, 'data': value})
            except (ValueError, TypeError, KeyError) as exc:
                self.reply(400, {'ok': False, 'error': str(exc)[:300],**({'code':'reference_image'} if getattr(exc,'code',None)=='reference_image' else {})})
            except Exception:
                self.reply(500, {'ok': False, 'error': '内部操作失败，请检查服务日志'})
    return Handler


if __name__ == '__main__':
    token = Path('/etc/qq-harness/qq-token').read_text().strip()
    server = ThreadingHTTPServer(('127.0.0.1', 3211), handler(Broker(), token))
    server.daemon_threads = True
    server.serve_forever()
