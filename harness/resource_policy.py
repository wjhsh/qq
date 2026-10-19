"""Cheap host metrics and admission control; never delete data or restart services."""
import math,os,shutil
from pathlib import Path

MIB=1024**2
MIN_AVAILABLE_MIB=640
MIN_DISK_MIB=2048
MAX_MEMORY_FULL_AVG10=1.0

def parse_memory(text):
    values={}
    for line in text.splitlines():
        parts=line.replace(':',' ').split()
        if len(parts)>=2 and parts[1].isdigit():values[parts[0]]=int(parts[1])
    return values

def full_pressure(text):
    for line in text.splitlines():
        parts=line.split()
        if parts and parts[0]=='full':
            for value in parts[1:]:
                if value.startswith('avg10='):
                    try:
                        number=float(value.split('=',1)[1])
                        return number if math.isfinite(number) and number>=0 else None
                    except ValueError:return None
    return None

def read(path):
    try:return Path(path).read_text()
    except OSError:return ''

def slice_status(name):
    base=Path('/sys/fs/cgroup')/name
    result={}
    for filename in ['memory.current','memory.high','memory.max','memory.swap.current','memory.swap.max','cpu.max']:
        value=read(base/filename).strip()
        result[filename]=int(value) if value.isdigit() else (value or None)
    return result

def snapshot(root):
    mem=parse_memory(read('/proc/meminfo'))
    try:disk=shutil.disk_usage(root).free//MIB
    except OSError:disk=None
    try:load=[round(x,2) for x in os.getloadavg()]
    except (OSError,AttributeError):load=[]
    return {'cpu_count':os.cpu_count(),'load':load,'memory_total_mib':mem.get('MemTotal',0)//1024,
        'memory_available_mib':mem['MemAvailable']//1024 if 'MemAvailable' in mem else None,
        'swap_total_mib':mem.get('SwapTotal',0)//1024,'swap_used_mib':(mem.get('SwapTotal',0)-mem.get('SwapFree',0))//1024,
        'memory_full_avg10':full_pressure(read('/proc/pressure/memory')),'disk_free_mib':disk,
        'admission':{'min_available_mib':MIN_AVAILABLE_MIB,'min_disk_free_mib':MIN_DISK_MIB,'max_memory_full_avg10':MAX_MEMORY_FULL_AVG10},
        'task_budget':{'concurrency':1,'memory_max_mib':512,'swap_max_mib':128,'cpu_cores_max':0.75,'slice':slice_status('qqtasks.slice')},
        'projects_budget':{'memory_high_mib':384,'memory_max_mib':512,'swap_max_mib':128,'cpu_cores_max':0.75,'slice':slice_status('projects.slice')}}

def admission_reason(data):
    available=data.get('memory_available_mib');disk=data.get('disk_free_mib');pressure=data.get('memory_full_avg10')
    if available is None or disk is None or pressure is None:return '等待资源：暂时无法读取服务器内存、磁盘或压力指标'
    if disk<MIN_DISK_MIB:return '等待资源：磁盘剩余不足2GiB，请先导出并整理文件'
    if available<MIN_AVAILABLE_MIB:return f'等待资源：可用内存{available}MiB，达到{MIN_AVAILABLE_MIB}MiB后自动开始'
    if pressure>=MAX_MEMORY_FULL_AVG10:return '等待资源：服务器正在换页或回收内存，压力下降后自动开始'
    return ''
