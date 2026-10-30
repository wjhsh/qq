import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SocialState} from '../qq-agent/src/social-state.mjs';
import {SocialRuntime,socialFeedbackSchema,socialFocusOwner,socialRunOwner} from '../qq-agent/src/social-runtime.mjs';
import {HumorKnowledge,validateKnowledge,mechanismDigest} from '../qq-agent/src/humor-knowledge.mjs';
import {rankMechanisms,tokenize} from '../qq-agent/src/humor-retrieval.mjs';
const S={chatKey:'group:12345',roleScope:'hajimi-normal:one'},U='23456';
const message={id:1,mid:11,senderId:U,atMe:true,directText:'给你摸摸头，别委屈啦',text:'给你摸摸头，别委屈啦'};
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hajimi-phase2-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let clock=1793336400000;
  const cfg={socialBehavior:{enabled:true,phase2:{enabled:true,interactionTrace:true,humorKnowledge:true,retrieval:'hybrid'}},botInteraction:{enabled:true,userIds:['34567']}};
  const filePath=path.join(directory,'state.json'),runtime=new SocialRuntime({getConfig:()=>cfg,roleIdentity:()=>({id:'hajimi-normal',scope:S.roleScope}),now:()=>clock,filePath});
  return{directory,cfg,runtime,filePath,advance:n=>clock+=n,now:()=>clock,ctx:{chatKey:S.chatKey,communityRoleScope:S.roleScope,triggerEntries:[message],session:{}}};
}

test('receipts distinguish application, replay and positive budget without changing old snapshot API',t=>{
  const f=fixture(t),state=f.runtime._state();
  const first=state.apply(S,U,{event:'comfort',id:'first',outcome:'comforted'},{receipt:true});assert.equal(first.applied,true);
  assert.equal(state.apply(S,U,{event:'comfort',id:'first'},{receipt:true}).reason,'duplicate');
  const refused=state.apply(S,U,{event:'play',id:'budget',outcome:'landed'},{receipt:true});assert.equal(refused.reason,'positive_budget');
  assert.equal(state.interactions(S,U).length,1);f.advance(300001);
  assert.equal(state.apply(S,U,{event:'play',id:'budget'},{receipt:true}).reason,'duplicate');
  assert.equal(typeof state.apply(S,U,{event:'correction',id:'correct'}).confidence,'number');
});

test('causal trace is bounded, expires, reloads and cannot become permanent fact or consent',t=>{
  const f=fixture(t),state=f.runtime._state();
  for(const [i,event,outcome]of [[1,'play','landed'],[2,'correction','missed'],[3,'repair','conceded'],[4,'comfort','comforted']]){
    state.apply(S,U,{event,id:'e'+i,outcome});f.advance(300001);
  }
  assert.deepEqual(state.interactions(S,U).map(x=>x.outcome),['missed','conceded','comforted']);
  const reloaded=new SocialState({filePath:f.filePath,now:f.now});assert.deepEqual(reloaded.interactions(S,U),state.interactions(S,U));
  assert.equal(reloaded.interactions({...S,chatKey:'private:12345'},U).length,0);
  assert.equal(reloaded.interactions({...S,roleScope:'other:one'},U).length,0);
  assert.equal(reloaded.interactions(S,'45678').length,0);
  const bytes=fs.readFileSync(f.filePath,'utf8');assert.ok(!bytes.includes(message.directText));assert.deepEqual(fs.readdirSync(f.directory),['state.json']);
  f.advance(1200001);assert.equal(reloaded.interactions(S,U).length,0);
  assert.match(reloaded.format(S,U,{compact:true,trace:true}),/不是对方情绪、事实、同意或权限/);
});

test('malformed trace preserves original; evidence eviction never leaves a dangling trace',t=>{
  const f=fixture(t),state=f.runtime._state();state.apply(S,U,{event:'correction',id:'initial',outcome:'missed'});
  for(let i=0;i<66;i++)state.apply(S,U,{event:'play',id:'denied'+i});
  assert.equal(state.interactions(S,U).length,0);assert.doesNotThrow(()=>new SocialState({filePath:f.filePath,now:f.now}));
  const raw=JSON.parse(fs.readFileSync(f.filePath));const relation=Object.values(raw.scopes)[0].relations[U];
  relation.trace=[{evidenceId:'unknown',event:'play',outcome:'landed',at:f.now()}];const bytes=JSON.stringify(raw);fs.writeFileSync(f.filePath,bytes);
  assert.throws(()=>new SocialState({filePath:f.filePath,now:f.now}),/Invalid persisted interaction/);assert.equal(fs.readFileSync(f.filePath,'utf8'),bytes);
});

