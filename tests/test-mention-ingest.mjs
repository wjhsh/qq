import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {groupMentionPolicy} from '../qq-agent/src/group-mention-policy.mjs';
import {incomingPeerPolicy,isAutomatedPeer} from '../qq-agent/src/bot-interaction.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(process.env.APP_SOURCE || path.resolve(here,'../../work/huawei-deployment/mention-control-live/app-fixed.js'),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('  async function ingestMessage(kind, id, event) {');
const stop=source.indexOf('\n  /**\n   * 指令禁言：',start);
assert.ok(start>0&&stop>start);
const body=source.slice(start,stop);
const self='10002';const group='20002';
const text=(value)=>({type:'text',data:{text:value}});
const at={type:'at',data:{qq:self}};
function fixture(handleCommand=false){
  const calls={handlers:0,wakes:0,forwarded:0,stored:[],read:0,command:null};
  const cfg={allow:{groups:[group]},harnessControl:{mentionOnlyGroups:[group]},
    personaCommands:{enabled:true},modelCommands:{enabled:true},sharedMemory:{enabled:true},mobileControl:{enabled:true},ownerConsole:{enabled:true,ownerIds:['10001']}};
  const handler={handle:async()=>{calls.handlers++;return {handled:false};}};
  const deps={incomingPeerPolicy,isAutomatedPeer,getConfig:()=>cfg,allowed:()=>true,isGloballyBlocked:()=>false,groupMentionPolicy,
    onebot:{selfId:self},communityCommands:handler,naturalAdmin:handler,ownerPrivateRules:handler,personaWorkshop:handler,ownerLocalCommands:handler,
    ownerHarness:{handle:async(event)=>{calls.handlers++;if(handleCommand){calls.command=event;return {handled:true};}return {handled:false};}},
    personaCommands:handler,modelCommands:handler,sharedMemoryCommands:handler,mobileControls:handler,
    parsePersonaWorkshopCommand:()=>null,extractMediaFromSegments:()=>[],
    segmentsToText:async(segments,options)=>segments.map(s=>{if(s.type==='at'){options.onAt({qq:s.data.qq,text:'@bot'});return '@bot';}return s.data?.text||'';}).join(''),
    resolveReply:async()=>null,resolveAtName:async()=>null,expandForwardNodes:async()=>null,isAtMe:()=>false,maybeTriggerCommandMute:()=>{},
    directTextFromSegments:(segments)=>segments.filter(s=>s.type==='text').map(s=>s.data.text).join(''),
    store:{appendIncoming:(_key,entry)=>{calls.stored.push(entry);return {id:1,...entry};},markEntryRead:()=>calls.read++},
    emit:()=>{},isGroupSilenced:()=>false,orchestrator:{onIncoming:()=>calls.wakes++},groupMemory:{maybeSummarize:()=>{}},
    forwardLinkedMedia:async()=>{calls.forwarded++;},log:()=>{}};
  const ingest=new Function(...Object.keys(deps),body+'\nreturn ingestMessage;')(...Object.values(deps));
  const run=(segments)=>ingest('group',group,{message:segments,message_id:100,user_id:'10001'});
  return {calls,run};
}
test('actual ingest archives an unmentioned slash command without calling handlers or model',async()=>{
  const f=fixture();await f.run([text('/状态')]);
  assert.equal(f.calls.handlers,0);assert.equal(f.calls.wakes,0);assert.equal(f.calls.forwarded,0);assert.equal(f.calls.stored.length,1);assert.equal(f.calls.read,1);
});
test('actual ingest lets a real @ invoke deterministic slash commands',async()=>{
  const f=fixture(true);await f.run([at,text(' /状态')]);
  assert.deepEqual(f.calls.command.segments,[text(' /状态')]);assert.equal(f.calls.wakes,0);
});
test('actual ingest wakes normal RP only after a real @',async()=>{
  const f=fixture();await f.run([at,text(' 你好')]);
  assert.equal(f.calls.wakes,1);assert.equal(f.calls.stored[0].atMe,true);
});
