import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-blocked-'));process.env.QQ_AGENT_DATA_DIR=root;
const {createImageTool,ImageRequestLedger}=await import('../qq-agent/skills/local-image/index.js');
const {createCodexImageClient}=await import('../qq-agent/skills/local-image/codex-image-client.js');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('blocked Chat job reaches group tool accurately with zero sends, fallbacks or duplicate generations',async()=>{
 const requests=[];let sends=0,fallbacks=0;
 const generateChat=createCodexImageClient({engine:'chatgpt',readToken:()=> 'test-only',sleep:async()=>{},fetchImpl:async(url,options)=>{
  requests.push({path:url.pathname,method:options.method});
  const data=options.method==='POST'?{id:'a'.repeat(12),status:'running'}:{id:'a'.repeat(12),status:'failed',error_code:'blocked'};
  return new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});
 }});
 const ledger=new ImageRequestLedger(path.join(root,'ledger.json'));
 const tool=createImageTool({generateChat,ledger,getConfig:()=>({allow:{group:['12345']}}),generate:async()=>{fallbacks++;throw Error('forbidden');},generateGpt:async()=>{fallbacks++;throw Error('forbidden');}});
 const ctx={chatKey:'group:12345',kind:'group',chatId:'12345',selfId:'77777',triggerEntries:[{id:7,mid:88,senderId:'67890',directText:'/生图 Chat 鲸鱼娘',atMe:true}],sender:{sendMedia:async()=>{sends++;throw Error('no image should be sent');}}};
 const result=await tool.execute(ctx,{prompt:'鲸鱼娘',provider:'chat'});
 assert.equal(result.isError,true);assert.match(result.content,/内容安全检查拦截/);
 await tool.execute(ctx,{prompt:'鲸鱼娘',provider:'chat'});
 assert.equal(sends,0);assert.equal(fallbacks,0);
 assert.deepEqual(requests,[{path:'/jobs',method:'POST'},{path:'/jobs/'+'a'.repeat(12),method:'GET'}]);
 const record=JSON.parse(fs.readFileSync(path.join(root,'ledger.json'),'utf8'))[0][1];
 assert.equal(record.code,'blocked');assert.equal(record.provider,'chat');assert.equal(record.jobId,'a'.repeat(12));
});

test('pending conversation is distinguished from a busy server and never starts a generation retry',async()=>{
 let requests=0;
 const generateChat=createCodexImageClient({engine:'chatgpt',readToken:()=> 'test-only',fetchImpl:async()=>{requests++;return new Response(JSON.stringify({ok:true,data:{id:'b'.repeat(12),status:'failed',error_code:'conversation_pending'}}));}});
 const tool=createImageTool({generateChat,ledger:new ImageRequestLedger(path.join(root,'pending.json')),getConfig:()=>({allow:{group:['12345']}})});
 const ctx={chatKey:'group:12345',kind:'group',chatId:'12345',selfId:'77777',triggerEntries:[{id:7,mid:88,senderId:'67890',directText:'/生图 Chat 星星',atMe:true}],sender:{sendMedia:async()=>{throw Error('No image should be sent');}}};
 const result=await tool.execute(ctx,{prompt:'星星',provider:'chat'});
 assert.equal(result.isError,true);assert.match(result.content,/上一轮仍未结束/);assert.doesNotMatch(result.content,/服务器正在处理其他任务|取消排队/);assert.equal(requests,1);
});
