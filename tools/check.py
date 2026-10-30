"""Run bounded offline regressions without loading production data or credentials."""
import os,pathlib,re,subprocess,sys,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
JS=['test-direct-route.mjs','test-blocked-route.mjs','test-raw-session.mjs','test-image-edit.mjs','test-mention-ingest.mjs',
    'test-input-guard-queue.mjs','test-input-guard-ingress.mjs','test-model-availability.mjs',
    'test-faces-persona-context.mjs','test-preferred-model-recovery.mjs','test-google-request-guard.mjs','test-gpt-chat-entry.mjs',
    'test-google-account-routing.mjs','test-google-account-commands.mjs',
    'test-social-state.mjs','test-social-runtime.mjs','test-social-integration.mjs','test-meme-evolution.mjs','test-gemini-voice.mjs','test-social-phase2.mjs','test-social-replay-host.mjs','test-social-expression.mjs']
PY=['test-reference-branch.py','test-chat-variants.py','test-chat-session.py','test-chat-policy-result.py','test-chat-image.py','test-direct-admission.py','test-image-inputs.py','test-image-admission.py','test-publish-config.py','test-maintenance-context.py','test-google-account-quota.py','test-pi-channels.py']
def main():
 total=0
 with tempfile.TemporaryDirectory(prefix='hajimi-offline-') as directory:
  env=dict(os.environ,QQ_AGENT_DATA_DIR=directory,APP_SOURCE=str(ROOT/'qq-agent/src/app.js'),PYTHONDONTWRITEBYTECODE='1')
  commands=[['node','--test',*[str(ROOT/'tests'/name) for name in JS]],*[[sys.executable,'-B',str(ROOT/'harness'/name)] for name in PY], [sys.executable,'-B',str(ROOT/'tools/test-social-evaluation.py')]]
  for args in commands:
   result=subprocess.run(args,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60)
   output=result.stdout+result.stderr
   if result.returncode:
    print(output[-10000:]);return result.returncode
   match=re.search(r'(?:# tests |tests )(\d+)',output) if args[0]=='node' else re.search(r'Ran (\d+) tests?',output)
   if not match:print('No test count reported:',pathlib.Path(args[-1]).name);return 1
   count=int(match.group(1));total+=count;print(f'PASS {pathlib.Path(args[-1]).name}: {count} tests')
  print(f'PASS total: {total} offline tests')
 return 0
if __name__=='__main__':raise SystemExit(main())

