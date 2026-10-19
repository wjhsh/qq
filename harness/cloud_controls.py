"""Read filtered subscription quotas and control only validated server proxy routes."""
import json
import os
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

GROUP = 'GOOGLE-OUT'
AUTO = 'GOOGLE-AUTO'
PUBLIC_CLIENT_ID = os.environ.get('QQ_GOOGLE_OAUTH_CLIENT_ID', '').strip()
PUBLIC_CLIENT_SECRET = os.environ.get('QQ_GOOGLE_OAUTH_CLIENT_SECRET', '').strip()


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def quota_models(payload):
    models = payload.get('models', {})
    ids = ('gemini-3.8-flash-tiered', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash',
        'gemini-3.1-flash-image', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium')
    result = []
    for name in ids:
        item = models.get(name, {}) if isinstance(models, dict) else {}
        info = item.get('quotaInfo') or {}
        fraction = info.get('remainingFraction')
        percent = round(fraction * 100, 1) if isinstance(fraction, (int, float)) and not isinstance(fraction, bool) and math.isfinite(fraction) and 0 <= fraction <= 1 else None
        if item:
            result.append({'model': name, 'remaining_percent': percent, 'reset_time': str(info.get('resetTime', ''))[:50]})
    return result


def qq_usage(path=Path('/var/lib/qq-agent/usage-today.json'), day_key=None):
    """QQ counters are observation data, separate from upstream entitlement percentages."""
    day_key = day_key or datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or data.get('dayKey') != day_key:
            raise ValueError('No current day counters')
        fields = {'runs':'sessions','promptTokens':'input_tokens','completionTokens':'output_tokens',
            'totalTokens':'total_tokens','cachedTokens':'cached_tokens'}
        result = {}
        for source, target in fields.items():
            value = data.get(source)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value < 0:
                raise ValueError('Invalid local usage counter')
            result[target] = int(value)
        return {'available':True,'day_key':day_key,**result,'checked_at':stamp(),
            'scope':'仅QQ已记录会话；含重复上下文和缓存token，不含独立Agent与梗库提炼。不能换算Google配额消耗。'}
    except (OSError,ValueError,TypeError):
        return {'available':False,'day_key':day_key,'checked_at':stamp(),
            'note':'当前日的QQ用量记录不可用，不代表零用量。'}


class Controls:
    def __init__(self):
        self.lock = threading.RLock()
        self.cache = {}
        self.refresh_tokens = {}
        self.last_switch = -9999
        self.direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.proxy = urllib.request.build_opener(urllib.request.ProxyHandler({'https': 'http://127.0.0.1:7890'}))

    def json(self, url, *, headers=None, body=None, method=None, proxy=False, timeout=12):
        headers = dict(headers or {})
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        with (self.proxy if proxy else self.direct).open(req, timeout=timeout) as response:
            data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError('上游响应过大')
            return json.loads(data) if data else {}

    def cached(self, name, seconds, fetch):
        with self.lock:
            item = self.cache.get(name)
            if item and time.monotonic() - item[0] < seconds:
                return item[1]
        try:
            data = fetch()
        except (OSError, ValueError, KeyError, TypeError):
            data = {'available': False, 'error': '暂时无法读取，请稍后查询；未要求重新登录', 'checked_at': stamp()}
            # Do not display an earlier successful quota as if it were current.
        with self.lock:
            self.cache[name] = (time.monotonic(), data)
        return data

    def google(self):
        accounts = [json.loads(p.read_text()) for p in Path('/var/lib/codex-gateway/accounts').glob('antigravity*.json')]
        account = next((a for a in accounts if not a.get('disabled') and a.get('refresh_token')), None)
        if not account:
            return {'available': False, 'error': '未找到启用的 Google 账号', 'checked_at': stamp()}
        identity = account['refresh_token']
        cached = self.refresh_tokens.get(identity)
        token = cached[0] if cached and cached[1] > time.time() else account.get('access_token', '')
        def request(access):
            return self.json('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
                headers={'Authorization': 'Bearer ' + access, 'User-Agent': 'antigravity/1.20.6 linux/x64'},
                body={'project': account['project_id']}, proxy=True)
        try:
            payload = request(token)
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                raise
            # Refresh for this read only. The gateway remains responsible for its auth files.
            if not PUBLIC_CLIENT_ID or not PUBLIC_CLIENT_SECRET:
                return {'available': False, 'error': 'Google 额度刷新缺少部署环境中的 OAuth 客户端配置', 'checked_at': stamp()}
            body = urllib.parse.urlencode({'client_id': PUBLIC_CLIENT_ID, 'client_secret': PUBLIC_CLIENT_SECRET,
                'refresh_token': identity, 'grant_type': 'refresh_token'}).encode()
            req = urllib.request.Request('https://oauth2.googleapis.com/token', data=body,
                headers={'Content-Type': 'application/x-www-form-urlencoded'})
            with self.proxy.open(req, timeout=12) as response:
                renewed = json.load(response)
            token = renewed['access_token']
            self.refresh_tokens[identity] = (token, time.time() + int(renewed.get('expires_in', 3600)) - 120)
            payload = request(token)
        models = quota_models(payload)
        return {'available': bool(models), 'account_count': 1, 'models': models, 'checked_at': stamp(),
            'note': 'Google返回的模型配额比例；不同模型可能共享配额，不能换算为剩余调用次数。'}

    def traffic(self):
        cfg = json.loads(Path('/etc/qq-harness/nano-account.json').read_text())
        url = cfg['url']
        if not url.startswith('https://account.alibaba.alicdn.men/'):
            raise ValueError('订阅地址不在已保存的服务商范围')
        payload = self.json(url, headers={'Authorization': cfg['token'], 'Accept': 'application/json',
            'User-Agent': 'Dart/3.8 (dart:io)'}, proxy=True)
        data = payload['data']
        def number(name):
            value = data.get(name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError('服务商未返回有效额度')
            return int(value)
        used = number('u') + number('d')
        total = number('transfer_enable')
        return {'available': True, 'used_bytes': used, 'total_bytes': total,
            'remaining_bytes': max(0, total - used), 'expires_unix': number('expired_at'), 'checked_at': stamp()}

    def quotas(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            google = pool.submit(self.cached, 'google', 60, self.google)
            traffic = pool.submit(self.cached, 'traffic', 300, self.traffic)
            return {'google': google.result(), 'traffic': traffic.result(), 'qq_usage': qq_usage()}

    def control(self, path, body=None, method=None):
        cfg = json.loads(Path('/etc/codex-mihomo/config.yaml').read_text())
        return self.json('http://127.0.0.1:19090' + path, headers={'Authorization': 'Bearer ' + cfg['secret']}, body=body, method=method)

    def route(self):
        state = self.control('/proxies/' + GROUP)
        selected = state['now']
        automatic = selected == AUTO or state['type'] == 'Fallback'
        actual = self.control('/proxies/' + AUTO)['now'] if selected == AUTO else selected
        cfg = json.loads(Path('/etc/codex-mihomo/config.yaml').read_text())
        candidates = []
        for alias in ('A', 'C', 'V'):
            node = next((p['name'] for p in cfg['proxies'] if '美国-' + alias + '(通用)' in p['name']), None)
            if node:
                candidates.append({'id': alias, 'name': node})
        return {'mode': 'auto' if automatic else 'manual', 'selected': actual, 'choices': candidates, 'probe_seconds': 120}

    def switch(self, target):
        if target not in ('auto', 'A', 'C', 'V'):
            raise ValueError('线路只支持 自动、A、C、V')
        with self.lock:
            if time.monotonic() - self.last_switch < 10:
                raise ValueError('线路切换过于频繁，请等待10秒')
            current = self.route()
            selected = AUTO if target == 'auto' else next(p['name'] for p in current['choices'] if p['id'] == target)
            self.control('/proxies/' + GROUP, {'name': selected}, 'PUT')
            self.last_switch = time.monotonic()
            # Apply the explicit global change to Google's reused HTTP connections.
            connections = self.control('/connections').get('connections') or []
            for connection in connections:
                host = connection.get('metadata', {}).get('host', '')
                if host.endswith('.googleapis.com') or host.endswith('.googleusercontent.com'):
                    try:
                        self.control('/connections/' + urllib.parse.quote(connection['id'], safe=''), method='DELETE')
                    except OSError:
                        pass
            return self.route()
