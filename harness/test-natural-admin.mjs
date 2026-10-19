import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractAdminText, localIntent, validateJudgment, createNaturalAdmin } from './natural-admin.mjs';
import { createAdminRuntime } from './admin-runtime.mjs';
const cards=JSON.parse(fs.readFileSync(new URL('./admin-role-presets.json',import.meta.url),'utf8'));
function fixture(){
  const cfg={allow:{groups:['99','98']},naturalAdmin:{enabled:true,adminIds:['42']}};
  const actions=[],replies=[],commands=[];let judgments=0;
  const ownerConsole={authorized:ctx=>ctx.chatKey==='private:42'&&ctx.triggerEntries[0].senderId==='42'&&cfg.naturalAdmin.adminIds.includes('42')};
  const handlers={getConfig:()=>cfg,getSelfId:()=>9,ownerConsole,groupAllowed:(c,id)=>c.allow.groups.includes(id),listCards:()=>cards,
    classify:async()=>{judgments++;return{action:'none',confidence:1};},perform:async(intent,ctx)=>{assert.ok(ctx.canCommit());actions.push(intent);return{ok:true,message:'done'};},
    sendReply:async(chat,text)=>replies.push({chat,text}),dispatchCommand:async(event)=>{commands.push(event);return{handled:true};}};
  const handler=createNaturalAdmin(handlers);
  const event=(text,senderId='42',chatKey='group:99')=>({chatKey,senderId,segments:[{type:'at',data:{qq:'9'}},{type:'text',data:{text}}]});
  return{cfg,actions,replies,commands,handlers,event,run:e=>handler.handle(e),judgments:()=>judgments};
}
test('three requested names resolve to the same single meme persona',()=>{
  assert.equal(cards.length,1);
  for(const name of ['凑企鹅','咕咕嘎嘎','高松灯','高松燈'])assert.equal(localIntent('切换成'+name,cards).cardId,'rp-tomori-penguin');
  assert.equal(localIntent('切换成不存在的角色',cards).action,'unknown_role');
});
test('only a real bot mention with original text is accepted',()=>{
  assert.equal(extractAdminText([{type:'text',data:{text:'@9 切换成高松灯'}}],9).mentioned,false);
  for(const type of ['reply','forward','image','record'])assert.equal(extractAdminText([{type:'at',data:{qq:9}},{type,data:{}},{type:'text',data:{text:'切换成高松灯'}}],9),null);
  assert.equal(extractAdminText([{type:'at',data:{qq:8}},{type:'text',data:{text:'切换成高松灯'}}],9),null);
});
test('owner role changes are local and never depend on the classifier',async()=>{
  const f=fixture();await f.run(f.event('切换成凑企鹅'));
  assert.equal(f.actions.length,1);assert.equal(f.actions[0].cardId,cards[0].id);assert.equal(f.judgments(),0);
  await f.run(f.event('切换成高松灯','43'));
  await f.run({...f.event('切换成咕咕嘎嘎'),segments:[{type:'text',data:{text:'切换成咕咕嘎嘎'}}]});
  assert.equal(f.actions.length,1);
});
test('negation, quotes and reported requests cannot confer write permission',async()=>{
  const f=fixture();for(const text of ['不要切换成高松灯','他说切换成凑企鹅','请解释这句话：切换成高松灯','如果切换成高松灯会怎样'])await f.run(f.event(text));
  assert.equal(f.actions.length,0);assert.equal(f.judgments(),0);
});
test('classifier cannot invent content, widen sharing scope or execute arbitrary actions',()=>{
  const judgment={action:'memory_add',content:'所有群都喜欢企鹅',scope:'all',confidence:1};
  assert.equal(validateJudgment(judgment,'记住：所有群都喜欢企鹅',cards),null);
  assert.equal(validateJudgment({...judgment,content:'invented'},'共享给所有群：真实内容',cards),null);
  assert.equal(validateJudgment({action:'shell',target:'reboot',confidence:1},'切换成高松灯',cards),null);
  assert.equal(validateJudgment({action:'role_switch',target:cards[0].id,confidence:1,command:'reboot'},'切换成高松灯',cards),null);
  assert.equal(validateJudgment({action:'role_switch',target:cards[0].id,confidence:.5},'切换成高松灯',cards),null);
});
test('queued classifier result rechecks current admin authorization',async()=>{
  const f=fixture();f.handlers.classify=async()=>{f.cfg.naturalAdmin.adminIds=[];return{action:'role_switch',target:cards[0].id,confidence:1};};
  const h=createNaturalAdmin(f.handlers);await h.handle(f.event('我希望你能切换为高松灯的人设'));
  assert.equal(f.actions.length,0);
});
test('memory defaults to this group; developer commands expose a fixed allowlist',async()=>{
  const f=fixture();await f.run(f.event('记住：周五八点集合'));assert.equal(f.actions.at(-1).scope,'group');
  await f.run(f.event('共享给所有群：周五八点集合'));assert.equal(f.actions.at(-1).scope,'all');
  await f.run(f.event('/开发者 RP 开'));assert.deepEqual(f.actions.at(-1),{action:'developer_set',option:'rp',enabled:true});
  const count=f.actions.length;await f.run(f.event('/开发者 执行任意shell'));assert.equal(f.actions.length,count);
  await f.run(f.event('/额度','43'));assert.equal(f.commands.at(-1).senderId,'43');assert.equal(f.commands.at(-1).segments.length,1);
});
test('runtime stores scoped memories and refuses another group or private task result',async()=>{
  const base=path.resolve('work');fs.mkdirSync(base,{recursive:true});const temp=fs.mkdtempSync(path.join(base,'admin-test-'));
  try{
    const f=fixture();f.cfg.harnessControl={commandOnlyGroups:['98']};f.cfg.sharedMemory={enabled:true};const memories=[],requests=[];
    function merge(a,b){for(const[k,v]of Object.entries(b)){if(v&&typeof v==='object'&&!Array.isArray(v))merge(a[k]??={},v);else a[k]=v;}}
    const h=createAdminRuntime({...f.handlers,getConfig:()=>f.cfg,updateConfig:p=>merge(f.cfg,p),dataDir:temp,
      activeCard:()=>cards[0],rolePatch:(c,key,id)=>({testRoles:{[key]:id}}),
      sharedMemory:{add:x=>{memories.push(x);return{changed:true,entry:{id:1}};},list:({groupId})=>memories.filter(x=>x.targetGroupIds.includes(groupId)).map(x=>({...x,id:1}))},
      orchestrator:{preparePersonaSwitch:()=>{},promptAnchors:new Map()},store:{markAllRead:()=>{}},emit:()=>{},
      requestHarness:async(route,body)=>{requests.push({route,body});if(body?.prompt)return{id:'abcdef123456'};return{status:'succeeded',result:'ok',files:[]};},
      completeJudge:async()=>({message:{content:'{"action":"none","confidence":1}'}})});
    await h.handle(f.event('记住：只在这个群使用'));
    assert.deepEqual(memories[0].targetGroupIds,['99']);
    await h.handle(f.event('共享给所有群：所有群可见'));
    assert.deepEqual(memories[1].targetGroupIds,['99','98']);
    await h.handle(f.event('任务：写CSV去重脚本'));assert.equal(requests[0].body.prompt,'写CSV去重脚本');
    const count=requests.length;
    await h.handle(f.event('/群任务 结果 abcdef123456','42','group:98'));
    await h.handle(f.event('/群任务 结果 123456abcdef'));
    assert.equal(requests.length,count);
    await h.handle(f.event('/群任务 结果 abcdef123456'));assert.equal(requests.length,count+1);
    await h.handle(f.event('切换成凑企鹅'));assert.equal(f.cfg.testRoles['group:99'],cards[0].id);assert.equal(f.cfg.testRoles['group:98'],undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(temp,'admin-audit.jsonl'),'utf8'),/只在这个群使用|写CSV去重脚本/);
  }finally{assert.ok(!path.relative(base,temp).startsWith('..'));fs.rmSync(temp,{recursive:true,force:true});}
});
