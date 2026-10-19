import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseBvid} from './bili-reader.mjs';
import {biliView,sourceText,validateCandidates} from './bili-view.mjs';

// Low frequency, source-backed learning. It cannot change persona, memory or permissions.
export function createMemeLearning({filePath,getConfig,roleIdentity,access,biliReader,memeLibrary,extractCandidates,now=Date.now}) {
  let busy=false;
  let attempts=fs.existsSync(filePath)?JSON.parse(fs.readFileSync(filePath,'utf8')):[];
  if(!Array.isArray(attempts))throw Error('Invalid learning ledger');
  const enabled=event=>getConfig().communityFeatures?.autoLearn?.enabled===true
    && (getConfig().communityFeatures.autoLearn.groupIds||[]).map(String).includes(event.chatKey.replace(/^group:/,''))
    && event.chatKey.startsWith('group:')&&access.canRead(event,{search:true});
  function save(){
    fs.mkdirSync(path.dirname(filePath),{recursive:true,mode:0o700});
    const temporary=filePath+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(attempts.slice(-64)),{mode:0o600});fs.renameSync(temporary,filePath);
  }
  return {async learn(event,input={},expectedScope){
    const role=roleIdentity(getConfig(),event.chatKey);
    const allowed=()=>enabled(event)&&!input.signal?.aborted&&roleIdentity(getConfig(),event.chatKey).scope===role.scope&&(!expectedScope||expectedScope===role.scope);
    if(!allowed())return{saved:0,reason:'本群未开启自动积累，或当前角色已改变'};
    if(busy)return{saved:0,reason:'已有素材整理在进行'};
    const query=String(input.query||'').trim().slice(0,80);
    let bvid=input.bvid?parseBvid(input.bvid):'';
    if(!bvid&&query.length<2)throw Error('请提供BV号或至少两个字的主题');
    const day=new Date(now()).toISOString().slice(0,10),today=attempts.filter(a=>a.day===day);
    const scoped=today.filter(a=>a.chatKey===event.chatKey);
    if(today.length>=8||scoped.length>=4)return{saved:0,reason:'今日自动积累预算已用完（本群4次，全局8次）'};
    if(attempts.some(a=>a.chatKey===event.chatKey&&(now()-a.at<1800000||a.day===day&&(bvid?a.bvid===bvid:a.query===query))))
      return{saved:0,reason:'整理冷却中，或今天已处理过该主题'};
    busy=true;
    const attempt={chatKey:event.chatKey,roleId:role.id,day,at:now(),query,bvid};
    attempts.push(attempt);save(); // Charge before network/model calls, including failures and restarts.
    try {
      if(!bvid){
        const found=biliView(await biliReader.search(query),'search');
        if(!allowed())return{saved:0,reason:'会话权限或角色已改变'};
        const preferred=found.results.find(r=>/梗|抽象|整活|吐槽|搞笑|锐评|名场面|反串/u.test(r.title+' '+r.description));
        bvid=(preferred||found.results[0])?.bvid||'';
        if(!bvid)return{saved:0,reason:'没有找到公开视频，不保存'};
        attempt.bvid=bvid;save();
      }
      const info=biliView(await biliReader.read(bvid,'info'),'info');
      if(!allowed())return{saved:0,reason:'会话权限或角色已改变'};
      const comments=biliView(await biliReader.read(bvid,'comments'),'comments');
      const evidence=sourceText(info,comments);
      if(!allowed()||!evidence)return{saved:0,reason:'没有可整理的文字或会话已改变'};
      const candidates=validateCandidates(await extractCandidates(evidence),evidence);
      if(!allowed())return{saved:0,reason:'会话权限或角色已改变，未保存'};
      const scope={chatKey:event.chatKey,roleId:role.id};
      const entries=memeLibrary.addMany(candidates.map(c=>({...c,bvid,automatic:true})),scope);
      return{saved:entries.length,items:entries.map(({id,title,meaning,usage,sourceUrl})=>({id,title,meaning,usage,sourceUrl})),note:'仅本群当前角色；网友表达素材，含义是候选解读，不代表事实。可 /梗库 禁用 编号'};
    } finally {busy=false;}
  }};
}