test('focus uses the addressed person rather than the last speaker, including real reply lookup',t=>{
  const f=fixture(t),calls=[];f.runtime._state().format=(_s,user)=>{calls.push(user);return'own-state';};
  f.runtime.hint(S.chatKey,[message,{...message,senderId:'45678',atMe:false}]);assert.deepEqual(calls,[U]);
  calls.length=0;const noise=[{...message,atMe:false},{...message,senderId:'45678',atMe:false}];
  const ambient=f.runtime.hint(S.chatKey,noise);assert.equal(calls.length,0);assert.match(ambient,/先辨认/);assert.ok(!ambient.includes('own-state'));
  const quoted=[{...message,atMe:false,reply:{mid:99}},{...message,senderId:'45678',atMe:false}];
  f.runtime.hint(S.chatKey,quoted,{findByMid:(_chat,mid)=>mid===99?{self:true}:null});assert.deepEqual(calls,[U]);
});

test('feedback reports private-free rejection causes and a budget refusal consumes this run proposal',t=>{
  const f=fixture(t),args={event:'comfort',messageId:11,quote:'摸摸头',outcome:'comforted'};
  assert.equal(f.runtime.feedback(f.ctx,{...args,quote:'不存在的原句'}),false);
  assert.equal(f.runtime.feedback(f.ctx,args),true);
  const next={...f.ctx,session:{},socialFeedbackUsed:false,triggerEntries:[{...message,id:2,mid:12}]};
  assert.equal(f.runtime.feedback(next,{...args,messageId:12}),false);assert.equal(next.socialFeedbackUsed,true);
  assert.deepEqual(next.session.socialFeedbackStats,{validated:1,applied:0,reasons:{positive_budget:1}});
  assert.equal(f.runtime.feedback(next,{...args,event:'repair',messageId:12}),false);
  assert.equal(next.session.socialFeedbackStats.reasons.already_used,1);
  const serialized=JSON.stringify(f.ctx.session.socialFeedbackStats);assert.ok(!serialized.includes(U)&&!serialized.includes('摸摸头'));
});

test('quoted text, ambient speech, unknown bot style, role changes and aborted runs stay distinct',t=>{
  for(const [patch,expected]of [[{atMe:false},'undirected'],[{directText:''},'invalid_quote'],[{senderId:'34567'},'invalid_sender']]){
    const f=fixture(t);f.ctx.triggerEntries=[{...message,...patch}];assert.equal(f.runtime.feedback(f.ctx,{event:'play',messageId:11,quote:'摸摸头'}),false);assert.equal(f.ctx.session.socialFeedbackStats.reasons[expected],1);
  }
  const f=fixture(t);f.ctx.signal={aborted:true};assert.equal(f.runtime.feedback(f.ctx,{event:'play',messageId:11,quote:'摸摸头'}),false);assert.equal(f.ctx.session.socialFeedbackStats.reasons.aborted,1);
  const g=fixture(t);g.ctx.communityRoleScope='old:one';assert.equal(g.runtime.feedback(g.ctx,{event:'play',messageId:11,quote:'摸摸头'}),false);assert.equal(g.ctx.session.socialFeedbackStats.reasons.scope_mismatch,1);
  assert.equal(g.runtime.admit(S.chatKey,{...message,senderName:'我是AI'}).allow,true);
});

test('phase2 off hides outcomes, trace and knowledge; state failure is observable and preserves chat fallback',t=>{
  const f=fixture(t);f.cfg.socialBehavior.phase2.enabled=false;assert.equal(socialFeedbackSchema(f.cfg).properties.outcome,undefined);
  assert.equal(f.runtime.knowledgeHint(S.chatKey,[message]),'');assert.equal(f.runtime.feedback(f.ctx,{event:'comfort',messageId:11,quote:'摸摸头',outcome:'comforted'}),true);assert.equal(f.runtime._state().interactions(S,U).length,0);
  f.cfg.socialBehavior.phase2.enabled=true;assert.ok(socialFeedbackSchema(f.cfg).properties.outcome);
  const g=fixture(t);g.runtime._state().apply=()=>{throw Error('disk full');};assert.equal(g.runtime.feedback(g.ctx,{event:'comfort',messageId:11,quote:'摸摸头'}),false);
  assert.equal(g.ctx.session.socialFeedbackStats.reasons.state_error,1);assert.equal(g.runtime.admit(S.chatKey,message).allow,true);
  assert.equal(g.runtime.admit(S.chatKey,{...message,atMe:false}).allow,false);
});

