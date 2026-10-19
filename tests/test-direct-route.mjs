import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-web-route-'));process.env.QQ_AGENT_DATA_DIR=root;
const {createImageTool,ImageRequestLedger}=await import('../qq-agent/skills/local-image/index.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=','base64');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(text,fail=false){
 const calls={chat:0,native:0,gemini:0,sends:0};const entry={id:1,senderId:'67890',directText:text,atMe:true};
 const tool=createImageTool({getConfig:()=>({allow:{private:['67890']}}),ledger:new ImageRequestLedger(path.join(root,Math.random()+'.json')),
  generate:async()=>{calls.gemini++;return {buffer:png,mime:'image/png'};},generateGpt:async()=>{calls.native++;throw Error('Native must never run');},
  generateChat:async()=>{calls.chat++;if(fail)throw Object.assign(Error('auth'),{code:'auth'});return {buffer:png,mime:'image/png'};},saveImage:async()=>path.join(root,'image.png')});
 const ctx={chatKey:'private:67890',kind:'private',chatId:'67890',triggerEntries:[entry],sender:{sendMedia:async()=>{calls.sends++;return {message_id:123};}}};return {tool,ctx,calls};
}
test('all OpenAI wording selects Chat even if model suggests native',async()=>{
 for(const text of ['/生图 GPT 猫','/生图 ChatGPT 猫','/生图 Chat 猫','/生图 OpenAI 猫','用GPT画一只猫','用ChatGPT画一只猫','用Chat模式画一只猫']){
  const f=fixture(text);const r=await f.tool.execute(f.ctx,{prompt:'cat',provider:'gpt'});assert.equal(r.isError,undefined,text);assert.deepEqual(f.calls,{chat:1,native:0,gemini:0,sends:1});assert.equal(JSON.parse(r.content).provider,'chat');
 }
});
test('explicit Codex image is rejected before calling any image channel',async()=>{
 const f=fixture('/生图 Codex 猫');assert.match((await f.tool.execute(f.ctx,{prompt:'cat'})).content,/已关闭Codex/);assert.deepEqual(f.calls,{chat:0,native:0,gemini:0,sends:0});
});
test('Chat failure never falls back and duplicate request cannot regenerate',async()=>{
 const f=fixture('/生图 GPT 猫',true);assert.equal((await f.tool.execute(f.ctx,{prompt:'cat'})).isError,true);await f.tool.execute(f.ctx,{prompt:'cat'});assert.deepEqual(f.calls,{chat:1,native:0,gemini:0,sends:0});
});
test('Gemini default stays intact and caller cannot override raw request',async()=>{
 const f=fixture('/生图 猫');await f.tool.execute(f.ctx,{prompt:'cat',provider:'chat'});assert.deepEqual(f.calls,{chat:0,native:0,gemini:1,sends:1});
});
