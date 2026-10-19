const listed=(items,id)=>Array.isArray(items)&&items.map(String).includes(String(id));
export function createCommunityAccess({getConfig,ownerConsole,groupAllowed}){
  function context(event){return{chatKey:`private:${event.senderId}`,triggerEntries:[{senderId:String(event.senderId),text:'/梗库',ownerConsoleText:'/梗库'}]};}
  function canRead(event,{search=false}={}){
    const cfg=getConfig(),{chatKey,senderId}=event;
    if(cfg.communityFeatures?.enabled!==true||!/^\d{1,15}$/.test(String(senderId)))return false;
    if(search&&cfg.webSearch?.enabled===false)return false;
    if(listed(cfg.globalBlocklist,senderId)&&!listed(cfg.communityExemptions,senderId))return false;
    if(/^private:[1-9]\d{0,14}$/.test(chatKey))return chatKey===`private:${senderId}`&&ownerConsole.authorized(context(event));
    const match=/^group:([1-9]\d{0,14})$/.exec(chatKey);
    if(!match||!groupAllowed(cfg,match[1])||listed(cfg.blocklist?.[match[1]],senderId))return false;
    return cfg.harnessControl?.readForMembers===true||ownerConsole.authorized(context(event),{groupId:match[1]});
  }
  function canManage(event){
    if(!canRead(event))return false;
    return ownerConsole.authorized(context(event),event.chatKey.startsWith('group:')?{groupId:event.chatKey.slice(6)}:{});
  }
  return{canRead,canManage};
}
