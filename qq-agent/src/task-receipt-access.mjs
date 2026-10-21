const listed=(items,id)=>Array.isArray(items)&&items.map(String).includes(String(id));
export function createTaskReceiptAccess({getConfig,ownerConsole,groupAllowed,isConnected,isSilenced,scopeForJob}){
  return item=>{
    const cfg=getConfig(),ctx={chatKey:`private:${item.senderId}`,triggerEntries:[{senderId:item.senderId,text:'/任务',ownerConsoleText:'/任务'}]};
    if(!ownerConsole.authorized(ctx))return'deny';
    if(item.includeResult===true){
      // GPT summaries are private, but revoking the original group also revokes
      // delivery. Ordinary group task receipts still require their saved scope.
      if(item.command!=='/GPT'||item.chatKey!==ctx.chatKey||typeof item.sourceChatKey!=='string')return'deny';
      if(item.sourceChatKey.startsWith('group:')){
        const gid=item.sourceChatKey.slice(6);
        if(!/^[1-9]\d{0,14}$/.test(gid)||!groupAllowed(cfg,gid)
          ||!ownerConsole.authorized(ctx,{groupId:gid})||listed(cfg.blocklist?.[gid],item.senderId))return'deny';
        if(isSilenced(cfg,item.sourceChatKey))return'hold';
      }else if(item.sourceChatKey!==ctx.chatKey)return'deny';
    }
    if(item.chatKey.startsWith('group:')){
      const gid=item.chatKey.slice(6);
      if(!groupAllowed(cfg,gid)||!ownerConsole.authorized(ctx,{groupId:gid})||scopeForJob(item.jobId)!==item.chatKey)return'deny';
      if(listed(cfg.blocklist?.[gid],item.senderId))return'deny';
      if(isSilenced(cfg,item.chatKey))return'hold';
    }else if(item.chatKey!==`private:${item.senderId}`)return'deny';
    return isConnected()?'allow':'hold';
  };
}
