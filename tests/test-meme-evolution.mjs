import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {MemeLibrary} from '../qq-agent/src/meme-library.mjs';
import {buildEvidenceWindows,createMemeExtractor} from '../qq-agent/src/meme-extractor.mjs';
import {biliView,sourceRecords,validateCandidates} from '../qq-agent/src/bili-view.mjs';
import {createMemeLearning} from '../qq-agent/src/meme-learning.mjs';
const S={chatKey:'group:12345',roleId:'cat',roleVersion:'cat:one'},BV='BV1eJhv6NEP1';
const ITEM={title:'罐头预算',meaning:'把宏观预算转成猫的零食利益',usage:'对方在轻松聊预算时，不盖过真实财务问题',evidence:'罐头不能少'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hajimi-meme-evo-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return{dir,library:new MemeLibrary({filePath:path.join(dir,'library.json'),now:()=>1000})};}
test('all automatic candidates need explicit approval and same revision to recall',t=>{
  const{library}=fixture(t),e=library.add({...ITEM,automatic:true},S);assert.equal(e.status,'pending');assert.equal(library.search('罐头预算',S).length,0);
  library.mark(e.id,'approved',S);assert.equal(library.search('罐头预算',S).length,1);
  assert.equal(library.search('罐头预算',{...S,roleVersion:'cat:two'}).length,0);
  assert.equal(library.search('罐头预算',{...S,chatKey:'private:12345'}).length,0);
});
test('unreviewed legacy automatic approvals remain quarantined even with legacy callers',t=>{
  const{library}=fixture(t),e=library.add({...ITEM,automatic:true},S);library.state.entries[0].status='approved';
  assert.equal(library.search('罐头',{chatKey:S.chatKey,roleId:S.roleId}).length,0);
  assert.equal(library.search('罐头',S).length,0);library.mark(e.id,'approved',S);assert.equal(library.search('罐头',S).length,1);
});
test('old revision is visible to review, explicitly rebound on approval and deduped per revision',t=>{
  const{library}=fixture(t),e=library.add(ITEM,S),other={...S,roleVersion:'cat:two'};
  assert.equal(library.get(e.id,other).id,e.id);const e2=library.add(ITEM,other);assert.notEqual(e.id,e2.id);
  library.mark(e.id,'approved',other);assert.equal(library.search('罐头',other).length,1);
  library.mark(e.id,'disabled',other);assert.equal(library.add(ITEM,other).status,'disabled');
});
test('provenance fields are bounded and batch validation is atomic; hints carry mechanisms only',t=>{
  const{library}=fixture(t);assert.throws(()=>library.add({...ITEM,provenance:{cookie:'secret'}},S));
  assert.throws(()=>library.addMany([ITEM,{...ITEM,title:'x'.repeat(33)}],S));assert.equal(library.list(S).length,0);
  const e=library.add({...ITEM,mechanism:'角色自利',useWhen:'轻松预算',stopWhen:'真实求助',provenance:{type:'ai_subtitle',locator:'offset:100',contextSummary:'只核字幕'}},S);
  library.mark(e.id,'approved',S);const hints=library.hints('罐头',S);assert.match(hints,/角色自利/);assert.ok(!hints.includes(ITEM.evidence));
});
test('Bili projection preserves thread locators without author identity or account fields',()=>{
  const info=biliView({data_source:'ai_subtitle',video_info:{title:'罐头',subtitle_text:'先说省预算，后说猫的罐头不能少'}});
  const comments=biliView({comments:[{rpid_str:'1234',parent:987,root:321,message:'前后说反了',author:'private',cookie:'secret'}]},'comments');
  assert.equal(comments.comments[0].id,'1234');assert.equal(comments.comments[0].parent,'987');assert.ok(!JSON.stringify(comments).includes('private'));
  const records=sourceRecords(info,comments);assert.ok(records.some(r=>r.type==='ai_subtitle'));assert.ok(records.some(r=>r.locator==='comment:1234:parent:987'));
});
test('overlapping evidence windows retain transitions and never merge separate comments',()=>{
  const records=[{type:'comment',locator:'comment:1',text:'铺'.repeat(95)+'先说不要罐头，然后又把罐头抱走。'+'垫'.repeat(400)},
    {type:'comment',locator:'comment:2',text:'另一位的独立回应'}];
  const windows=buildEvidenceWindows(records);assert.ok(windows.some(w=>w.text.includes('先说不要罐头，然后又把罐头抱走。')));
  assert.ok(windows.every(w=>!w.text.includes('罐头')||!w.text.includes('另一位')));assert.ok(windows.length<=80);
});
test('extractor uses host-selected exact source and stores evidence kind, not model-invented origin',async()=>{
  const extract=createMemeExtractor({getConfig:()=>({api:{model:'gemini-3.8-flash-high'}}),resolveApiKey:()=>'',chatCompletion:async()=>({message:{content:JSON.stringify({candidates:[{...ITEM,evidence:undefined,source_id:0}]})}})});
  const records=[{type:'ai_subtitle',locator:'subtitle',text:ITEM.evidence}],out=await extract(records);
  assert.equal(out.candidates[0].evidence,ITEM.evidence);assert.equal(out.candidates[0].provenance.type,'ai_subtitle');
  assert.equal(validateCandidates(out,records).length,1);
});
test('comments failure saves subtitle-only pending candidates; role changes during call still abort',async t=>{
  const{library,dir}=fixture(t);let version='cat:one';const make=()=>createMemeLearning({filePath:path.join(dir,'attempts-'+version.replace(':','-')+'.json'),
    getConfig:()=>({communityFeatures:{autoLearn:{enabled:true,groupIds:['12345']}}}),roleIdentity:()=>({id:'cat',scope:version}),access:{canRead:()=>true},
    biliReader:{read:async(bv,part)=>{if(part==='comments')throw Error('network');return{data_source:'ai_subtitle',video_info:{title:'预算',subtitle_text:ITEM.evidence}};}},
    memeLibrary:library,extractCandidates:async()=>({candidates:[{...ITEM,provenance:{type:'ai_subtitle',locator:'subtitle'}}]})});
  const out=await make().learn({chatKey:S.chatKey,senderId:'23456'},{bvid:BV},version);assert.equal(out.saved,1);assert.equal(out.commentsUnavailable,true);assert.equal(library.list(S)[0].status,'pending');
  const learner=make();const promise=learner.learn({chatKey:S.chatKey},{bvid:BV},version);version='cat:two';assert.equal((await promise).saved,0);
});

test('hybrid scoped recall keeps review, expiry, version and cue provenance boundaries',t=>{
  const{library}=fixture(t);const item={...ITEM,cues:['金枪鱼配额','摸头申请'],stance:'共同虚构，不形成债务'};
  const e=library.add(item,S);assert.equal(library.search('金枪鱼配额',S,{method:'hybrid'}).length,0);
  library.mark(e.id,'approved',S);assert.equal(library.search('金枪鱼配额',S,{method:'hybrid'})[0].id,e.id);
  for(const context of [{...S,chatKey:'group:99999'},{...S,roleVersion:'cat:two'},{...S,chatKey:'private:12345'}])assert.equal(library.search('金枪鱼配额',context,{method:'hybrid'}).length,0);
  assert.throws(()=>library.add({...item,cues:['x'.repeat(21)]},S));
  const data={candidates:[{...ITEM,cues:['金枪鱼配额'],stance:'演出'}]};assert.equal(validateCandidates(data,ITEM.evidence).length,1);
  assert.throws(()=>validateCandidates({candidates:[{...ITEM,cues:['x'.repeat(21)]}]},ITEM.evidence));
});
