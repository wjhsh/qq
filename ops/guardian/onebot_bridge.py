"""Private host loopback -> fixed QQ container. Resolve IP on new connections."""
import ipaddress,json,select,socket,socketserver,subprocess,threading,time
CONTAINER='codex-qq-trial'
cache={'until':0,'ip':''};lock=threading.Lock();slots=threading.BoundedSemaphore(32)
def container_ip():
    with lock:
        if time.monotonic()<cache['until']:return cache['ip']
        value=json.loads(subprocess.run(['docker','inspect',CONTAINER],capture_output=True,text=True,check=True,timeout=5).stdout)[0]
        if value['State']['Running'] is not True:raise OSError('container_not_running')
        addresses=[v.get('IPAddress','') for v in value['NetworkSettings']['Networks'].values()]
        target=next((x for x in addresses if x and ipaddress.ip_address(x).version==4 and ipaddress.ip_address(x).is_private),None)
        if not target:raise OSError('private_container_address_missing')
        cache.update(ip=target,until=time.monotonic()+5);return target
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True;daemon_threads=True
    def verify_request(self,request,address):return address[0]=='127.0.0.1'
    def handle_error(self,*args):pass
class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not slots.acquire(blocking=False):return
        try:
            with socket.create_connection((container_ip(),self.server.server_address[1]),timeout=8) as peer:
                peer.settimeout(None);self.request.settimeout(None)
                peer.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)
                while True:
                    ready,_,_=select.select([peer,self.request],[],[],60)
                    for source in ready:
                        data=source.recv(65536)
                        if not data:return
                        (self.request if source is peer else peer).sendall(data)
        except (OSError,subprocess.SubprocessError,ValueError,KeyError):pass
        finally:slots.release()
if __name__=='__main__':
    servers=[Server(('127.0.0.1',port),Handler) for port in [3000,3001]]
    for server in servers:threading.Thread(target=server.serve_forever,daemon=True).start()
    print('PRIVATE_ONEBOT_BRIDGE_READY',flush=True)
    threading.Event().wait()
