import {extractAdminText} from './natural-admin.mjs';
import {parseBvid} from './bili-reader.mjs';
import {biliView,sourceRecords,validateCandidates,formatBili} from './bili-view.mjs';
const HELP='B站只读工具：\n/B站 状态\n/B站 搜索 关键词\n/B站 读取 BV号\n/B站 评论 BV号\n梗库（仅当前会话、当前角色）：\n/梗库 列表\n/梗库 查看 m-编号\n主人可用：\n/梗库 添加 标题 | 含义 | 用法\n/梗库 采集 BV号\n/梗库 学习 主题（整理成待审核候选）\n/梗库 收藏 m-编号\n/梗库 禁用 m-编号\n采集只进入候选区；收藏后才供聊天检索。这里的收藏不操作B站收藏夹。';
export function createCommunityCommands({getConfig,getSelfId,access,roleIdentity,biliReader,memeLibrary,memeLearning,extractCandidates,sendReply}){
  let queued=0,tail=Promise.resolve();
  async function run(event,match){
    const category=match[1].toLowerCase()==='b站'?'bili':'meme',body=match[2]?.trim()||'帮助';
    const search=category==='bili'||/^(采集|学习)\s/.test(body);
    if(!access.canRead(event,{search}))return{handled:true};
    const role=roleIdentity(getConfig(),event.chatKey),scope={chatKey:event.chatKey,roleId:role.id,roleVersion:role.scope};
    const allowed=()=>access.canRead(event,{search})&&roleIdentity(getConfig(),event.chatKey).scope===role.scope;
    const manage=()=>allowed()&&access.canManage(event);
    const reply=async text=>{if(allowed())await sendReply(event.chatKey,text,allowed);};
    try{
      if(body==='帮助'){await reply(HELP);return{handled:true};}
      if(category==='bili'){
        if(body==='状态')await reply(formatBili(biliView(await biliReader.status(),'status'),'status'));
        else{
          const cmd=/^(搜索|读取|评论)\s+([\s\S]+)$/.exec(body);
          if(!cmd)throw Error('用 /B站 帮助 查看格式');
          const part={搜索:'search',读取:'info',评论:'comments'}[cmd[1]];
          const bvid=part==='search'?'':parseBvid(cmd[2]);
          const result=part==='search'?await biliReader.search(cmd[2]):await biliReader.read(bvid,part);
          await reply(formatBili(biliView(result,part),part,bvid));
        }
      }else if(/^学习\s+/.test(body)){
        if(!manage())return{handled:true};
        const data=await memeLearning.learn(event,{query:body.slice(3).trim()},role.scope);
        await reply(data.saved?'已保存本群当前角色的待审核候选：\n'+data.items.map(e=>e.id+' '+e.title+'\n'+e.sourceUrl).join('\n')+'\n主人确认后用 /梗库 收藏 编号 启用。':data.reason||'没有提炼到有来源的表达素材。');
      }else if(body==='列表'){
        const entries=memeLibrary.list(scope,access.canManage(event)?{}:{status:'approved'}).slice(0,20);
        await reply(entries.map(e=>`${e.id} [${{pending:'候选',approved:'已收藏',disabled:'禁用'}[e.status]}] ${e.title}`).join('\n')||'当前会话、当前角色暂无素材。');
      }else if(/^查看\s+/.test(body)){
        const entry=memeLibrary.get(body.slice(3).trim(),scope);
        if(!entry||!access.canManage(event)&&entry.status!=='approved')throw Error('未找到当前会话、当前角色的素材');
        await reply(`${entry.id} ${entry.title}\n含义（候选解读）：${entry.meaning}\n用法：${entry.usage}\n状态：${entry.status}${entry.sourceUrl?'\n来源：'+entry.sourceUrl:''}${entry.evidence?'\n原文：'+entry.evidence:''}`);
      }else{
        if(!manage())return{handled:true};
        let cmd=/^(收藏|禁用)\s+(m-[a-f0-9]{8})$/.exec(body);
        if(cmd){
          const entry=memeLibrary.mark(cmd[2],cmd[1]==='收藏'?'approved':'disabled',scope);
          await reply(`${entry.id} ${entry.title} 已${cmd[1]}，仅影响当前会话的当前角色。`);
        }else if(/^添加\s+/.test(body)){
          const fields=body.slice(3).split('|').map(x=>x.trim());
          if(fields.length!==3)throw Error('格式：/梗库 添加 标题 | 含义 | 用法');
          const entry=memeLibrary.add({title:fields[0],meaning:fields[1],usage:fields[2]},scope);
          await reply(`已保存候选 ${entry.id}。确认后用 /梗库 收藏 ${entry.id} 启用。`);
        }else if(/^采集\s+/.test(body)){
          const bvid=parseBvid(body.slice(3));
          const info=biliView(await biliReader.read(bvid),'info');
          if(!manage())return{handled:true};
          let comments={comments:[]};try{comments=biliView(await biliReader.read(bvid,'comments'),'comments');}catch{/* Lower evidence level remains in source records. */}
          const evidence=sourceRecords(info,comments);
          if(!manage())return{handled:true};
          if(!evidence.length)throw Error('该视频没有可用于提取的文字');
          const extracted=validateCandidates(await extractCandidates(evidence),evidence);
          if(!manage())return{handled:true};
          const entries=memeLibrary.addMany(extracted.map(c=>({...c,bvid})),scope);
          await reply(entries.length?'已保存待确认的候选（含义与用法为模型提议）：\n'+entries.map(e=>`${e.id} ${e.title}\n/梗库 收藏 ${e.id}`).join('\n'):'未找到有原文依据的表达素材，没有保存。');
        }else throw Error('用 /梗库 帮助 查看格式');
      }
    }catch(error){await reply(String(error?.message||'读取未完成').slice(0,250));}
    return{handled:true};
  }
  return{handle(event){
    const parsed=extractAdminText(event.segments,getSelfId());if(!parsed)return Promise.resolve({handled:false});
    let match=/^\/(B站|梗库)(?=$|\s)([\s\S]*)$/iu.exec(parsed.text);
    if(!match&&parsed.mentioned){
      const natural=/^B站(?:搜|搜索)\s*(.+)$/iu.exec(parsed.text);
      if(natural)match=['','B站','搜索 '+natural[1]];
    }
    if(!match)return Promise.resolve({handled:false});
    if(!access.canRead(event))return Promise.resolve({handled:true});
    if(queued>=4){return Promise.resolve({handled:true});}
    queued++;
    const result=tail.then(()=>run(event,match)).finally(()=>{queued--;});tail=result.catch(()=>{});return result;
  }};
}
