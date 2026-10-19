import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-raw-session-'));process.env.QQ_AGENT_DATA_DIR=root;
const {createImageTool,ImageRequestLedger,originalImagePrompt}=await import('../qq-agent/skills/local-image/index.js');
const {createCodexImageClient}=await import('../qq-agent/skills/local-image/codex-image-client.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=','base64');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('strips only command and channel prefix, preserving content and whitespace',()=>{
 const raw='生成一个deepseek鲸鱼娘的形象\n蓝色  背景，比例 16:9';
 assert.equal(originalImagePrompt('/生图 Chat '+raw),raw);
 assert.equal(originalImagePrompt('/生图 GPT '+raw),raw);
 assert.equal(originalImagePrompt('/生图 '+raw),raw);
 assert.equal(originalImagePrompt('请用GPT画一只猫，不要改写'), '请用GPT画一只猫，不要改写');
 assert.equal(originalImagePrompt('/生图 ChatGPT字样的帽子'), 'ChatGPT字样的帽子');
});

test('model expansion is ignored and scope persists per chat and sender',async()=>{
 const received=[];const tool=createImageTool({ledger:new ImageRequestLedger(path.join(root,'requests.json')),cooldownMs:0,getConfig:()=>({allow:{group:['12345','12346']}}),generateChat:async args=>{received.push(args);return {buffer:png,mime:'image/png'};},saveImage:async()=>path.join(root,'image.png')});
 const execute=async(group,sender,mid)=>{
  const ctx={chatKey:'group:'+group,kind:'group',chatId:group,selfId:'77777',triggerEntries:[{mid,senderId:sender,directText:'/生图 Chat 生成一个deepseek鲸鱼娘的形象',atMe:true}],sender:{sendMedia:async()=>({message_id:mid+100})}};
  assert.equal((await tool.execute(ctx,{prompt:'模型擅自扩写的水手服和发饰',provider:'chat'})).isError,undefined);
 };
 await execute('12345','67890',1);await execute('12345','67890',2);await execute('12345','67891',3);await execute('12346','67890',4);
 assert.equal(received[0].prompt,'生成一个deepseek鲸鱼娘的形象');assert.equal(received[0].imageSessionKey,received[1].imageSessionKey);
 assert.notEqual(received[0].imageSessionKey,received[2].imageSessionKey);assert.notEqual(received[0].imageSessionKey,received[3].imageSessionKey);
 assert.match(received[0].imageSessionKey,/^[a-f0-9]{32}$/);
});

test('Chat transport forwards exact original prompt with no style or default ratio suffix',async()=>{
 const raw='画一颗蓝色星星\n保持原话  不加风格。';let submitted;
 const client=createCodexImageClient({engine:'chatgpt',readToken:()=> 'test-only',fetchImpl:async(url,options)=>{
  if(options.method==='POST'){submitted=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,data:{id:'a'.repeat(12),status:'failed',error_code:'blocked'}}));}
  throw Error('No other request expected');
 }});
 await assert.rejects(client({prompt:raw,requestKey:'test',imageSessionKey:'b'.repeat(32)}),error=>error.code==='blocked');
 assert.equal(submitted.prompt,raw);assert.equal(submitted.image_session_key,'b'.repeat(32));
});
