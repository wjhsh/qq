// Real host modules, isolated data, and fake transports: zero real QQ sends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-community-host-'));
process.env.QQ_AGENT_DATA_DIR=temporary;
try{
  const root='/opt/codex-qq/QQ-agent/src/';
  const {getConfig,updateConfig}=await import(root+'config.js');
  const {SendQueue}=await import(root+'sender.js');
  const {createOwnerConsole}=await import(root+'owner-console.js');
  const {createOwnerHarness,controlGroup}=await import(root+'owner-harness.js');
  const {createAdminRuntime}=await import(root+'admin-runtime.mjs');
  const {roleIdentity}=await import(root+'role-isolation.mjs');
  const {createCommunityAccess}=await import(root+'community-access.mjs');
  const {createCommunityCommands}=await import(root+'community-commands.mjs');
  const {MemeLibrary}=await import(root+'meme-library.mjs');
  const {createTaskReceipts}=await import(root+'task-receipts.mjs');
  const {createTaskReceiptAccess}=await import(root+'task-receipt-access.mjs');
  const {isGroupSilenced}=await import(root+'chat-silence.mjs');
  updateConfig({allow:{group:['99','98'],private:['42']},deny:{group:[],private:[]},
    ownerConsole:{enabled:true,ownerIds:['42']},communityFeatures:{enabled:true},taskReceipts:{enabled:true},
    harnessControl:{enabled:true,groupMode:'allowlist',readForMembers:true,silencedGroups:{99:0}},
    naturalAdmin:{enabled:true,adminIds:['42']},personaUnified:false,personaByChat:{'group:99':{roleCardId:'penguin',roleText:'企鹅角色'}},
    send:{minGapMs:200,maxGapMs:200,byLengthMs:1,hardSplitAt:0}});
  let networkCalls=0,firstRelease;const wait=new Promise(resolve=>firstRelease=resolve);
  const sender=new SendQueue({onebot:{sendText:async()=>{networkCalls++;if(networkCalls===1)await wait;return{message_id:networkCalls};}},store:{appendSelf:()=>{}}});
  const first=sender.sendControlText('group:99',['fake in-flight'],{dedupe:false});
  await new Promise(resolve=>setImmediate(resolve));
  let permitted=true;
  const queued=sender.sendControlText('group:99',['must be cancelled'],{dedupe:false,beforeSend:()=>permitted});
  permitted=false;firstRelease();await first;await assert.rejects(queued,/发送前权限/);assert.equal(networkCalls,1);
  await assert.rejects(sender.sendTextBatch('group:99',['muted RP']));
  const unused=()=>assert.fail('unexpected owner operation');
  const ownerConsole=createOwnerConsole({ownerIds:['42'],getConfig,listGroups:unused,readMessages:unused,getGroupMemory:unused,appendGroupMemory:unused,saveGroupStyle:unused,editGroupMemory:unused,roleDraft:unused});
  const access=createCommunityAccess({getConfig,ownerConsole,groupAllowed:controlGroup});
  const replies=[],events=[],jobs=new Map(),library=new MemeLibrary({filePath:path.join(temporary,'memes.json')});
  const receiptAccess=createTaskReceiptAccess({getConfig,ownerConsole,groupAllowed:controlGroup,isConnected:()=>true,isSilenced:isGroupSilenced,
    scopeForJob:id=>JSON.parse(fs.readFileSync(path.join(temporary,'group-task-scopes.json'),'utf8'))[id]});
  const receipts=createTaskReceipts({filePath:path.join(temporary,'receipts.json'),request:async route=>jobs.get(route.split('/').at(-1)),access:receiptAccess,
    send:async(key,text,guard)=>{assert.ok(guard());events.push({key,text});}});
  let submits=0;
  const request=async(route,body)=>{assert.equal(route,'/jobs');assert.ok(body.prompt);const job={id:submits++===0?'abcdef123456':'123456abcdef',status:'succeeded'};jobs.set(job.id,job);return job;};
  const onTaskSubmitted=item=>receipts.register(item);
  const privateHarness=createOwnerHarness({ownerConsole,getConfig,dataDir:temporary,sendReply:async(key,text)=>replies.push({key,text}),request,onTaskSubmitted});
  await privateHarness.handle({chatKey:'private:42',senderId:'42',segments:[{type:'text',data:{text:'/任务 写一个脚本'}}]});
  assert.equal(receipts.snapshot().items.abcdef123456.chatKey,'private:42');
  const runtime=createAdminRuntime({getConfig,updateConfig,getSelfId:()=>9,ownerConsole,groupAllowed:controlGroup,listCards:()=>[],activeCard:()=>null,
    rolePatch:unused,orchestrator:{preparePersonaSwitch:()=>{}},store:{markAllRead:()=>{}},sharedMemory:{},emit:()=>{},dataDir:temporary,requestHarness:request,
    completeJudge:unused,dispatchCommand:unused,sendReply:async(key,text)=>replies.push({key,text}),onTaskSubmitted});
  await runtime.handle({chatKey:'group:99',senderId:'42',segments:[{type:'at',data:{qq:9}},{type:'text',data:{text:'任务：整理文件'}}]});
  assert.equal(receipts.snapshot().items['123456abcdef'].chatKey,'group:99');
  await receipts.tick();assert.deepEqual(events.map(x=>x.key),['private:42']);
  updateConfig({harnessControl:{silencedGroups:{99:null}}});await receipts.tick();assert.deepEqual(events.map(x=>x.key),['private:42','group:99']);
  const commands=createCommunityCommands({getConfig,getSelfId:()=>9,access,roleIdentity,memeLibrary:library,biliReader:{search:async()=>({results:[]})},extractCandidates:unused,sendReply:async(key,text)=>replies.push({key,text})});
  await commands.handle({chatKey:'group:99',senderId:'43',segments:[{type:'text',data:{text:'/梗库 添加 企鹅 | 含义 | 用法'}}]});
  const scope={chatKey:'group:99',roleId:roleIdentity(getConfig(),'group:99').id};assert.equal(library.list(scope).length,0);
  await commands.handle({chatKey:'group:99',senderId:'42',segments:[{type:'text',data:{text:'/梗库 添加 企鹅 | 含义 | 用法'}}]});assert.equal(library.list(scope).length,1);
  updateConfig({ownerConsole:{ownerIds:[]}});assert.equal(access.canManage({chatKey:'group:99',senderId:'42'}),false);
  const source=fs.readFileSync(root+'app.js','utf8'),hook=source.indexOf('if ((await communityCommands.handle(');
  assert.ok(hook>source.indexOf('const globalBlocked = isGloballyBlocked(senderId);'));
  assert.ok(hook<source.indexOf('if ((await naturalAdmin.handle('));
  assert.match(source,/taskReceipts\.start\(\)/);assert.match(source,/taskReceipts\.stop\(\)/);
  console.log(JSON.stringify({live_host_integration:'passed',qq_test_messages_sent:0,task_submission_hooks:2,receipt_scope_and_mute:'passed',sender_queued_guard:'passed',real_owner_permissions:'passed'}));
}finally{assert.ok(temporary.startsWith(path.join(os.tmpdir(),'qq-community-host-')));fs.rmSync(temporary,{recursive:true,force:true});}
