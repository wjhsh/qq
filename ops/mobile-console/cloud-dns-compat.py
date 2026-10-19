"""Preserve Huawei DNS replies before Tailscale's CGNAT anti-spoof drop."""
import ipaddress,json,re,subprocess
from pathlib import Path

def run(args,check=False):return subprocess.run(['iptables',*args],capture_output=True,text=True,check=check,timeout=8)
def main():
    cfg=json.loads(Path('/etc/qq-mobile-console/cloud-dns-compat.json').read_text())
    interface=cfg['interface']
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,32}',interface):raise ValueError('invalid_dns_interface')
    resolvers=list(dict.fromkeys(cfg['resolvers']))
    if not resolvers or any(ipaddress.ip_address(ip) not in ipaddress.ip_network('100.125.0.0/16') for ip in resolvers):raise ValueError('unexpected_huawei_dns_resolver')
    rules=[]
    for address in resolvers:
        for protocol in ['udp','tcp']:
            rules.append(['-i',interface,'-s',address+'/32','-p',protocol,'--sport','53','-m','conntrack','--ctstate','ESTABLISHED','-m','comment','--comment','qq-huawei-dns-reply','-j','ACCEPT'])
    current=run(['-S','INPUT'],True).stdout.splitlines()
    tailnet=next((i for i,line in enumerate(current) if '-j ts-input' in line),len(current))
    own=[i for i,line in enumerate(current) if 'qq-huawei-dns-reply' in line]
    healthy=len(own)==len(rules) and all(i<tailnet for i in own) and all(run(['-C','INPUT',*rule]).returncode==0 for rule in rules)
    if healthy:return
    for rule in rules:
        while run(['-C','INPUT',*rule]).returncode==0:run(['-D','INPUT',*rule],True)
        run(['-I','INPUT','1',*rule],True)
    print('HUAWEI_DNS_REPLY_COMPATIBILITY_APPLIED',flush=True)
if __name__=='__main__':main()
