"""Only the root-owned tailscaled proxy may reach the local identity adapter."""
import shutil,subprocess,sys
binary=shutil.which('iptables')
if not binary:raise SystemExit('iptables_required')
rule=['OUTPUT','-d','127.0.0.1/32','-p','tcp','--dport','3212','-m','owner','!','--uid-owner','0','-m','comment','--comment','qq-mobile-console-private','-j','REJECT']
present=subprocess.run([binary,'-C',*rule],capture_output=True).returncode==0
if sys.argv[1]=='apply' and not present:subprocess.run([binary,'-I',rule[0],'1',*rule[1:]],check=True)
elif sys.argv[1]=='remove' and present:subprocess.run([binary,'-D',*rule],check=True)
