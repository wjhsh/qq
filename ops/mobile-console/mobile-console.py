"""Private Tailscale Serve adapter for the loopback-only QQ console."""
import http.client,ipaddress,json,os,re,socket,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

TAILNET_V4=ipaddress.ip_network('100.64.0.0/10')
TAILNET_V6=ipaddress.ip_network('fd7a:115c:a1e0::/48')
HOP={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'}

def open_backend():return http.client.HTTPConnection('127.0.0.1',3210,timeout=45)
def open_harness():return http.client.HTTPConnection('127.0.0.1',3211,timeout=45)

def agent_route(method,path):
    path=urlsplit(path).path
    if method=='GET' and path in ['/health','/status','/quotas','/network/route','/jobs','/qq/client']:return True
    if method=='POST' and path in ['/jobs','/network/route','/maintenance/restart','/qq/client']:return True
    return bool(re.fullmatch(r'/jobs/[a-f0-9]{12}'+(r'(?:/file|/changes)?' if method=='GET' else r'/(?:cancel|apply|rollback)'),path)) if method in ['GET','POST'] else False

def check_identity(headers,settings):
    host=str(headers.get('Host','')).lower()
    dns=str(settings['dns_name']).lower().rstrip('.')
    if host not in {dns,dns+':443',dns+':80'}:return False
    if str(headers.get('Tailscale-User-Login','')).strip().casefold()!=settings['operator_login'].casefold():return False
    try:
        peer=ipaddress.ip_address(str(headers.get('X-Forwarded-For','')).split(',')[-1].strip())
        if peer not in (TAILNET_V4 if peer.version==4 else TAILNET_V6):return False
        if str(peer) in settings['server_ips']:return False
    except ValueError:return False
    origin=str(headers.get('Origin',''))
    if origin and origin not in {'https://'+dns,'http://'+dns}:return False
    referer=str(headers.get('Referer',''))
    if referer:
        try:
            parsed=urlsplit(referer)
            if parsed.scheme not in ['http','https'] or parsed.hostname!=dns or parsed.port not in [None,80,443]:return False
        except ValueError:return False
    return True

class MobileServer(ThreadingHTTPServer):
    daemon_threads=True
    allow_reuse_address=True
    def __init__(self,address,settings,token,harness_token=''):
        self.settings=settings;self.token=token;self.harness_token=harness_token;self.slots=threading.BoundedSemaphore(12)
        super().__init__(address,Handler)
    def process_request(self,request,address):
        if not self.slots.acquire(blocking=False):request.close();return
        try:super().process_request(request,address)
        except Exception:self.slots.release();raise
    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.slots.release()

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    server_version='PrivateConsole'
    def log_message(self,*args):pass
    def reject(self,status,message):
        data=json.dumps({'error':message},ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers();self.wfile.write(data);self.close_connection=True
    def proxy(self):
        self.connection.settimeout(45)
        if not check_identity(self.headers,self.server.settings):return self.reject(403,'请使用授权的 Tailscale 账号与手机访问。')
        if self.headers.get('Transfer-Encoding') or self.headers.get('Upgrade'):return self.reject(400,'不支持该请求方式。')
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.reject(400,'请求长度无效。')
        if not 0<=length<=25*1024*1024:return self.reject(413,'请求内容过大。')
        if not self.path.startswith('/') or self.path.startswith('//') or '\\' in self.path:return self.reject(400,'请求路径无效。')
        path=urlsplit(self.path).path
        if path in ['/','/agent','/agent/'] and self.command in ['GET','HEAD']:
            data=Path(__file__).with_name('agent-workbench.html').read_bytes()
            self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-cache');self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Frame-Options','DENY');self.send_header('Referrer-Policy','no-referrer');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");self.end_headers()
            if self.command!='HEAD':self.wfile.write(data)
            return
        agent=self.path.startswith('/agent-api/')
        upstream=self.path[len('/agent-api'):] if agent else ('/' if path in ['/qq','/qq/'] else self.path)
        if agent and (not self.server.harness_token or not agent_route(self.command,upstream)):return self.reject(404,'工作台接口不存在。')
        if agent and length>32768:return self.reject(413,'任务请求过大。')
        body=self.rfile.read(length) if length else None
        if body is not None and len(body)!=length:return self.reject(400,'请求内容不完整。')
        backend='127.0.0.1:3211' if agent else '127.0.0.1:3210'
        headers={k:v for k,v in self.headers.items() if k.lower() in {'accept','accept-encoding','accept-language','content-type','content-length','range','if-none-match','if-modified-since','user-agent'}}
        headers.update({'Host':backend,'Connection':'close'})
        if agent:headers['Authorization']='Bearer '+self.server.harness_token
        else:headers['x-console-token']=self.server.token
        if self.headers.get('Origin'):headers['Origin']='http://'+backend
        if self.headers.get('Referer'):headers['Referer']='http://'+backend+'/'
        peer=open_harness() if agent else open_backend()
        started=False
        try:
            peer.request(self.command,upstream,body=body,headers=headers)
            response=peer.getresponse();self.send_response(response.status);started=True
            for key,value in response.getheaders():
                if key.lower() not in HOP|{'server','date','access-control-allow-origin','access-control-allow-credentials','x-frame-options'}:self.send_header(key,value)
            self.send_header('Connection','close');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Frame-Options','DENY');self.end_headers()
            if self.command!='HEAD':
                while True:
                    chunk=response.read1(65536)
                    if not chunk:break
                    self.wfile.write(chunk);self.wfile.flush()
        except (OSError,http.client.HTTPException,socket.timeout):
            if not started:self.reject(502,'控制台暂时不可用，请稍后刷新。')
        finally:peer.close();self.close_connection=True
    do_GET=proxy
    do_HEAD=proxy
    do_POST=proxy
    do_PUT=proxy
    do_DELETE=proxy
    do_PATCH=proxy

if __name__=='__main__':
    credentials=Path(os.environ['CREDENTIALS_DIRECTORY'])
    settings=json.loads((credentials/'settings').read_text())
    token=(credentials/'console-token').read_text().strip()
    if not token or not settings.get('operator_login') or not settings.get('dns_name'):raise SystemExit('private_console_configuration_incomplete')
    harness_token=(credentials/'harness-token').read_text().strip()
    MobileServer(('127.0.0.1',3212),settings,token,harness_token).serve_forever()
