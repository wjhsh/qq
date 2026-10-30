import {SocialState,SOCIAL_OUTCOMES} from './social-state.mjs';
import {isAutomatedPeer} from './bot-interaction.mjs';
import {modelInputAllowed} from './input-guard.mjs';
import {HumorKnowledge} from './humor-knowledge.mjs';

export const SOCIAL_FEEDBACK_SCHEMA={type:'object',additionalProperties:false,properties:{
  event:{type:'string',enum:['welcome','play','comfort','repair','correction','stop']},
  messageId:{type:['string','integer'],description:'本次触发消息#后的平台消息编号，不是本地序号；通常不含#'},
  quote:{type:'string',minLength:2,maxLength:100,description:'对方实际输入的连续短原文；不用引用、图片描述或系统标记'}
},required:['event','messageId','quote']};
const DIRECT_STOP=/^(?:请)?(?:别再回复我了|不要再回复我了|别说了|不要再说了|别戳我了|不要再戳我了|闭嘴|安静|停聊)[。！!\s]*$/u;
const uid=value=>/^[1-9]\d{0,14}$/.test(String(value??''));
const group=key=>String(key).startsWith('group:');
export function socialPolicy(config){return config?.socialBehavior?.enabled===true;}
export function phase2Policy(config){return socialPolicy(config)&&config?.socialBehavior?.phase2?.enabled===true;}
export function socialFeedbackSchema(config){
  if(!phase2Policy(config)||config.socialBehavior.phase2.interactionTrace!==true)return SOCIAL_FEEDBACK_SCHEMA;
  return{...SOCIAL_FEEDBACK_SCHEMA,properties:{...SOCIAL_FEEDBACK_SCHEMA.properties,outcome:{type:'string',enum:SOCIAL_OUTCOMES,
    description:'可选、可错的互动转折候选：接住/没接住/存疑/被安慰/小让步。仅本人本轮明确对你说的原文支持时填写，不根据表情占位、沉默或群聊热闹猜心理。'}}};
}
export function permitsDirectPeer(config,chatKey,entry){
  return socialPolicy(config)&&config.socialBehavior.allowDirectPeers===true&&group(chatKey)&&entry?.atMe===true;
}

