import test from 'node:test';
import assert from 'node:assert/strict';
import {SocialRuntime} from '../qq-agent/src/social-runtime.mjs';
import {incomingPeerPolicy,mayTriggerPeerReply,filterAutomatedHistory} from '../qq-agent/src/bot-interaction.mjs';
const chat='group:12345',entry={id:1,mid:11,senderId:'23456',atMe:true,directText:'好猫，给你小鱼干',text:'好猫，给你小鱼干'};
function fixture(){let time=0;const cfg={socialBehavior:{enabled:true,allowDirectPeers:true},botInteraction:{enabled:true,userIds:['34567']}};
  const runtime=new SocialRuntime({getConfig:()=>cfg,roleIdentity:()=>({scope:'cat:v1'}),now:()=>time});
  return{cfg,runtime,advance:n=>time+=n,ctx:{chatKey:chat,kind:'group',triggerEntries:[entry],communityRoleScope:'cat:v1'}};}
test('addressing is structural; messages to someone else never become cat summons',()=>{
  const f=fixture();assert.equal(f.runtime.admit(chat,{...entry,atMe:false,atUserIds:['45678']}).reason,'addressed_elsewhere');
  assert.equal(f.runtime.admit(chat,{...entry,atMe:false,text:'@哈基米'}).allow,true);
  assert.equal(f.runtime.admit(chat,{...entry,atMe:true,atUserIds:['45678']}).allow,true);
});
test('exact natural stop is honored, quoted or ambiguous pretend anger does not create a hard boundary',()=>{
  const f=fixture();assert.equal(f.runtime.admit(chat,{...entry,directText:'别说了！'}).reason,'explicit_stop');
  assert.equal(f.runtime.admit(chat,{...entry,id:2,atMe:false}).reason,'boundary');
  assert.equal(f.runtime.admit(chat,{...entry,id:3,directText:'这道题怎么做？'}).allow,true);
  const g=fixture();assert.equal(g.runtime.admit(chat,{...entry,directText:'不要停，继续玩'}).allow,true);
  assert.equal(g.runtime.admit(chat,{...entry,directText:'',text:'[引用别人：别说了]'}).allow,true);
});
test('confirmed AI can reply once only when directly addressed; cooldown starts on delivered action',()=>{
  const f=fixture(),bot={...entry,senderId:'34567'};
  assert.equal(f.runtime.admit(chat,bot).allow,true);f.runtime.delivered(chat,[bot]);assert.equal(f.runtime.admit(chat,bot).reason,'peer_cooldown');
  assert.equal(f.runtime.admit(chat,entry).allow,true);f.advance(300001);assert.equal(f.runtime.admit(chat,bot).allow,true);
  assert.equal(f.runtime.admit(chat,{...bot,atMe:false}).allow,false);
});
test('transport marks are authoritative, style and nicknames never classify a human as AI',()=>{
  const f=fixture(),policy=incomingPeerPolicy(f.cfg,chat,{sender:{user_id:'34567'},message:[{type:'at',data:{qq:'77777'}}]},'77777');assert.equal(policy.ignore,false);
  assert.equal(mayTriggerPeerReply(f.cfg,chat,{...entry,senderId:'34567'}),true);
  assert.equal(mayTriggerPeerReply(f.cfg,chat,{...entry,automatedPeer:true,atMe:false}),false);
  assert.equal(filterAutomatedHistory(f.cfg,chat,[{...entry,automatedPeer:true}]).length,0);
  assert.equal(incomingPeerPolicy(f.cfg,chat,{sender:{user_id:'23456',nickname:'我是AI'},message:[]},'77777').knownPeer,false);
});
test('feedback needs current direct original text, current scope and one event per reply run',()=>{
  const f=fixture(),args={event:'comfort',messageId:11,quote:'好猫'};assert.equal(f.runtime.feedback(f.ctx,args),true);assert.equal(f.runtime.feedback(f.ctx,args),false);
  for(const override of [{messageId:999},{quote:'[引用]'},{event:'success'}]){const g=fixture();assert.equal(g.runtime.feedback(g.ctx,{...args,...override}),false);}
  const g=fixture();g.ctx.communityRoleScope='cat:old';assert.equal(g.runtime.feedback(g.ctx,args),false);
});
test('confirmed peers, ambiguous ambient speech and model-excluded text cannot mutate relations',()=>{
  for(const change of [{senderId:'34567'},{atMe:false},{modelExcluded:true}]){
    const f=fixture();f.ctx.triggerEntries=[{...entry,...change}];assert.equal(f.runtime.feedback(f.ctx,{event:'play',messageId:11,quote:'好猫'}),false);
  }
});
test('feature off restores original policy and hides all state hints',()=>{
  const f=fixture();f.cfg.socialBehavior.enabled=false;assert.equal(f.runtime.hint(chat,[entry]),'');
  assert.equal(f.runtime.admit(chat,{...entry,atMe:false,atUserIds:['45678']}).allow,true);
  assert.equal(incomingPeerPolicy(f.cfg,chat,{sender:{user_id:'34567'},message:[]},'77777').ignore,true);
});
