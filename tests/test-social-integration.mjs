import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hajimi-social-integration-'));
process.env.QQ_AGENT_DATA_DIR=directory;
const {DEFAULT_CONFIG,deepMerge,setRuntimeConfig,getConfig}=await import('../qq-agent/src/config.js');
const {ChatStore}=await import('../qq-agent/src/store.js');
const {MemoryStore}=await import('../qq-agent/src/memory.js');
const {SessionRegistry}=await import('../qq-agent/src/sessions.js');
const {Orchestrator}=await import('../qq-agent/src/orchestrator.js');
const {SocialRuntime}=await import('../qq-agent/src/social-runtime.mjs');
const {roleIdentity}=await import('../qq-agent/src/role-isolation.mjs');
const {buildToolDefs,executeTool,FINISH_AFTER_SEND_RECEIPT}=await import('../qq-agent/src/tools.js');
const {NORMAL_ROLE_CARD}=await import('../qq-agent/src/natural-chat.mjs');
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
function config(patch={}){setRuntimeConfig(deepMerge(structuredClone(DEFAULT_CONFIG),{api:{model:'offline-test',apiKey:'fixture-key',maxRounds:3},sticker:{enabled:false},persona:{roleText:NORMAL_ROLE_CARD.text},socialBehavior:{enabled:true,allowDirectPeers:true},memory:{enabled:false},...patch}));}
function runtime(){return new SocialRuntime({getConfig,roleIdentity});}
test('real ingress to store to orchestrator skips exact stops and other-user @ without an LLM request',()=>{
  config();const store=new ChatStore(),orchestrator=new Orchestrator({store,memory:new MemoryStore(),sessions:new SessionRegistry(),sender:{},onebot:{selfId:'77777'}});orchestrator.social=runtime();
  let wakes=0;orchestrator.scheduleWake=()=>wakes++;
  for(const props of [{atMe:false,atUserIds:['34567'],directText:'帮我看一下'},{atMe:true,directText:'别说了！'}]){
    const e=store.appendIncoming('group:12345',{senderId:'23456',mid:Math.random()*1000|0,text:props.directText,...props});
    orchestrator.onIncoming('group:12345',e);assert.equal(store.unreadCount('group:12345'),0);
  }
  assert.equal(wakes,0);
});
test('actual tool execution records feedback once and media finish requires a real successful receipt',async()=>{
  config();const defs=buildToolDefs(),scope=roleIdentity(getConfig(),'group:12345').scope;
  const e={id:1,mid:123,senderId:'23456',atMe:true,directText:'猫猫真棒'};
  const ctx={chatKey:'group:12345',kind:'group',triggerEntries:[e],communityRoleScope:scope,social:runtime(),session:{id:'test',sent:[]},emit:()=>{},sender:{sendFace:async()=>({message_id:456})}};
  const out=await executeTool(defs,ctx,'send_face',JSON.stringify({faceId:178,finishAfterSend:true,socialFeedback:{event:'welcome',messageId:123,quote:'猫猫真棒'}}));
  assert.equal(out[FINISH_AFTER_SEND_RECEIPT],true);assert.equal(ctx.socialFeedbackUsed,true);assert.equal(ctx.session.sent.length,1);
  ctx.sender.sendFace=async()=>{throw Error('failed')};const failed=await executeTool(defs,ctx,'send_face','{"faceId":178,"finishAfterSend":true}');
  assert.equal(failed.isError,true);assert.notEqual(failed[FINISH_AFTER_SEND_RECEIPT],true);
});
test('stop cancels only this sender current interaction and leaves another sender task running',()=>{
  config();const store=new ChatStore(),orchestrator=new Orchestrator({store,memory:new MemoryStore(),sessions:{get:()=>({trigger:[{senderId:'23456'}]})},sender:{},onebot:{selfId:'77777'}});
  orchestrator.social=runtime();orchestrator.activeRuns.set('group:12345','active');let cancelled=0;orchestrator.preparePersonaSwitch=()=>cancelled++;
  const add=senderId=>store.appendIncoming('group:12345',{senderId,mid:456,text:'别说了',directText:'别说了',atMe:true});
  orchestrator.onIncoming('group:12345',add('34567'));assert.equal(cancelled,0);
  orchestrator.onIncoming('group:12345',add('23456'));assert.equal(cancelled,1);
});
test('a group poke cannot follow a crowd toward a third person; direct playful contact remains possible',async()=>{
  config();const defs=buildToolDefs();let pokes=0;const ctx={chatKey:'group:12345',kind:'group',social:runtime(),triggerEntries:[{senderId:'23456',atMe:false,directText:'大家都来戳他'}],session:{sent:[]},sender:{poke:async()=>{pokes++;}},store:{}};
  assert.equal((await executeTool(defs,ctx,'send_poke','{"targetUserId":"45678"}')).isError,true);assert.equal(pokes,0);
  ctx.triggerEntries=[{senderId:'23456',atMe:true,directText:'戳我试试'}];assert.notEqual((await executeTool(defs,ctx,'send_poke','{"targetUserId":"23456"}')).isError,true);assert.equal(pokes,1);
  assert.equal((await executeTool(defs,ctx,'send_poke','{"targetUserId":"23456"}')).isError,true);
});
test('full orchestrator with local fake upstream ends after one successful face call, preserving cat card',async t=>{
  let requests=0,prompt;const server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests++;prompt=body.messages;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'call-face',type:'function',function:{name:'send_face',arguments:'{"faceId":178,"finishAfterSend":true}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:10}}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  config({api:{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'fixture-only',model:'offline-test',maxRounds:3,timeoutMs:3000}});
  const store=new ChatStore(),sessions=new SessionRegistry(),chat='private:54321';
  const orchestrator=new Orchestrator({store,memory:new MemoryStore(),sessions,sender:{sendFace:async()=>({message_id:654})},onebot:{selfId:'77777',selfNickname:'哈基米'}});orchestrator.social=runtime();
  store.appendIncoming(chat,{mid:789,senderId:'54321',directText:'给个表情就行',text:'给个表情就行'});
  await orchestrator.wake(chat);
  assert.equal(requests,1);assert.ok(prompt[0].content.includes('猫耳和尾巴'));assert.ok(prompt[0].content.includes('当前互动节奏'));
  const latest=sessions.get(sessions.listSummaries()[0].id);assert.equal(latest.status,'done');assert.match(latest.finishReason,/交付/);sessions.flushIndexCache();
});
