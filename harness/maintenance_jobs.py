"""Reviewable source edits. All deployments use a root-owned frozen review snapshot."""
import difflib,hashlib,json,os,re,shutil,stat,subprocess,threading,time
from pathlib import Path

ID=re.compile(r'^[a-f0-9]{12}$')
FOLDERS={'src','ui','skills'}
EXT={'.js','.mjs','.cjs','.json','.html','.css','.md'}
MAX_FILE=512*1024
MAX_TOTAL=8*1024*1024

def sha(data):return hashlib.sha256(data).hexdigest()
def digest(files):return sha(json.dumps({k:sha(v) for k,v in sorted(files.items())},sort_keys=True).encode())
def write_json(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');tmp.chmod(0o600);tmp.replace(path)

def read_file(base,relative):
    """Use directory fds to refuse concurrent symlink replacement in job workspaces."""
    fd=os.open(base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        parts=Path(relative).parts
        if not parts or any(x in {'.','..',''} for x in parts) or Path(relative).is_absolute():raise ValueError('源码路径无效')
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
        file=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        with os.fdopen(file,'rb') as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>MAX_FILE:raise ValueError('源码文件不支持链接或超过512KiB')
            data=stream.read(MAX_FILE+1)
            if len(data)>MAX_FILE:raise ValueError('源码文件超过512KiB')
            data.decode('utf-8');return data
    except (OSError,UnicodeError) as exc:raise ValueError('源码包含不可读取的文件或链接') from exc
    finally:os.close(fd)

def snapshot(base):
    result={};total=0
    for folder in sorted(FOLDERS):
        directory=base/folder
        if directory.is_symlink():raise ValueError('源码目录不支持符号链接')
        if not directory.exists():continue
        for current,dirs,files in os.walk(directory,followlinks=False):
            if any((Path(current)/x).is_symlink() for x in dirs+files):raise ValueError('源码目录不支持符号链接')
            dirs[:]=[x for x in dirs if not x.startswith('.') and x!='node_modules']
            for name in sorted(files):
                if name.startswith('.') or Path(name).suffix not in EXT:continue
                relative=(Path(current)/name).relative_to(base).as_posix()
                data=read_file(base,relative);result[relative]=data;total+=len(data)
                if len(result)>800 or total>MAX_TOTAL:raise ValueError('源码副本超过800文件或8MiB')
    return result

def store(base,files):
    base.mkdir(parents=True,mode=0o700,exist_ok=True)
    for name,data in files.items():
        path=base/name;path.parent.mkdir(parents=True,mode=0o700,exist_ok=True);path.write_bytes(data);path.chmod(0o600)

def default_validate(name,data):
    if Path(name).suffix=='.json':json.loads(data)
    elif Path(name).suffix in {'.js','.mjs','.cjs'}:
        mode='commonjs' if name.endswith('.cjs') else 'module'
        r=subprocess.run(['/usr/sbin/runuser','-u','qq-harness','--','/usr/local/bin/node','--input-type='+mode,'--check'],input=data,capture_output=True,timeout=6)
        if r.returncode:raise ValueError('JS 语法检查失败：'+r.stderr.decode('utf-8','replace')[-900:])

def default_reload():
    subprocess.run(['systemctl','restart','qq-agent'],check=True,capture_output=True,timeout=40)
    import urllib.request
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    token=json.loads(Path('/var/lib/qq-agent/config.json').read_text())['server']['token']
    for _ in range(15):
        try:
            request=urllib.request.Request('http://127.0.0.1:3210/api/status',headers={'x-console-token':token})
            with opener.open(request,timeout=2) as response:state=json.load(response)
            if state.get('onebot',{}).get('connected'):return
        except (OSError,ValueError):pass
        time.sleep(1)
    raise RuntimeError('聊天 Agent 未恢复 OneBot 连接')

class Maintenance:
    def __init__(self,root,source=Path('/opt/codex-qq/QQ-agent'),validate=default_validate,reload=default_reload):
        self.root=root/'maintenance';self.source=source;self.validate=validate;self.reload=reload
        self.root.mkdir(mode=0o700,exist_ok=True);self.root.chmod(0o700);self.lock=threading.Lock()

    def directory(self,job_id):
        if not ID.fullmatch(job_id):raise ValueError('任务编号无效')
        return self.root/job_id

    def prepare(self,job_id,work):
        folder=self.directory(job_id);folder.mkdir(mode=0o700)
        files=snapshot(self.source);store(folder/'baseline',files);store(work/'project',files)
        write_json(folder/'baseline.json',{'revision':digest(files)})
        package=self.source/'package.json'
        if package.is_file() and not package.is_symlink():(work/'project'/'package.json').write_bytes(package.read_bytes())
        return ('这是QQ项目代码维护任务。源码副本在/workspace/work/project。只修改该副本中src、ui、skills的JS、JSON、HTML、CSS或Markdown；不要修改package.json、依赖、配置凭证或系统服务。'
                '此副本不包含生产角色配置、群友称呼或聊天记忆；这些属于QQ设置，不要为此扫描系统或改写角色源码默认值。'
                '你的改动不会自动应用生产。完成后说明改动和验证，等待主人在网页查看差异并应用。\n\n')

    def review(self,job_id,work):
        with self.lock:
            folder=self.directory(job_id)
            if not (folder/'baseline.json').exists():raise ValueError('没有该任务的维护基线')
            meta_path=folder/'deployment.json'
            if meta_path.exists() and json.loads(meta_path.read_text()).get('status') in ['applying','applied','rolling_back']:
                raise ValueError('此任务已进入部署，请查询部署状态或回滚')
            before=snapshot(folder/'baseline');after=snapshot(work/'project')
            changes=[name for name in sorted(set(before)|set(after)) if before.get(name)!=after.get(name)]
            validation=[];valid=True
            if len(changes)>40:valid=False;validation.append('单次最多修改40个源码文件')
            for name in changes[:40]:
                try:
                    if name in after:self.validate(name,after[name])
                except (ValueError,subprocess.SubprocessError) as exc:valid=False;validation.append(name+'：'+str(exc)[:1100])
            live=snapshot(self.source)
            if digest(live)!=digest(before):valid=False;validation.append('生产源码已变化，请基于新版本创建维护任务')
            diff=''.join(''.join(difflib.unified_diff(before.get(name,b'').decode().splitlines(True),after.get(name,b'').decode().splitlines(True),fromfile='before/'+name,tofile='after/'+name)) for name in changes)
            if len(diff.encode())>240*1024:valid=False;diff=diff[:100000]+'\n差异过大，不能直接应用';validation.append('请缩小修改范围')
            key=digest(after)
            if not validation:validation.append('语法与源码基线校验通过；仍需阅读差异，语义行为未自动证明。')
            frozen=folder/'reviews'/key
            if not frozen.exists():store(frozen,after)
            write_json(folder/'review.json',{'review_sha':key,'valid':valid and bool(changes),'changed':changes,'baseline_sha':digest(before)})
            return {'review_sha':key,'can_apply':valid and bool(changes),'changed':changes,'validation':validation,'diff':diff}

    def replace(self,name,data):
        parts=Path(name).parts
        if not parts or parts[0] not in FOLDERS or '..' in parts or Path(name).suffix not in EXT:raise ValueError('部署路径超出源码范围')
        path=self.source
        for part in parts[:-1]:
            path=path/part
            if path.is_symlink() or (path.exists() and not path.is_dir()):raise ValueError('生产目录发生变化')
            path.mkdir(exist_ok=True,mode=0o755)
        target=self.source/name
        if target.is_symlink():raise ValueError('生产文件不能是符号链接')
        if data is None:
            target.unlink(missing_ok=True);return
        import tempfile
        fd,temp=tempfile.mkstemp(prefix='.deploy-',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
            os.chmod(temp,0o644);os.replace(temp,target)
        finally:
            if os.path.exists(temp):os.unlink(temp)

    def apply(self,job_id,review_sha):
        folder=self.directory(job_id)
        with self.lock:
            meta_path=folder/'deployment.json'
            if meta_path.exists():
                existing=json.loads(meta_path.read_text())
                if existing.get('status') in ['applying','applied']:return existing
                raise ValueError('这次任务已有部署记录；需重新创建任务')
            r=json.loads((folder/'review.json').read_text())
            if not r['valid'] or r['review_sha']!=review_sha:raise ValueError('差异版本无效，请重新查看')
            before=snapshot(folder/'baseline');after=snapshot(folder/'reviews'/review_sha)
            if digest(after)!=review_sha or digest(snapshot(self.source))!=r['baseline_sha']:raise ValueError('源码版本冲突，请重新创建维护任务')
            meta={'status':'applying','review_sha':review_sha,'changed':r['changed'],'started':time.time()};write_json(meta_path,meta)
        threading.Thread(target=self._deploy,args=(job_id,before,after,meta),daemon=True).start();return meta

    def _deploy(self,job_id,before,after,meta):
        with self.lock:
            path=self.directory(job_id)/'deployment.json'
            try:
                # Recheck inside the transaction, after any earlier deployment completed.
                if digest(snapshot(self.source))!=digest(before):raise ValueError('生产源码版本冲突')
                for name in meta['changed']:self.replace(name,after.get(name))
                self.reload();meta.update(status='applied',finished=time.time())
            except Exception as exc:
                try:
                    self._restore(before,after,meta['changed']);self.reload()
                    meta.update(status='rolled_back',error=str(exc)[:800])
                except Exception as rollback:meta.update(status='failed',error=str(exc)[:500],rollback_error=str(rollback)[:500])
            write_json(path,meta)

    def _restore(self,before,after,changed):
        live=snapshot(self.source)
        if any(live.get(n) not in [before.get(n),after.get(n)] for n in changed):raise ValueError('源码再次变化，未覆盖其他修改')
        for name in changed:self.replace(name,before.get(name))

    def rollback(self,job_id):
        folder=self.directory(job_id);path=folder/'deployment.json'
        with self.lock:
            meta=json.loads(path.read_text())
            if meta['status']=='rolled_back':return meta
            if meta['status'] not in ['applied','failed']:raise ValueError('当前部署状态不支持回滚')
            before=snapshot(folder/'baseline');after=snapshot(folder/'reviews'/meta['review_sha'])
            live=snapshot(self.source)
            if any(live.get(n) not in [before.get(n),after.get(n)] for n in meta['changed']):raise ValueError('源码再次变化，不能覆盖其他修改')
            meta['status']='rolling_back';write_json(path,meta)
        threading.Thread(target=self._rollback,args=(job_id,before,after,meta),daemon=True).start();return meta

    def _rollback(self,job_id,before,after,meta):
        with self.lock:
            try:self._restore(before,after,meta['changed']);self.reload();meta.update(status='rolled_back',finished=time.time())
            except Exception as exc:meta.update(status='failed',rollback_error=str(exc)[:800])
            write_json(self.directory(job_id)/'deployment.json',meta)

    def state(self,job_id):
        path=self.directory(job_id)/'deployment.json'
        return json.loads(path.read_text()) if path.exists() else None

    def recover(self):
        # A killed broker must restore an incomplete transaction before taking new work.
        for path in self.root.glob('*/deployment.json'):
            meta=json.loads(path.read_text())
            if meta.get('status') not in ['applying','rolling_back']:continue
            folder=path.parent
            self._rollback(folder.name,snapshot(folder/'baseline'),snapshot(folder/'reviews'/meta['review_sha']),meta)
