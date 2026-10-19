import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSilenceCommand, silenceState, isGroupSilenced } from './chat-silence.mjs';
import { createOwnerHarness } from './owner-harness.mjs';

test('silence persists as a value and timed silence expires without a timer', () => {
  const cfg={harnessControl:{silencedGroups:{99:0,98:5000,97:null}}};
  assert.ok(isGroupSilenced(cfg,'group:99',100000));
  assert.ok(isGroupSilenced(cfg,'group:98',4999));
  assert.equal(isGroupSilenced(cfg,'group:98',5000),false);
  assert.equal(isGroupSilenced(cfg,'group:97'),false);
  assert.equal(isGroupSilenced(cfg,'private:99'),false);
  assert.deepEqual(silenceState(cfg,'group:98',4999),{active:true,until:5000});
});

test('mute grammar scopes to the current group and validates duration', () => {
  assert.deepEqual(parseSilenceCommand('group:99','闭嘴','',1000),{groupId:'99',until:0});
  assert.deepEqual(parseSilenceCommand('group:99','闭嘴','30分钟',1000),{groupId:'99',until:1801000});
  assert.deepEqual(parseSilenceCommand('private:42','开口','99'),{groupId:'99',until:null});
  for(const text of ['-1','0','1441','99 30','1;whoami','9999999999999999']) assert.throws(()=>parseSilenceCommand('group:99','闭嘴',text));
  assert.throws(()=>parseSilenceCommand('private:42','闭嘴',''));
});

test('only owner can mute; management queries remain available; quoted commands do nothing', async () => {
  const cfg={allow:{groups:['99']},harnessControl:{enabled:true,groupMode:'allowlist',readForMembers:true}};
  const replies=[];let changes=0;
  const handler=createOwnerHarness({dataDir:'/tmp',getConfig:()=>cfg,
    ownerConsole:{authorized:(ctx)=>ctx.chatKey==='private:42'&&ctx.triggerEntries[0].senderId==='42'},
    sendReply:async(chat,text)=>replies.push({chat,text}),request:async()=>({services:{},memory_available:'1GB',disk_free_gib:20,queue:0}),
    setGroupSilence:async(id,until,{canCommit})=>{assert.ok(canCommit());changes++;cfg.harnessControl.silencedGroups={[id]:until};return{ok:true};}});
  const run=(text,senderId='42',segments=[{type:'text',data:{text}}])=>handler.handle({chatKey:'group:99',senderId,segments});
  await run('/闭嘴','43');assert.equal(changes,0);
  await run('/闭嘴');assert.equal(changes,1);assert.ok(isGroupSilenced(cfg,'group:99'));
  await run('/状态','43');assert.match(replies.at(-1).text,/静默中/);
  await run('/开口','43');assert.equal(changes,1);
  await run('', '42', [{type:'reply',data:{}},{type:'text',data:{text:'/开口'}}]);assert.equal(changes,1);
  await run('/开口');assert.equal(changes,2);assert.equal(isGroupSilenced(cfg,'group:99'),false);
});

test('real sender and orchestrator block replies, mentions, proactive wakes and stale sends', {skip:process.platform==='win32'}, async () => {
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-silence-test-'));
  process.env.QQ_AGENT_DATA_DIR=temp;
  try{
    const {getConfig,updateConfig}=await import('/opt/codex-qq/QQ-agent/src/config.js');
    const {SendQueue}=await import('/opt/codex-qq/QQ-agent/src/sender.js');
    const {Orchestrator}=await import('/opt/codex-qq/QQ-agent/src/orchestrator.js');
    updateConfig({allow:{groups:['99'],private:['42']},api:{baseUrl:'http://127.0.0.1:9/v1',apiKey:'test-only',model:'test'},harnessControl:{silencedGroups:{99:0}}});
    let sent=0,marked=0;
    const onebot={selfId:'9',sendText:async()=>{sent++;return{message_id:1};},sendImage:async()=>{sent++;throw Error('unexpected image');}};
    const store={appendSelf:()=>{},markEntryRead:()=>{marked++;},markAllRead:()=>{marked++;}};
    const sender=new SendQueue({onebot,store});
    await assert.rejects(sender.sendTextBatch('group:99',['ordinary']));
    await assert.rejects(sender.sendImage('group:99',{url:'https://invalid.example/image.png'}));
    const scoped=sender.scopeForChat('group:99');
    assert.equal(scoped.sendControlText,undefined);
    await assert.rejects(scoped.sendTextBatch('private:42',['cross-chat']));
    await sender.sendControlText('group:99',['management status']);assert.equal(sent,1);
    const orchestrator=new Orchestrator({store,sender,onebot,sessions:{current:new Map()},memory:{},stickers:{}});
    orchestrator.onIncoming('group:99',{id:1,atMe:true});
    orchestrator.scheduleWake('group:99');
    await orchestrator.wake('group:99',{proactive:true});
    assert.ok(marked>=3);assert.equal(orchestrator.pendingWake.size,0);assert.equal(sent,1);
    const timer=setTimeout(()=>{},10000);orchestrator.wakeTimers.set('group:99',timer);orchestrator.pendingWake.add('group:99');
    orchestrator.preparePersonaSwitch('group:99');
    assert.equal(orchestrator.pendingWake.size,0);assert.equal(orchestrator.wakeTimers.size,0);
    updateConfig({harnessControl:{silencedGroups:{99:null}}});
    await assert.rejects(scoped.sendTextBatch('group:99',['stale reply']));
    await sender.sendTextBatch('group:99',['resumed']);assert.equal(sent,2);
    updateConfig({harnessControl:{silencedGroups:{99:Date.now()-1}}});
    const persisted=JSON.parse(fs.readFileSync(path.join(temp,'config.json'),'utf8'));
    assert.equal(isGroupSilenced(persisted,'group:99'),false);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
