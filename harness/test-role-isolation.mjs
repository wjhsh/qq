import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-isolation-'));
process.env.QQ_AGENT_DATA_DIR = temporary;
const base = '/opt/codex-qq/QQ-agent/src/';
const { setRuntimeConfig, getConfig } = await import(base + 'config.js');
const { roleIdentity, groupStyleForChat, groupStylePatch, filterRoleHistory } = await import(base + 'role-isolation.mjs');
const { roleCardPatch } = await import(base + 'role-card-library.js');
const { buildPastState, buildUserPrompt, buildSystemPrompt } = await import(base + 'prompt.js');
const { ChatStore } = await import(base + 'store.js');
const { buildToolDefs } = await import(base + 'tools.js');
const cards = [
  {id:'cat',name:'Cat',text:'CAT_ROLE_SENTINEL',customRules:'CAT_CUSTOM_SENTINEL',systemPromptOverride:'',participation:'medium'},
  {id:'penguin',name:'Penguin',text:'PENGUIN_ROLE_SENTINEL',customRules:'PENGUIN_CUSTOM_SENTINEL',systemPromptOverride:'',participation:'medium'}
];
function fixture() {
  const cfg = {roleIsolation:{enabled:true},personaUnified:false,customPersonas:structuredClone(cards),api:{model:'model-a'},
    persona:{roleText:cards[0].text,customRules:cards[0].customRules,botName:'QQ_ACCOUNT',participation:'medium',systemPromptOverride:''},
    personaByChat:{'group:99':{roleCardId:'penguin',roleText:cards[1].text,customRules:cards[1].customRules,participation:'medium',systemPromptOverride:''}},
    ownerConsole:{groupStyles:{99:'LEGACY_CAT_STYLE'},groupStyleRoles:{99:'cat'},groupStylesByRole:{99:{cat:'LEGACY_CAT_STYLE'}}},
    store:{historyCount:80,promptAnchor:{enabled:true,maxExtraRead:5}},sharedMemory:{enabled:false},sticker:{enabled:false},webSearch:{enabled:false}};
  setRuntimeConfig(cfg);return cfg;
}
function merge(a,b){for(const[k,v]of Object.entries(b)){if(k==='__replace__')throw Error('Unexpected root replace');
  if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.hasOwn(v,'__replace__'))a[k]=structuredClone(v.__replace__);
  else if(v&&typeof v==='object'&&!Array.isArray(v))merge(a[k]??={},v);else a[k]=v;}}

