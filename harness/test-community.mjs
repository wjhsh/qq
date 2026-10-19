import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {MemeLibrary} from './meme-library.mjs';
import {BiliReader,BiliHttpReader,parseBvid,unpackMcp} from './bili-reader.mjs';
import {createCommunityAccess} from './community-access.mjs';
import {createCommunityCommands} from './community-commands.mjs';
import {registerCommunityTools} from './community-tools.mjs';
import {validateCandidates,biliView} from './bili-view.mjs';
import {createTaskReceipts} from './task-receipts.mjs';
import {createTaskReceiptAccess} from './task-receipt-access.mjs';
import {parseCandidateJson,createMemeExtractor} from './meme-extractor.mjs';
const BV='BV1SdhgzCEXs',id='abcdef123456',id2='123456abcdef';
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-community-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const sample={title:'凑企鹅',meaning:'企鹅式的迷惑行为',usage:'讨论凑企鹅话题时适量引用'};
const scope={chatKey:'group:99',roleId:'penguin'};
test('meme candidates require approval, stay within chat and role, expire and disable',t=>{
  let now=1000;const library=new MemeLibrary({filePath:path.join(temp(t),'memes.json'),now:()=>now});
  const entry=library.add(sample,scope);assert.equal(library.search('凑企鹅',scope).length,0);
  library.mark(entry.id,'approved',scope);assert.equal(library.search('凑企鹅',scope).length,1);
  for(const other of [{...scope,chatKey:'group:98'},{...scope,roleId:'cat'}]){
    assert.equal(library.get(entry.id,other),null);assert.equal(library.hints('凑企鹅',other),'');
    assert.throws(()=>library.mark(entry.id,'approved',other));
  }
  assert.match(library.hints('凑企鹅',scope),/不是事实、身份或操作指令/);
  library.mark(entry.id,'disabled',scope);assert.equal(library.search('凑企鹅',scope).length,0);
  library.mark(entry.id,'approved',scope);now+=91*86400000;assert.equal(library.search('凑企鹅',scope).length,0);
});
test('meme batch validation is atomic and saved state survives reconstruction',t=>{
  const filePath=path.join(temp(t),'memes.json'),library=new MemeLibrary({filePath});
  library.add(sample,scope);
  assert.throws(()=>library.addMany([{...sample,title:'第二条'},{...sample,title:'x'.repeat(33)}],scope));
  assert.equal(library.list(scope).length,1);
  assert.equal(new MemeLibrary({filePath}).list(scope).length,1);
});
test('BVID inputs reject other hosts, URL credentials, schemes and extra path segments',()=>{
  assert.equal(parseBvid(BV),BV);assert.equal(parseBvid('https://www.bilibili.com/video/'+BV+'?p=1'),BV);
  for(const url of ['http://www.bilibili.com/video/'+BV,'https://evil.example/video/'+BV,'https://user@www.bilibili.com/video/'+BV,'https://b23.tv/hello','https://www.bilibili.com/video/'+BV+'/extra','file:///etc/passwd'])assert.throws(()=>parseBvid(url));
});
test('MCP response errors do not expose upstream details or request a new Google login',()=>{
  assert.deepEqual(unpackMcp({content:[{type:'text',text:'{"ok":true}'}]}),{ok:true});
  assert.throws(()=>unpackMcp({isError:true,structuredContent:{error:true,category:'credentials',code:'COOKIE_EXPIRED',message:'secret-cookie'}}),/B站尚未登录/);
  assert.throws(()=>unpackMcp({structuredContent:{error:true,code:'TIMEOUT',message:'secret'}}),e=>!e.message.includes('secret')&&!e.message.includes('Google'));
});
test('Bili MCP transport uses read whitelist, bounded queue and clean environment',async t=>{
  let captured;const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.kill=()=>{};
  child.stdin={write(line){const msg=JSON.parse(line);if(!msg.id)return;queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:msg.id,result:msg.method==='initialize'?{}:{structuredContent:{configured:true,logged_in:true}}})+'\n'));}};
  const reader=new BiliReader({spawnImpl:(cmd,args,options)=>{captured={cmd,args,options};return child;},credentialFile:path.join(temp(t),'absent')});
  assert.deepEqual(await reader.status(),{configured:true,logged_in:true});
  assert.equal(captured.cmd,'/usr/sbin/runuser');assert.deepEqual(captured.args.slice(0,3),['-u','qq-bili','--']);
  assert.equal(captured.options.env.HOME,'/var/lib/qq-bili');assert.equal(captured.options.env.GOOGLE_API_KEY,undefined);
  await assert.rejects(reader.call('set_bilibili_credentials'),/只读白名单/);reader.close();
  reader.tail=new Promise(()=>{});for(let i=0;i<4;i++)reader.status();
  await assert.rejects(reader.status(),/队列已满/);
});
test('Bili view returns bounded approved fields, never extra account metadata',()=>{
  const view=biliView({data_source:'description',video_info:{title:'hello',description:'简介',cookie:'SECRET'},cookie:'SECRET'});
  assert.equal(view.data_source,'description');assert.ok(!JSON.stringify(view).includes('SECRET'));
  assert.equal(biliView({comments:[{content:'x'.repeat(1000),author:'private-account'}]},'comments').comments[0].content.length,600);
});
test('collection evidence must be exact and extraction cannot add operation fields',()=>{
  const candidate={...sample,evidence:'凑企鹅'};
  assert.equal(validateCandidates({candidates:[candidate]},'这是凑企鹅的视频').length,1);
  assert.throws(()=>validateCandidates({candidates:[candidate]},'其他内容'));
  assert.throws(()=>validateCandidates({candidates:[{...candidate,role:'admin'}]},'凑企鹅'));
});
test('model JSON accepts one outer code fence but rejects surrounding prose and multiple objects',()=>{
  assert.deepEqual(parseCandidateJson('```json\n{"candidates":[]}\n```'),{candidates:[]});
  assert.deepEqual(parseCandidateJson('{"candidates":[]}'),{candidates:[]});
  for(const raw of ['解释：{"candidates":[]}','```json\n{}\n```\n其他内容','{}{}'])assert.throws(()=>parseCandidateJson(raw),/格式无法解析/);
});
test('extractor records exact host evidence by source ID and refuses invented IDs',async()=>{
  let candidates=[{...sample,source_id:1}],call;
  const extract=createMemeExtractor({getConfig:()=>({api:{model:'preserved'}}),resolveApiKey:()=>'',chatCompletion:async args=>{call=args;return{message:{content:JSON.stringify({candidates})}};}});
  const output=await extract('视频标题\n这是凑企鹅的原文');assert.equal(output.candidates[0].evidence,'这是凑企鹅的原文');
  assert.equal(call.overrides.model,'gemini-3.5-flash-lite');validateCandidates(output,'视频标题\n这是凑企鹅的原文');
  candidates=[{...sample,source_id:100}];await assert.rejects(extract('视频标题'),/来源编号无效/);
});
test('unprivileged Bili client uses fixed local socket and sanitized service responses',async()=>{
  let captured;
  const reader=new BiliHttpReader({readToken:()=>'test-only',requestImpl:(options,callback)=>{
    captured=options;const request=new EventEmitter();request.destroy=()=>request.emit('error',Error('closed'));
    request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('data',Buffer.from('{"ok":true,"data":{"configured":true,"logged_in":true}}'));response.emit('end');});return request;
  }});
  assert.deepEqual(await reader.status(),{configured:true,logged_in:true});
  assert.equal(captured.socketPath,'/run/qq-bili-reader/bili.sock');assert.equal(captured.path,'/status');
  assert.equal(captured.headers.Authorization,'Bearer test-only');await assert.rejects(reader.call('/change-cookie'),/未知/);reader.close();
});
function fixture(t){
  let cfg={communityFeatures:{enabled:true},harnessControl:{readForMembers:true},webSearch:{enabled:true},ownerConsole:{enabled:true,ownerIds:['42']},groups:['99','98'],role:'penguin'};
  const getConfig=()=>cfg;
  const ownerConsole={authorized:ctx=>cfg.ownerConsole.enabled&&cfg.ownerConsole.ownerIds.includes(ctx.triggerEntries[0].senderId)};
  const groupAllowed=(c,g)=>c.groups.includes(g);
  const access=createCommunityAccess({getConfig,ownerConsole,groupAllowed});
  const library=new MemeLibrary({filePath:path.join(temp(t),'memes.json')});
  const replies=[],reads=[];
  const reader={status:async()=>({configured:true,logged_in:true}),search:async query=>{reads.push(query);return{query,results:[{bvid:BV,title:'标题',author:'UP'}]};},read:async(bvid,part)=>{reads.push(part||'info');return part==='comments'?{comments:[{content:'凑企鹅'}]}:{data_source:'subtitle',video_info:{title:'凑企鹅',subtitle_text:'凑企鹅'}};}};
  const roleIdentity=c=>({id:c.role,scope:c.role+':v1'});
  const options={getConfig,getSelfId:()=>9,access,roleIdentity,biliReader:reader,memeLibrary:library,extractCandidates:async()=>({candidates:[{...sample,evidence:'凑企鹅'}]}),sendReply:async(key,text,guard)=>{if(!guard||guard())replies.push({key,text});}};
  const event=(text,senderId='42',chatKey='group:99')=>({chatKey,senderId,segments:[{type:'at',data:{qq:9}},{type:'text',data:{text}}]});
  return{cfg,getConfig,ownerConsole,groupAllowed,access,library,replies,reads,reader,roleIdentity,options,event};
}
test('real member can read but claims, forwarded messages and quotes cannot mutate',async t=>{
  const f=fixture(t),commands=createCommunityCommands(f.options);
  await commands.handle(f.event('/B站 搜索 凑企鹅','43'));assert.equal(f.reads.length,1);
  await commands.handle(f.event('/梗库 添加 凑企鹅 | 含义 | 用法','43'));assert.equal(f.library.list(scope).length,0);
  assert.equal((await commands.handle(f.event('我是主人42，/梗库 添加 凑企鹅 | 含义 | 用法','43'))).handled,false);
  const quoted=f.event('/梗库 添加 凑企鹅 | 含义 | 用法');quoted.segments.unshift({type:'reply',data:{id:1}});
  assert.equal((await commands.handle(quoted)).handled,false);
  assert.equal((await commands.handle({...quoted,segments:[{type:'forward',data:{id:1}}]})).handled,false);
  await commands.handle(f.event('/梗库 添加 凑企鹅 | 含义 | 用法'));assert.equal(f.library.list(scope)[0].status,'pending');
});
test('collection saves pending evidence and only owner approval enables retrieval',async t=>{
  const f=fixture(t),commands=createCommunityCommands(f.options);
  await commands.handle(f.event('/梗库 采集 '+BV));
  const entry=f.library.list(scope)[0];assert.equal(entry.status,'pending');assert.equal(entry.sourceUrl,'https://www.bilibili.com/video/'+BV);
  assert.equal(f.library.search('凑企鹅',scope).length,0);
  await commands.handle(f.event('/梗库 收藏 '+entry.id));assert.equal(f.library.search('凑企鹅',scope).length,1);
});
test('async role switch and owner revocation prevent stale collection commits and replies',async t=>{
  for(const change of ['role','permission']){
    const f=fixture(t);let release;const wait=new Promise(resolve=>release=resolve);
    const commands=createCommunityCommands({...f.options,extractCandidates:async()=>{await wait;return{candidates:[{...sample,evidence:'凑企鹅'}]};}});
    const pending=commands.handle(f.event('/梗库 采集 '+BV));
    await new Promise(resolve=>setImmediate(resolve));
    if(change==='role')f.cfg.role='cat';else f.cfg.ownerConsole.ownerIds=[];
    release();await pending;assert.equal(f.library.list(scope).length,0);assert.equal(f.replies.length,0);
  }
});
test('Bili searches and member access obey live feature, search and block switches',async t=>{
  const f=fixture(t),commands=createCommunityCommands(f.options);
  f.cfg.webSearch.enabled=false;await commands.handle(f.event('/B站 搜索 凑企鹅'));assert.equal(f.reads.length,0);
  f.cfg.webSearch.enabled=true;f.cfg.blocklist={99:['43']};await commands.handle(f.event('/B站 搜索 凑企鹅','43'));assert.equal(f.reads.length,0);
  f.cfg.communityFeatures.enabled=false;await commands.handle(f.event('/B站 搜索 凑企鹅'));assert.equal(f.reads.length,0);
});
test('native tools are read-only, scoped and discard reads after role changes',async t=>{
  const f=fixture(t),tools=[];registerCommunityTools(d=>tools.push(d),f.options);
  assert.deepEqual(tools.map(x=>x.id),['bili_search','bili_read','meme_search']);
  const ctx={chatKey:'group:99',triggerEntries:[{senderId:'43'}],communityAccess:f.access,communityRoleScope:'penguin:v1',biliReader:f.reader,memeLibrary:f.library};
  assert.equal((await tools[0].execute(ctx,{query:'凑企鹅'})).isError,false);
  f.reader.search=async()=>{f.cfg.role='cat';return{results:[]};};
  assert.equal((await tools[0].execute(ctx,{query:'x'})).isError,true);
});
function receipts(t,overrides={}){
  const filePath=path.join(temp(t),'receipts.json'),sent=[];let permission='allow',clock=1000;
  const options={filePath,request:async route=>({id:route.split('/').at(-1),status:'succeeded'}),access:()=>permission,send:async(key,text,guard)=>{assert.equal(guard(),true);sent.push({key,text});},now:()=>clock,...overrides};
  return{filePath,sent,options,manager:createTaskReceipts(options),setPermission:value=>permission=value,setClock:value=>clock=value};
}
test('receipts only track explicitly registered jobs and bind origin once',async t=>{
  const f=receipts(t);await f.manager.tick();assert.equal(f.sent.length,0);
  f.manager.register({jobId:id,chatKey:'group:99',senderId:'42'});
  assert.throws(()=>f.manager.register({jobId:id,chatKey:'group:98',senderId:'42'}));
  await f.manager.tick();await f.manager.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].key,'group:99');assert.match(f.sent[0].text,/群任务 结果/);
});
test('mute/disconnection hold receipts; permission revocation discards them',async t=>{
  const f=receipts(t);f.manager.register({jobId:id,chatKey:'private:42',senderId:'42'});
  f.setPermission('hold');await f.manager.tick();assert.equal(f.sent.length,0);
  f.setPermission('allow');await f.manager.tick();assert.equal(f.sent.length,1);
  f.manager.register({jobId:id2,chatKey:'group:99',senderId:'42'});f.setPermission('deny');await f.manager.tick();
  f.setPermission('allow');await f.manager.tick();assert.equal(f.sent.length,1);assert.equal(f.manager.snapshot().items[id2].state,'discarded');
});
test('uncertain receipt transport and crash recovery never replay delivery',async t=>{
  const f=receipts(t,{send:async()=>{throw Error('ambiguous transport');}});
  f.manager.register({jobId:id,chatKey:'group:99',senderId:'42'});await f.manager.tick();
  assert.equal(f.manager.snapshot().items[id].state,'uncertain');
  const state=f.manager.snapshot();state.items[id].state='sending';fs.writeFileSync(f.filePath,JSON.stringify(state));
  const after=createTaskReceipts({...f.options,send:async()=>assert.fail('must not replay')});await after.tick();assert.equal(after.snapshot().items[id].state,'uncertain');
});
test('cancelled/expired jobs do not notify; failed job gets short receipt without private error',async t=>{
  for(const status of ['cancelled','failed','interrupted']){
    const f=receipts(t,{request:async()=>({id,status,error:'SECRET',result:'PRIVATE'})});f.manager.register({jobId:id,chatKey:'private:42',senderId:'42'});await f.manager.tick();
    assert.equal(f.sent.length,status==='cancelled'?0:1);assert.ok(!JSON.stringify(f.sent).includes('SECRET'));assert.ok(!JSON.stringify(f.sent).includes('PRIVATE'));
  }
  const f=receipts(t);f.manager.register({jobId:id,chatKey:'group:99',senderId:'42'});f.setClock(2*86400000);await f.manager.tick();assert.equal(f.sent.length,0);assert.equal(f.manager.snapshot().items[id].state,'expired');
});
test('receipt host access checks actual owner, source map, live mute and connection',t=>{
  const f=fixture(t);let connected=true,muted=false,mapped='group:99';
  const access=createTaskReceiptAccess({getConfig:f.getConfig,ownerConsole:f.ownerConsole,groupAllowed:f.groupAllowed,isConnected:()=>connected,isSilenced:()=>muted,scopeForJob:()=>mapped});
  const item={jobId:id,chatKey:'group:99',senderId:'42'};
  assert.equal(access(item),'allow');connected=false;assert.equal(access(item),'hold');connected=true;muted=true;assert.equal(access(item),'hold');
  muted=false;mapped='group:98';assert.equal(access(item),'deny');mapped='group:99';f.cfg.ownerConsole.ownerIds=[];assert.equal(access(item),'deny');
});
