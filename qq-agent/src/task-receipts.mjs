import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ID=/^[a-f0-9]{12}$/;
const chatTarget=/^(group|private):[1-9]\d{0,14}$/;
const gptScope=item=>item.command==='/GPT'&&item.chatKey===`private:${item.senderId}`
  &&typeof item.sourceChatKey==='string'&&chatTarget.test(item.sourceChatKey)
  &&(!item.sourceChatKey.startsWith('private:')||item.sourceChatKey===item.chatKey);
function save(file,state){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  fs.renameSync(temporary,file);
}

export function createTaskReceipts({filePath,request,access,send,enabled=()=>true,now=Date.now,log=()=>{}}){
  const state=fs.existsSync(filePath)?JSON.parse(fs.readFileSync(filePath,'utf8')):{version:1,items:{}};
  if(state.version!==1||!state.items||typeof state.items!=='object')throw Error('Invalid task receipt state');
  // A crash after transport acceptance is ambiguous. Never replay that attempt.
  let recovered=false;
  for(const item of Object.values(state.items))if(item.state==='sending'){item.state='uncertain';recovered=true;}
  if(recovered)save(filePath,state);
  let busy=false,timer=null;
  function register({jobId,chatKey,senderId,includeResult=false,command,sourceChatKey}){
    if(!ID.test(jobId)||!/^(group|private):[1-9]\d{0,14}$/.test(chatKey)||!/^[1-9]\d{0,14}$/.test(String(senderId)))throw Error('Invalid receipt target');
    const details=includeResult===true;
    if(details&&!gptScope({command,chatKey,senderId,sourceChatKey}))throw Error('Invalid GPT receipt scope');
    const old=state.items[jobId];
    if(old){if(old.chatKey!==chatKey||old.senderId!==String(senderId)||Boolean(old.includeResult)!==details
      ||details&&(old.command!==command||old.sourceChatKey!==sourceChatKey))throw Error('Receipt target already bound');return true;}
    for(const[id,item]of Object.entries(state.items))if(item.state!=='pending'&&now()-item.created>7*86400000)delete state.items[id];
    if(Object.keys(state.items).length>=1000)throw Error('Task receipt storage full');
    state.items[jobId]={jobId,chatKey,senderId:String(senderId),created:now(),expires:now()+86400000,state:'pending'};
    if(details)Object.assign(state.items[jobId],{includeResult:true,command,sourceChatKey});
    save(filePath,state);return true;
  }
  async function tick(){
    if(busy||!enabled())return;
    busy=true;
    try{
      const pending=Object.values(state.items).filter(x=>x.state==='pending').sort((a,b)=>a.created-b.created).slice(0,10);
      for(const item of pending){
        if(item.includeResult===true&&!gptScope(item)){item.state='discarded';save(filePath,state);continue;}
        if(now()>item.expires){item.state='expired';save(filePath,state);continue;}
        const permission=access(item);
        if(permission==='deny'){item.state='discarded';save(filePath,state);continue;}
        if(permission!=='allow')continue;
        let job;
        try{job=await request('/jobs/'+item.jobId);}catch{continue;}
        if(item.includeResult===true&&(job?.engine!=='codex'||job?.mode!=='diagnostics')){item.state='discarded';save(filePath,state);continue;}
        if(job?.id!==item.jobId||!['succeeded','failed','interrupted','cancelled'].includes(job.status))continue;
        if(job.status==='cancelled'){item.state='cancelled';save(filePath,state);continue;}
        if(!enabled()||access(item)!=='allow')continue;
        item.state='sending';item.attempted=now();save(filePath,state);
        const label={succeeded:'已完成',failed:'失败',interrupted:'已中断'}[job.status];
        const command=item.includeResult===true?'/GPT':item.chatKey.startsWith('group:')?'/群任务':'/任务';
        const result=item.includeResult===true?`\n${String(job.result||job.error||'尚无文字结果').slice(0,1800)}`:'';
        const message=`${item.includeResult===true?'GPT诊断':'任务'} ${item.jobId} ${label}。${result}\n用 ${command} 结果 ${item.jobId} 查看${item.includeResult===true?'完整结果':'结果与文件'}。`;
        try{
          await send(item.chatKey,message,()=>enabled()&&access(item)==='allow');
          item.state='sent';item.delivered=now();
        }catch{item.state='uncertain';log('任务回执发送未确认，未自动重发：'+item.jobId);}
        save(filePath,state);
      }
    }finally{busy=false;}
  }
  return {register,tick,snapshot:()=>structuredClone(state),
    start(){if(timer)return;timer=setInterval(()=>{tick().catch(()=>log('任务回执检查失败'));},10000);timer.unref?.();},
    stop(){if(timer)clearInterval(timer);timer=null;}};
}
