import {SocialState} from './social-state.mjs';
import {isAutomatedPeer} from './bot-interaction.mjs';
import {modelInputAllowed} from './input-guard.mjs';

export const SOCIAL_FEEDBACK_SCHEMA={type:'object',additionalProperties:false,properties:{
  event:{type:'string',enum:['welcome','play','comfort','repair','correction','stop']},
  messageId:{type:['string','integer'],description:'本次触发消息#后的平台消息编号，不是本地序号；通常不含#'},
  quote:{type:'string',minLength:2,maxLength:100,description:'对方实际输入的连续短原文；不用引用、图片描述或系统标记'}
},required:['event','messageId','quote']};
const DIRECT_STOP=/^(?:请)?(?:别再回复我了|不要再回复我了|别说了|不要再说了|别戳我了|不要再戳我了|闭嘴|安静|停聊)[。！!\s]*$/u;
const uid=value=>/^[1-9]\d{0,14}$/.test(String(value??''));
const group=key=>String(key).startsWith('group:');
export function socialPolicy(config){return config?.socialBehavior?.enabled===true;}
export function permitsDirectPeer(config,chatKey,entry){
  return socialPolicy(config)&&config.socialBehavior.allowDirectPeers===true&&group(chatKey)&&entry?.atMe===true;
}

// Hosts supply structural addressing. The model decides ambiguous social intent
// in its normal reply turn; no extra classifier and no emotion keyword guessing.
export class SocialRuntime{
  constructor({getConfig,roleIdentity,filePath=null,now=Date.now,onError=()=>{}}){
    Object.assign(this,{getConfig,roleIdentity,filePath,now,onError});this.peerDeliveries=new Map();this.state=null;this.failed=false;
  }
  enabled(){return socialPolicy(this.getConfig())&&!this.failed;}
  scope(chatKey){return{chatKey,roleScope:this.roleIdentity(this.getConfig(),chatKey).scope};}
  _state(){
    if(!this.state&&!this.failed)try{this.state=new SocialState({filePath:this.filePath,now:this.now});}
    catch{this.failed=true;this.onError('社交状态不可读，已停用此功能；原文件保留');}
    return this.state;
  }
  directed(chatKey,entry,store){
    return !group(chatKey)||entry?.atMe===true||store?.findByMid?.(chatKey,entry?.reply?.mid)?.self===true;
  }
  admit(chatKey,entry,store){
    try{return this._admit(chatKey,entry,store);}catch{this.failed=true;this.onError('社交状态写入失败，功能已停用；原文件保留');return{allow:false,reason:'state_error'};}
  }
  _admit(chatKey,entry,store){
    if(!socialPolicy(this.getConfig())||!entry)return{allow:true,reason:'disabled'};
    if(!modelInputAllowed(entry))return{allow:false,reason:'excluded'};
    const direct=this.directed(chatKey,entry,store);
    if(!direct&&Array.isArray(entry.atUserIds)&&entry.atUserIds.length)return{allow:false,reason:'addressed_elsewhere'};
    const peer=isAutomatedPeer(this.getConfig(),chatKey,entry.senderId)||entry.automatedPeer===true;
    if(peer){
      if(this.failed||!permitsDirectPeer(this.getConfig(),chatKey,entry))return{allow:false,reason:'peer_not_direct'};
      const key=JSON.stringify(this.scope(chatKey)),last=this.peerDeliveries.get(key);
      if(last!=null&&this.now()-last<300000)return{allow:false,reason:'peer_cooldown'};
      return{allow:true,reason:'bounded_peer'};
    }
    const state=uid(entry.senderId)?this._state():null;
    // Exact stop only, from this person's own typed text addressed to us.
    if(direct&&typeof entry.directText==='string'&&DIRECT_STOP.test(entry.directText.trim())){
      state?.apply(this.scope(chatKey),String(entry.senderId),{event:'stop',id:'stop-'+String(entry.id)});
      return{allow:false,reason:'explicit_stop'};
    }
    if(!state)return{allow:direct,reason:'state_unavailable'};
    if(!direct&&state.snapshot(this.scope(chatKey),String(entry.senderId)).inBoundary)return{allow:false,reason:'boundary'};
    return{allow:true,reason:direct?'direct':'ambient'};
  }
  hint(chatKey,entries){
    if(!this.enabled())return'';
    const last=entries.at(-1),state=uid(last?.senderId)?this._state():null;
    const mood=state&&!isAutomatedPeer(this.getConfig(),chatKey,last.senderId)&&last.automatedPeer!==true
      ?state.format(this.scope(chatKey),String(last.senderId)):'';
    return [mood,'先辨认谁对谁说话、引用与实际正文；不替别人答，不为每条消息找任务。表情可只是社交动作，无须翻译；没读取实际图像就不编画面。',
      '先接本轮一个具体细节，再决定普通回答、反串、猫式撒娇、一个表情、拍一下或finish。对方真叫停就收住；假生气只有被接住才继续，不连续补刀或解说笑点。',
      '当前角色为猫娘时，猫耳、尾巴、猫爪、小鱼干、罐头、傲娇和温柔保留为小心思；其他角色沿用自己的设定，不强套猫身份。共同经历用现有记忆，临时玩笑不存成对方事实。',
      '有确凿互动转折时，可在send_message/send_sticker/send_face或finish中附一次socialFeedback，需引用本次对方实际原文；这是候选感受，别为刷状态调用。已确认AI只偶尔接一次，随后结束，不因口吻猜真人是AI。'].filter(Boolean).join('\n');
  }
  feedback(ctx,args){
    if(!this.enabled()||!args||ctx.socialFeedbackUsed)return false;
    if(ctx.signal?.aborted||ctx.communityRoleScope!==this.scope(ctx.chatKey).roleScope)return false;
    const messageId=String(args.messageId??'').trim().replace(/^#/,'');
    const e=ctx.triggerEntries.find(e=>e.mid!=null&&String(e.mid)===messageId);
    if(!e||!uid(e.senderId)||e.self||!modelInputAllowed(e)||isAutomatedPeer(this.getConfig(),ctx.chatKey,e.senderId)||e.automatedPeer===true)return false;
    if(!this.directed(ctx.chatKey,e,ctx.store)||typeof e.directText!=='string'||typeof args.quote!=='string'
      ||args.quote.length<2||args.quote.length>100||!e.directText.includes(args.quote))return false;
    if(!SOCIAL_FEEDBACK_SCHEMA.properties.event.enum.includes(args.event))return false;
    const state=this._state();if(!state)return false;
    // Never save quotes or free-form interpretations in the state store.
    state.apply(this.scope(ctx.chatKey),String(e.senderId),{event:args.event,id:'message-'+String(e.id)});
    ctx.socialFeedbackUsed=true;return true;
  }
  delivered(chatKey,entries){
    if(!this.enabled()||!entries.some(e=>isAutomatedPeer(this.getConfig(),chatKey,e.senderId)||e.automatedPeer===true))return;
    const key=JSON.stringify(this.scope(chatKey));this.peerDeliveries.set(key,this.now());
    for(const[k,t]of this.peerDeliveries)if(this.now()-t>3600000)this.peerDeliveries.delete(k);
    while(this.peerDeliveries.size>512)this.peerDeliveries.delete(this.peerDeliveries.keys().next().value);
  }
}