// A single addressed human owns the batch; ambiguous group activity owns none.
export function socialRunOwner(runtime,chatKey,entries,store){
  if(!Array.isArray(entries))return null;
  const direct=new Set(),people=new Set(),cfg=runtime?.getConfig?.();
  for(const e of entries){
    if(!e||e.self||!uid(e.senderId)||!modelInputAllowed(e)
      ||e.automatedPeer===true||isAutomatedPeer(cfg,chatKey,e.senderId))continue;
    const id=String(e.senderId);people.add(id);
    if(runtime?.directed(chatKey,e,store))direct.add(id);
  }
  if(direct.size)return direct.size===1?[...direct][0]:null;
  return people.size===1?[...people][0]:null;
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
  hint(chatKey,entries,store){
    if(!this.enabled())return'';
    const owner=socialRunOwner(this,chatKey,entries,store),state=owner?this._state():null;
    const phase2=phase2Policy(this.getConfig());
    const mood=state?state.format(this.scope(chatKey),owner,phase2?{compact:true,trace:this.getConfig().socialBehavior.phase2.interactionTrace===true}:undefined):'';
    const focus=phase2?(owner?`本批唯一互动对象：QQ:${owner}。这不表示其他人也在同一话题。`:'本批无唯一互动对象；不借最后发言的人推定关系或情绪。'):'';
    return [focus,mood,'先辨认谁对谁说话、引用与实际正文；不替别人答，不为每条消息找任务。表情可只是社交动作，无须翻译；没读取实际图像就不编画面。',
      '先接本轮一个具体细节，再决定普通回答、反串、猫式撒娇、一个表情、拍一下或finish。对方真叫停就收住；假生气只有被接住才继续，不连续补刀或解说笑点。',
      '当前角色为猫娘时，猫耳、尾巴、猫爪、小鱼干、罐头、傲娇和温柔保留为小心思；其他角色沿用自己的设定，不强套猫身份。共同经历用现有记忆，临时玩笑不存成对方事实。',
      '有确凿互动转折时，可在send_message/send_sticker/send_face或finish中附一次socialFeedback，需引用本次对方实际原文；这是候选感受，别为刷状态调用。已确认AI只偶尔接一次，随后结束，不因口吻猜真人是AI。',
      phase2?'只有此人明确对你说的本轮原文才作反馈证据；环境热闹、成功发消息或沉默都不等于接住玩笑。outcome只是你对互动转折的可错候选，不是对方心理事实。本人继续同一场景反击可玩；困惑时先给退路，认真问题转正常帮忙。':'',
      phase2?'图片/表情的编号、文件名和占位符不提供视觉事实，是否已见以实际图像消息为准。表情、回拍、短确认或沉默均可独立收尾，不为它们补解说；自己的偏好可以流露，但不妨碍任务。':''].filter(Boolean).join('\n');
  }
  feedback(ctx,args){
    if(!ctx||typeof ctx!=='object')return false;
    const record=(reason,validated=false,applied=false)=>{
      if(ctx.session){
        const s=ctx.session.socialFeedbackStats??={validated:0,applied:0,reasons:{}};
        if(validated)s.validated++;if(applied)s.applied++;
        s.reasons[reason]=(s.reasons[reason]||0)+1;
      }
      return applied;
    };
    if(!this.enabled())return record('disabled');
    if(!args||typeof args!=='object')return record('invalid_args');
    if(ctx.socialFeedbackUsed)return record('already_used');
    if(ctx.signal?.aborted)return record('aborted');
    if(ctx.communityRoleScope!==this.scope(ctx.chatKey).roleScope)return record('scope_mismatch');
    const messageId=String(args.messageId??'').trim().replace(/^#/,'');
    const e=ctx.triggerEntries?.find(e=>e.mid!=null&&String(e.mid)===messageId);
    if(!e)return record('message_not_found');
    if(!uid(e.senderId)||e.self||!modelInputAllowed(e)||isAutomatedPeer(this.getConfig(),ctx.chatKey,e.senderId)||e.automatedPeer===true)return record('invalid_sender');
    if(!this.directed(ctx.chatKey,e,ctx.store))return record('undirected');
    if(typeof e.directText!=='string')return record('original_missing');
    if(typeof args.quote!=='string'||args.quote.length<2||args.quote.length>100||!e.directText.includes(args.quote))return record('invalid_quote');
    if(!SOCIAL_FEEDBACK_SCHEMA.properties.event.enum.includes(args.event))return record('invalid_event');
    const phase2=phase2Policy(this.getConfig());
    if(phase2&&args.outcome!==undefined&&!SOCIAL_OUTCOMES.includes(args.outcome))return record('invalid_outcome');
    const state=this._state();if(!state)return record('state_unavailable');
    ctx.socialFeedbackUsed=true; // One validated proposal, including a budget rejection.
    // Never save quotes or free-form interpretations in the state store.
    try{
      const r=state.apply(this.scope(ctx.chatKey),String(e.senderId),{event:args.event,id:'message-'+String(e.id),
        ...(phase2&&this.getConfig().socialBehavior.phase2.interactionTrace===true&&args.outcome?{outcome:args.outcome}:{})},{receipt:true});
      return record(r.reason,true,r.applied===true);
    }catch{
      this.failed=true;this.onError('社交状态写入失败，功能已停用；原文件保留');
      return record('state_error',true,false);
    }
  }
  knowledgeHint(chatKey,entries,store){
    const cfg=this.getConfig();
    if(!this.enabled()||!phase2Policy(cfg)||cfg.socialBehavior.phase2.humorKnowledge!==true)return'';
    const owner=socialRunOwner(this,chatKey,entries,store);if(!owner)return'';
    const query=entries.filter(e=>String(e.senderId)===owner&&modelInputAllowed(e)).map(e=>e.directText||'').join('\n').slice(0,600);
    if(!query.trim())return'';
    try{
      if(!this.knowledge&&!this.knowledgeFailed)this.knowledge=new HumorKnowledge({now:this.now});
      if(!this.knowledge)return'';
      // Cat-only cards require a host-selected role id, never a user's claim.
      const id=this.roleIdentity(cfg,chatKey).id;
      const key=JSON.stringify(this.scope(chatKey));this.recentMechanisms??=new Map();
      const offered=this.recentMechanisms.get(key),recent=offered&&this.now()-offered.at<600000?offered.ids:[];
      const method=cfg.socialBehavior.phase2.retrieval==='hybrid'?'hybrid':'lexical';
      const cards=this.knowledge.search(query,{method,limit:2,roleKind:id==='hajimi-normal'?'cat':'any',recentIds:recent});
      if(cards.length){this.recentMechanisms.set(key,{at:this.now(),ids:cards.map(c=>c.id)});while(this.recentMechanisms.size>200)this.recentMechanisms.delete(this.recentMechanisms.keys().next().value);}
      return this.knowledge.format(cards);
    }catch{this.knowledgeFailed=true;this.onError('通用幽默知识不可用，已跳过；群内梗与普通聊天保留');return'';}
  }
  delivered(chatKey,entries){
    if(!this.enabled()||!entries.some(e=>isAutomatedPeer(this.getConfig(),chatKey,e.senderId)||e.automatedPeer===true))return;
    const key=JSON.stringify(this.scope(chatKey));this.peerDeliveries.set(key,this.now());
    for(const[k,t]of this.peerDeliveries)if(this.now()-t>3600000)this.peerDeliveries.delete(k);
    while(this.peerDeliveries.size>512)this.peerDeliveries.delete(this.peerDeliveries.keys().next().value);
  }
}