test('legacy cat style is not injected into a penguin or a different group',()=>{
  const cfg=fixture();assert.equal(groupStyleForChat(cfg,'group:99'),'');
  assert.equal(groupStyleForChat(cfg,'group:98'),'');
  merge(cfg,roleCardPatch(cfg,'group:99','cat'));
  assert.equal(groupStyleForChat(cfg,'group:99'),'LEGACY_CAT_STYLE');
});
test('new preferences bind to one group and one role; empty preference does not resurrect legacy style',()=>{
  const cfg=fixture();merge(cfg,groupStylePatch(cfg,'99','PENGUIN_STYLE'));
  assert.equal(groupStyleForChat(cfg,'group:99'),'PENGUIN_STYLE');
  merge(cfg,roleCardPatch(cfg,'group:99','cat'));assert.equal(groupStyleForChat(cfg,'group:99'),'LEGACY_CAT_STYLE');
  merge(cfg,groupStylePatch(cfg,'99',''));assert.equal(groupStyleForChat(cfg,'group:99'),'');
  assert.equal(groupStyleForChat(cfg,'private:99'),'');
  merge(cfg,roleCardPatch(cfg,'group:99','penguin'));assert.equal(groupStyleForChat(cfg,'group:99'),'PENGUIN_STYLE');
});
test('API changes preserve RP scope; editing a card changes the self-dialogue scope',()=>{
  const cfg=fixture(),first=roleIdentity(cfg,'group:99');cfg.api.model='model-b';
  assert.deepEqual(roleIdentity(cfg,'group:99'),first);
  cfg.personaByChat['group:99'].roleText+=' edited';
  assert.notEqual(roleIdentity(cfg,'group:99').scope,first.scope);
});
test('raw records persist but RP context excludes legacy and other-role self messages',()=>{
  const cfg=fixture(),store=new ChatStore(),key='group:99';
  store.appendIncoming(key,{senderId:'42',senderName:'Member',text:'HUMAN_FACT',ts:1});
  const penguin=store.appendSelf(key,{text:'PENGUIN_OWN',ts:2});
  assert.equal(penguin.personaScope,roleIdentity(cfg,key).scope);
  merge(cfg,roleCardPatch(cfg,key,'cat'));store.appendSelf(key,{text:'CAT_OWN',ts:3});
  merge(cfg,roleCardPatch(cfg,key,'penguin'));
  const visible=buildPastState(store,key).text;
  assert.match(visible,/HUMAN_FACT/);assert.match(visible,/PENGUIN_OWN/);assert.doesNotMatch(visible,/CAT_OWN/);
  assert.equal(store.recent(key,{limit:100}).length,3);
  assert.equal(filterRoleHistory(cfg,key,[{self:true,text:'LEGACY_OWN'},{self:false,text:'human'}]).length,1);
});
test('history retrieval tool cannot reintroduce old-role self dialogue',async()=>{
  const cfg=fixture();const scope=roleIdentity(cfg,'group:99').scope;
  const records=[{self:true,text:'OLD_CAT',ts:1},{self:true,text:'NEW_PENGUIN',ts:2,personaScope:scope},{self:false,text:'HUMAN',ts:3,senderName:'X',senderId:'42'}];
  const tool=buildToolDefs().find(t=>t.id==='get_recent_messages');
  const result=await tool.execute({chatKey:'group:99',session:{pastStateCount:0},store:{recent:()=>records}},{});
  const value=JSON.stringify(result);assert.doesNotMatch(value,/OLD_CAT/);assert.match(value,/NEW_PENGUIN/);assert.match(value,/HUMAN/);
});
test('one authoritative role body and one boundary rule appear in system prompt, facts remain in user data',()=>{
  const cfg=fixture(),key='group:99';
  const system=buildSystemPrompt({persona:{...cfg.persona,...cfg.personaByChat[key]},skillContext:{kind:'group'}});
  assert.equal(system.split('PENGUIN_ROLE_SENTINEL').length-1,1);assert.doesNotMatch(system,/CAT_ROLE_SENTINEL|LEGACY_CAT_STYLE/);
  assert.match(system,/角色与事实边界/);
  const user=buildUserPrompt({chatKey:key,kind:'group',chatId:'99',triggerEntries:[{id:9,mid:9,ts:9,senderId:'42',senderName:'X',text:'CURRENT_QUESTION'}],
    store:{recent:()=>[]},memory:{formatForPrompt:()=> 'MEMBER_FACT'},stickerEntries:[],contextLimit:80,session:{}});
  assert.doesNotMatch(user,/PENGUIN_ROLE_SENTINEL|CAT_ROLE_SENTINEL/);assert.match(user,/MEMBER_FACT/);assert.match(user,/CURRENT_QUESTION/);
});
test('changing one role leaves all other chat personas and the model intact',()=>{
  const cfg=fixture(),old98=roleIdentity(cfg,'group:98'),oldPrivate=roleIdentity(cfg,'private:42');
  merge(cfg,roleCardPatch(cfg,'group:99','cat'));
  assert.deepEqual(roleIdentity(cfg,'group:98'),old98);assert.deepEqual(roleIdentity(cfg,'private:42'),oldPrivate);
  assert.equal(cfg.api.model,'model-a');
});
process.on('exit',()=>{assert.ok(temporary.startsWith(path.join(os.tmpdir(),'qq-role-isolation-')));fs.rmSync(temporary,{recursive:true,force:true});});
