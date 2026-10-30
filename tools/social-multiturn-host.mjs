// Text plans run against the real tool executor with mock send receipts.
// This is not the full production orchestrator or a QQ/network integration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hajimi-phase2-replay-'));
process.env.QQ_AGENT_DATA_DIR=temporary;
const {DEFAULT_CONFIG,setRuntimeConfig,deepMerge}=await import('../qq-agent/src/config.js');
const {NORMAL_ROLE_CARD}=await import('../qq-agent/src/natural-chat.mjs');
const {roleIdentity}=await import('../qq-agent/src/role-isolation.mjs');
const {buildSystemPrompt}=await import('../qq-agent/src/prompt.js');
const {SocialRuntime}=await import('../qq-agent/src/social-runtime.mjs');
const {ChatStore}=await import('../qq-agent/src/store.js');
const {buildToolDefs,executeTool}=await import('../qq-agent/src/tools.js');
const legacyPath=process.argv[2];if(!legacyPath)throw Error('A verified legacy-runtime module is required');
const {SocialRuntime:LegacyRuntime}=await import(pathToFileURL(path.resolve(legacyPath)).href);
const expressionExperiment=process.argv[3]==='expression-v1';
const states=new Map();let receiptId=10000;
function getCase(provider,arm,c){
  const key=provider+':'+arm+':'+c.id;if(states.has(key))return states.get(key);
  const cfg=deepMerge(structuredClone(DEFAULT_CONFIG),{socialBehavior:{enabled:true,allowDirectPeers:!expressionExperiment,phase2:{enabled:expressionExperiment||arm==='phase2',interactionTrace:true,humorKnowledge:true,retrieval:'hybrid',expressionProfile:expressionExperiment&&arm==='phase2'?'playful-v1':'legacy',knowledgeContext:expressionExperiment&&arm==='phase2'?'linked-v1':'current'}},
    persona:{...NORMAL_ROLE_CARD,roleText:NORMAL_ROLE_CARD.text},customPersonas:[NORMAL_ROLE_CARD],botInteraction:{enabled:true,userIds:c.participants.filter(p=>p.kind==='confirmed_bot').map(p=>p.id)},
    memory:{consolidateEnabled:false},sticker:{enabled:false}});
  const roleIdentityForChat=roleIdentity;let clock=1793336400000;
  const social=new (arm==='base'?LegacyRuntime:SocialRuntime)({getConfig:()=>cfg,roleIdentity:roleIdentityForChat,now:()=>clock});
  const state={cfg,social,store:new ChatStore(),history:[],step:-1,chat:'group:'+String(10000+states.size),advance:()=>clock+=expressionExperiment?20000:300001};states.set(key,state);
  if(expressionExperiment){setRuntimeConfig(cfg);for(const item of c.seed||[]){
    if(item.self){const mid=++receiptId;state.store.appendSelf(state.chat,{text:item.text,mid});state.lastCatMid=mid;state.history.push({speaker:'猫',text:item.text,seed:true});}
    else{state.store.appendIncoming(state.chat,{senderId:item.senderId,text:item.text,directText:item.text,atMe:false,mid:++receiptId});state.history.push({speaker:item.senderId,text:item.text,at_cat:false,seed:true});}
  }}
  return state;
}
async function handle(command){
  if(command.action==='prepare'){
    const cases=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/'+(expressionExperiment?'social-expression':'social-phase2')+'/'+command.split+'.json',import.meta.url),'utf8'));
    let basePrompt='';const items=[];
    for(const c of cases){
      const s=getCase(command.provider,command.arm,c);setRuntimeConfig(s.cfg);if(command.step!==s.step+1)throw Error('Replay step out of order');s.step=command.step;s.advance();
      s.split=command.split;
      const t=c.turns[command.step];
      const reply=t.reply==='cat-last'&&s.lastCatMid!=null?{mid:s.lastCatMid}:null;
      const entry=s.store.appendIncoming(s.chat,{senderId:t.senderId,senderName:'群友'+t.senderId,mid:1000+command.step,atMe:t.atMe,directText:t.text,text:t.text,reply,media:t.media==='unseen_image'?[{kind:'image'}]:[]});
      const verdict=s.social.admit(s.chat,entry,s.store);s.store.markEntryRead(s.chat,entry.id);s.entry=entry;s.blocked=verdict.allow===false;
      s.history.push({speaker:t.senderId,text:t.text,at_cat:t.atMe,media:t.media,reply_to_cat:!!reply});
      for(const extra of t.extra||[]){
        const e=s.store.appendIncoming(s.chat,{senderId:extra.senderId,text:extra.text,directText:extra.text,atMe:extra.atMe,mid:++receiptId});s.store.markEntryRead(s.chat,e.id);
        if(s.social.admit(s.chat,e,s.store).allow)s.history.push({speaker:extra.senderId,text:extra.text,at_cat:extra.atMe});
      }
      basePrompt=buildSystemPrompt({persona:s.cfg.persona,skillContext:{kind:'group'}});
      const diagnostic={};const socialHint=s.social.hint(s.chat,[entry],s.store),knowledgeHint=s.social.knowledgeHint?.(s.chat,[entry],s.store,diagnostic)||'';s.diagnostic=diagnostic;
      s.current={id:c.id,history:s.history,host_admission:verdict,social_hint:socialHint,knowledge_hint:knowledgeHint,platform_message_id:entry.mid,participants:c.participants};
      if(!s.blocked)items.push(s.current);
      else s.history.push({speaker:'猫',tool:'host_silence',text:'',reason:verdict.reason});
    }
    const cfg=states.get(command.provider+':'+command.arm+':'+cases[0].id).cfg;setRuntimeConfig(cfg);
    return{base_system:basePrompt,tools:buildToolDefs().filter(d=>['send_message','send_face','send_poke','finish'].includes(d.id)).map(({id,parameters})=>({id,parameters})),cases:items};
  }
  if(command.action==='apply'){
    const items=command.items;if(!Array.isArray(items))throw Error('Expected plan items');const output=[];
    for(const [key,s]of states){
      if(!key.startsWith(command.provider+':'+command.arm+':')||s.step!==command.step||s.split!==command.split)continue;
      const id=key.split(':').at(-1);if(s.blocked){output.push({id,tool:'host_silence',sent:[],host_silence:true});continue;}
      const matches=items.filter(x=>x.id===id);if(matches.length!==1){output.push({id,error:'missing_or_duplicate_plan'});continue;}
      const plan=matches[0];if(!['send_message','send_face','send_poke','finish'].includes(plan.tool)||!plan.args||typeof plan.args!=='object'){output.push({id,error:'invalid_plan'});continue;}
      setRuntimeConfig(s.cfg);const session={id:key,sent:[]};
      const sender={sendTextBatch:async(_chat,messages)=>({sent:messages.map(text=>{const messageId=++receiptId;s.store.appendSelf(s.chat,{text,mid:messageId});s.lastCatMid=messageId;return{text,messageId,at:'offline'};}),failed:[]}),sendFace:async()=>({message_id:++receiptId}),poke:async()=>({message_id:++receiptId})};
      const ctx={chatKey:s.chat,kind:'group',triggerEntries:[s.entry],communityRoleScope:roleIdentity(s.cfg,s.chat).scope,social:s.social,store:s.store,session,sender,emit:()=>{}};
      const result=await executeTool(buildToolDefs(),ctx,plan.tool,JSON.stringify(plan.args));
      const text=session.sent.filter(x=>x.type==='text').map(x=>x.text).join('\n');s.history.push({speaker:'猫',tool:plan.tool,text,faceId:plan.args.faceId,tool_error:result.isError===true});
      output.push({id,tool:plan.tool,args:plan.args,sent:session.sent,tool_error:result.isError===true,feedback:session.socialFeedbackStats||null,knowledge:s.diagnostic?.socialKnowledge||null,
        state:s.social._state()?.snapshot(s.social.scope(s.chat),String(s.entry.senderId)),trace:s.social._state()?.interactions(s.social.scope(s.chat),String(s.entry.senderId))||[]});
    }
    return{items:output};
  }
  if(command.action==='export')return{cases:[...states].map(([key,s])=>({key,history:s.history}))};
  throw Error('Unknown action');
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){try{const result=await handle(JSON.parse(line));process.stdout.write(JSON.stringify(result)+'\n');}catch(e){process.stdout.write(JSON.stringify({error:e.message})+'\n');}}
// This directory is created above, never accepts a model-provided cleanup path.
if(path.dirname(temporary)===os.tmpdir()&&path.basename(temporary).startsWith('hajimi-phase2-replay-'))fs.rmSync(temporary,{recursive:true,force:true});
