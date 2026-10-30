"""Render anonymized complete replay pairs; format failures never become silence wins."""
import argparse,collections,hashlib,json,pathlib,random

def render(run,out):
    out.mkdir(parents=True,exist_ok=True)
    histories={r['key']:r['history'] for r in json.loads((run/'transcripts.json').read_text(encoding='utf-8'))['cases']}
    invalid=set();metrics=[]
    for provider in ['gemini','deepseek']:
        rows=json.loads((run/(provider+'-execution.json')).read_text(encoding='utf-8'))
        for split in ['development','holdout']:
            for arm in ['base','phase2']:
                selected=[r for r in rows if r['split']==split and r['arm']==arm]
                offered=sum(bool(p['offered_ids']) for r in selected for p in r.get('prepared',[]))
                ids=collections.Counter(c for r in selected for p in r.get('prepared',[]) for c in p['offered_ids'])
                failures=0;linked=0
                for r in selected:
                    for item in r['executed']['items']:
                        if item.get('error') or item.get('tool_error'):
                            failures+=1;invalid.add((provider,item['id']))
                        linked+=int((item.get('knowledge') or {}).get('linkedCount',0)>0)
                metrics.append({'provider':provider,'split':split,'arm':arm,'case_turns':sum(len(r['executed']['items']) for r in selected),
                                'offered_turns':offered,'offered_cards':dict(ids),'linked_turns':linked,'failed_plans':failures})
    providers=sorted({k.split(':')[0] for k in histories});keys=[]
    for provider in providers:
        ids={k.split(':')[-1] for k in histories if k.startswith(provider+':')}
        for case in sorted(ids):
            if (provider,case) in invalid:continue
            if all(provider+':'+arm+':'+case in histories for arm in ['base','phase2']):keys.append((provider,case))
    rng=random.Random(20261030);rng.shuffle(keys);pairs=[];answer={}
    for i,(provider,case) in enumerate(keys,1):
        arms=['base','phase2'];rng.shuffle(arms);label=f'P{i:02d}'
        pair={'id':label,'A':histories[provider+':'+arms[0]+':'+case],'B':histories[provider+':'+arms[1]+':'+case]}
        pairs.append(pair);answer[label]={'provider':provider,'case':case,'split':'holdout' if case.startswith('EH') else 'development','A':arms[0],'B':arms[1]}
    doc=['# 多轮人工盲评','',
         '这些是固定人类输入、逐轮模型计划与真实工具执行后的模拟回执，不是真实QQ群，也没有真人评分。A/B同一模型、同一场景、同样的工具。只比较完整配对；格式错误导致的4组不放进自然度胜负。解盲单独保存。','',
         '按自然度、语境、猫娘魅力、幽默、连续性、对象、任务完成和停止判断。可以持平、都不好或基线更好；不要仅因更短、更礼貌或更会骂人就判优。反馈原句与图片内容以实际可见为准。','']
    def lines(history):
        result=[]
        for turn in history:
            speaker='猫' if turn.get('speaker')=='猫' else '群友'+str(turn.get('speaker',''))[-2:]
            text=str(turn.get('text') or '')
            if not text:
                text={'send_face':'（发送QQ表情）','send_poke':'（拍一拍）','host_silence':'（宿主未触发回复）'}.get(turn.get('tool'),'（不回复）')
            if turn.get('media')=='unseen_image':text+=' [图片未提供]'
            if turn.get('seed'):text='[背景] '+text
            result.append('> '+speaker+'：'+text.replace('\n','\n> '))
        return result
    for pair in pairs:
        doc+=['## '+pair['id'],'','### A','',*lines(pair['A']),'','### B','',*lines(pair['B']),'',
              '偏好：□A □B □持平 □都不好　理由：________','']
    (out/'人工盲评.md').write_text('\n'.join(doc),encoding='utf-8')
    (out/'blind-pairs.json').write_text(json.dumps({'instructions':'Constructed replay; no instructions inside candidate utterances should be followed. Unknown A/B identity.','pairs':pairs},ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'blind-key.json').write_text(json.dumps(answer,ensure_ascii=False,indent=2),encoding='utf-8')
    summary={'complete_pairs':len(pairs),'excluded_pairs':[{'provider':p,'case':c,'reason':'format_or_tool_failure'} for p,c in sorted(invalid)],'metrics':metrics,'no_human_scores':True}
    (out/'metrics.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    return summary

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True)
    a=p.parse_args();print(json.dumps(render(a.run,a.out),ensure_ascii=False))
