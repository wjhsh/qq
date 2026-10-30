"""Three-round text plans with real isolated tool execution, no QQ sends.
Both arms use the same current base card/system, provider and temperature.
Baseline: git 9ff4631 SocialRuntime with compatible current SocialState;
legacy calls/format are unchanged. --expression instead uses released 8829a7b
SocialRuntime and phase2-enabled legacy/current settings as control. This is not
a full production reconstruction.
"""
import argparse,concurrent.futures,hashlib,importlib.util,json,pathlib,re,subprocess,threading
ROOT=pathlib.Path(__file__).resolve().parents[1]
def parse(text):
    match=re.fullmatch(r'\s*```(?:json)?\s*([\s\S]*?)\s*```\s*',text)
    value=json.loads(match.group(1) if match else text)
    if not isinstance(value,dict) or not isinstance(value.get('items'),list):raise ValueError('Expected object with items array')
    return value
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--endpoints',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--splits',default='development,holdout');p.add_argument('--resume-existing',action='store_true',help='Replay saved responses locally; do not repeat completed API calls')
    p.add_argument('--replay-only',action='store_true',help='Only execute saved plans locally; never make API calls')
    p.add_argument('--expression',action='store_true',help='Compare released phase2 versus default-off expression/linked-context candidate on new fixtures')
    a=p.parse_args();splits=a.splits.split(',');assert all(s in ['development','holdout','confirmation'] for s in splits)
    a.out.mkdir(parents=True,exist_ok=True);assert a.replay_only or not (a.out/'transcripts.json').exists(),'Existing evaluation'
    spec=importlib.util.spec_from_file_location('local_workers',ROOT/'tools/model-collaboration.py');workers=importlib.util.module_from_spec(spec);spec.loader.exec_module(workers)
    baseline_ref='8829a7b' if a.expression else '9ff4631'
    baseline=subprocess.check_output(['git','show',baseline_ref+':qq-agent/src/social-runtime.mjs'],cwd=ROOT).decode('utf-8')
    baseline=re.sub(r"from '(\./[^']+)'",lambda m:'from '+json.dumps((ROOT/'qq-agent/src'/m.group(1).removeprefix('./')).as_uri()),baseline)
    legacy=a.out/'baseline-runtime.mjs';legacy.write_text(baseline,encoding='utf-8')
    host=subprocess.Popen(['node',str(ROOT/'tools/social-multiturn-host.mjs'),str(legacy.resolve()),*(['expression-v1'] if a.expression else [])],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',cwd=ROOT)
    lock=threading.Lock();settings=json.loads(a.endpoints.read_text(encoding='utf-8'))
    def command(payload):
        with lock:
            host.stdin.write(json.dumps(payload,ensure_ascii=False)+'\n');host.stdin.flush();line=host.stdout.readline()
            if not line:raise RuntimeError('Offline host stopped')
            result=json.loads(line)
            if 'error' in result:raise RuntimeError(result['error'])
            return result
    def evaluate(provider):
        status=[];new_calls=0;reused=0;plan_failures=0
        for split in splits:
            for step in range(3):
                for arm in (['base','phase2'] if step%2==0 else ['phase2','base']):
                    batch=command({'action':'prepare','provider':provider,'arm':arm,'split':split,'step':step})
                    task='''离线沙箱：每个case是独立群聊。依据该case已发生的history与host提示选择一个工具计划。你是猫娘群友，可以反串互损撒娇，也可认真做事或沉默。不要输出分析/主持人总结。看不到真实图片；工具仅限给出的4种，不能冒充查资料、读PR或已设置提醒。任务缺依据就询问。返回严格JSON {"items":[{"id":"case编号","tool":"send_message|send_face|send_poke|finish","args":{工具参数}}]}。send_message的args.messages为文字或1-2条数组，finishAfterSend=true。finish用summary记录结束原因。socialFeedback可选，仅本人本轮实际对你说的连续原句支持时给出，不为刷状态填写。协调者用模拟回执执行；每个case一个计划，不跨case借记忆。'''
                    context=batch['base_system']+'\n工具schema：'+json.dumps(batch['tools'],ensure_ascii=False)+'\n分离case：'+json.dumps(batch['cases'],ensure_ascii=False)
                    out=a.out/provider/split/f'{step}-{arm}';out.mkdir(parents=True,exist_ok=True)
                    existing=out/(provider+'.json')
                    if existing.exists():
                        if not a.resume_existing:raise RuntimeError('Call exists; not retried')
                        result=json.loads(existing.read_text(encoding='utf-8'))
                        reused+=1
                        assert result['context_sha256']==hashlib.sha256(context.encode()).hexdigest(),'Replay context drift'
                        assert result['task_sha256']==hashlib.sha256(task.encode()).hexdigest(),'Replay task drift'
                    else:
                        if a.replay_only:raise RuntimeError('Missing response in replay-only mode')
                        ok=workers.run(provider,settings,context,task,out,7500,300)
                        new_calls+=1
                        if not ok:return{'provider':provider,'completed':False,'failed_at':str(out.relative_to(a.out))}
                        result=json.loads(existing.read_text(encoding='utf-8'))
                    assert result['status']=='completed','A failed request is not retried'
                    reviewed=out/'plan-reviewed.json'
                    if reviewed.exists():
                        plans=json.loads(reviewed.read_text(encoding='utf-8'));assert plans['source_sha256']==hashlib.sha256(result['text'].encode()).hexdigest(),'Reviewed plan source mismatch'
                    else:
                        try:plans=parse(result['text'])
                        except (json.JSONDecodeError,ValueError) as error:
                            plans={'items':[],'parse_error':{'position':getattr(error,'pos',None),'message':str(error)}}
                            (out/'parse-failure.json').write_text(json.dumps(plans['parse_error'],indent=2),encoding='utf-8')
                    executed=command({'action':'apply','provider':provider,'arm':arm,'split':split,'step':step,'items':plans.get('items')})
                    failures=sum(bool(item.get('error') or item.get('tool_error')) for item in executed.get('items',[]));plan_failures+=failures
                    status.append({'format_error':plans.get('parse_error'),'plan_failures':failures,'split':split,'step':step,'arm':arm,'executed':executed,'fixture_sha256':hashlib.sha256((ROOT/'tests/fixtures'/('social-expression' if a.expression else 'social-phase2')/f'{split}.json').read_bytes()).hexdigest()})
                    (a.out/(provider+'-execution.json')).write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf-8')
        return{'provider':provider,'completed':plan_failures==0,'finished_all_batches':True,'plan_failures':plan_failures,'baseline_revision':baseline_ref,'distinct_api_responses':len(status),'new_api_calls':new_calls,'saved_responses_reused':reused}
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=[f.result() for f in [pool.submit(evaluate,n) for n in ['gemini','deepseek']]]
        transcripts=command({'action':'export'});(a.out/'transcripts.json').write_text(json.dumps(transcripts,ensure_ascii=False,indent=2),encoding='utf-8')
        (a.out/'completion.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
    finally:
        host.stdin.close();host.wait(timeout=10)
    return 0 if all(r.get('completed') for r in results) else 1
if __name__=='__main__':raise SystemExit(main())