test('retrieval ranks individual documents, refuses unrelated inputs, bounds work and is deterministic',()=>{
  const docs=[{id:'a',title:'猫耳罐头',mechanism:'小鱼干罐头',useWhen:'猫耳',cues:['小鱼干']},{id:'b',title:'星系宇宙',mechanism:'月亮星空',useWhen:'太空',cues:['宇宙']}];
  assert.deepEqual(rankMechanisms('小鱼干罐头',docs).map(x=>x.card.id),['a']);
  assert.deepEqual(rankMechanisms('量子泡沫',docs),[]);assert.deepEqual(rankMechanisms('',docs),[]);
  for(const limit of [NaN,Infinity,-3,0])assert.deepEqual(rankMechanisms('罐头',docs,{limit}),[]);
  assert.ok(tokenize('中文'.repeat(20000)+' alpha beta').length<=160);
  assert.deepEqual(rankMechanisms('小鱼干罐头',docs),rankMechanisms('小鱼干罐头',docs.toReversed()));
  assert.throws(()=>rankMechanisms('小鱼干',docs,{method:'unknown'}));
});

test('knowledge requires content review, expiration and proper role; offers no historical dialogue',()=>{
  const file=new URL('../qq-agent/knowledge/humor-mechanisms-v1.json',import.meta.url),doc=JSON.parse(fs.readFileSync(file,'utf8'));
  const library=new HumorKnowledge({now:()=>1793336400000});assert.equal(library.cards.length,12);
  const results=library.search('小鱼干罐头预算',{roleKind:'cat'});assert.ok(results.some(c=>c.id==='M06-cat-self-interest'));
  assert.ok(!library.search('小鱼干罐头预算',{roleKind:'any'}).some(c=>c.id==='M06-cat-self-interest'));
  assert.equal(new HumorKnowledge({now:()=>1900000000000}).search('小鱼干罐头预算',{roleKind:'cat'}).length,0);
  const altered=structuredClone(doc);altered.cards[0].mechanism='替换未审核内容';assert.throws(()=>validateKnowledge(altered),/altered/);
  altered.cards[0].reviewDigest=mechanismDigest(altered.cards[0]);altered.cards[0].status='pending';assert.doesNotThrow(()=>validateKnowledge(altered));
  const research=new Set(fs.readFileSync(new URL('../research/chinese-humor/2026-10-29/cases.jsonl',import.meta.url),'utf8').trim().split('\n').map(s=>JSON.parse(s).id));
  assert.ok(library.cards.every(c=>c.sourceCaseIds.every(id=>research.has(id))));
  assert.ok(!library.hints('摸头申请猫爪印').includes('excerpt'));assert.match(library.hints('摸头申请猫爪印'),/可完全不用/);
});

test('knowledge focus never searches other participants or a poke synthetic description',t=>{
  const f=fixture(t);assert.equal(f.runtime.knowledgeHint(S.chatKey,[{...message,directText:''},{...message,senderId:'45678',atMe:false,directText:'摸头申请猫爪印'}]),'');
  assert.equal(f.runtime.knowledgeHint(S.chatKey,[{...message,isPoke:true,directText:undefined,text:'[拍一拍]猫爪印申请'}]),'');
  assert.ok(f.runtime.knowledgeHint(S.chatKey,[{...message,directText:'摸头申请猫爪印'}]).includes('M03-bureaucratic-wrap'));
});

test('a sole ambient speaker owns their batch but is not automatically talking to the cat',t=>{
  const f=fixture(t),ambient={...message,atMe:false,directText:'摸头申请猫爪印'};
  assert.equal(socialRunOwner(f.runtime,S.chatKey,[ambient]),U);
  assert.equal(socialFocusOwner(f.runtime,S.chatKey,[ambient]),null);
  assert.equal(f.runtime.admit(S.chatKey,ambient).allow,true);
  const hint=f.runtime.hint(S.chatKey,[ambient]);assert.ok(!hint.includes('自身倾向'));assert.ok(!hint.includes('本批明确互动对象：'));
  assert.match(hint,/可自然参与/);assert.equal(f.runtime.knowledgeHint(S.chatKey,[ambient]),'');
  assert.equal(socialFocusOwner(f.runtime,S.chatKey,[message]),U);
});
