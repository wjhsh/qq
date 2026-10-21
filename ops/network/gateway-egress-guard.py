"""Limit the dedicated model gateway to its loopback proxy and local API replies.

Only this user's OUTPUT jump and this script's two named chains are managed.
The host DNS, SSH, QQ client and Tailscale rules are deliberately outside scope.
"""
import argparse,json,os,pwd,shlex,subprocess

CHAIN='QQ_GW_EGRESS'
USER='codex-gateway'

def run(argv,**kwargs):
    return subprocess.run(argv,capture_output=True,text=True,timeout=12,**kwargs)

def restore_rules(family):
    if family not in (4,6):raise ValueError('Unsupported address family')
    rules=[f'*filter',f':{CHAIN} - [0:0]',f'-F {CHAIN}']
    if family==4:
        rules.append(f'-A {CHAIN} -o lo -d 127.0.0.1/32 -p tcp -m tcp --dport 7890 -j ACCEPT')
    rules.append(f'-A {CHAIN} -o lo -p tcp -m tcp --sport 8317 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT')
    reject='icmp-port-unreachable' if family==4 else 'icmp6-port-unreachable'
    rules.extend([f'-A {CHAIN} -j REJECT --reject-with {reject}','COMMIT',''])
    return '\n'.join(rules)

def signature(line):
    # iptables prints core flags in canonical order. Conditions within one rule
    # are conjunctive; preserve rule order while comparing its flag/value pairs.
    tokens=shlex.split(line)
    if len(tokens)%2:return None
    return tuple(sorted(zip(tokens[::2],tokens[1::2])))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['apply','check','remove']);args=parser.parse_args()
    uid=pwd.getpwnam(USER).pw_uid
    if uid==0 or os.geteuid()!=0:raise RuntimeError('Dedicated non-root gateway user and root rule management are required')
    result={}
    for family,binary in [(4,'iptables'),(6,'ip6tables')]:
        jump=['-m','owner','--uid-owner',str(uid),'-m','comment','--comment','qq-gateway-proxy-only','-j',CHAIN]
        if args.action=='apply':
            # The chain replacement is committed atomically. Other host chains are preserved.
            restored=run([binary+'-restore','--noflush','--wait','5'],input=restore_rules(family))
            if restored.returncode:raise RuntimeError(f'Failed to install IPv{family} egress chain')
            if run([binary,'-w','5','-C','OUTPUT',*jump]).returncode:
                if run([binary,'-w','5','-I','OUTPUT','1',*jump]).returncode:raise RuntimeError(f'Failed to bind IPv{family} egress chain')
        elif args.action=='remove':
            while run([binary,'-w','5','-C','OUTPUT',*jump]).returncode==0:
                if run([binary,'-w','5','-D','OUTPUT',*jump]).returncode:raise RuntimeError('Failed to remove own OUTPUT jump')
            run([binary,'-w','5','-F',CHAIN]);run([binary,'-w','5','-X',CHAIN])
        jump_present=run([binary,'-w','5','-C','OUTPUT',*jump]).returncode==0
        chain_lines=run([binary,'-w','5','-S',CHAIN]).stdout.splitlines()
        expected=[signature(line) for line in restore_rules(family).splitlines() if line.startswith('-A ')]
        actual=[signature(line) for line in chain_lines if line.startswith('-A ')]
        output_lines=[line for line in run([binary,'-w','5','-S','OUTPUT']).stdout.splitlines() if line.startswith('-A ')]
        first_jump=bool(output_lines and 'qq-gateway-proxy-only' in output_lines[0] and output_lines[0].endswith('-j '+CHAIN))
        result[str(family)]={'jump_present':jump_present,'chain_matches':actual==expected,'output_jump_first':first_jump}
        if args.action in ('apply','check') and not (jump_present and actual==expected and first_jump):
            print(json.dumps({'action':args.action,'gateway_uid':uid,'families':result}))
            raise RuntimeError(f'IPv{family} guard is missing, altered or shadowed')
    print(json.dumps({'action':args.action,'gateway_uid':uid,'families':result}))

if __name__=='__main__':main()
