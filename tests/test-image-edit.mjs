import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-image-edit-'));process.env.QQ_AGENT_DATA_DIR=root;
const {referenceEntries,loadReferenceImages,cachedGeneratedReference}=await import('../qq-agent/skills/local-image/image-inputs.js');
const {createImageTool,ImageRequestLedger}=await import('../qq-agent/skills/local-image/index.js');
const {createCodexImageClient}=await import('../qq-agent/skills/local-image/codex-image-client.js');
const {ChatStore}=await import('../qq-agent/src/store.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=','base64');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('only attached and explicitly quoted same-chat images are selected',()=>{
 const quoted={mid:8,media:[{kind:'image',url:'https://example.test/quoted'}]};let requested;
 const ctx={chatKey:'group:12345',store:{findByMid:(key,mid)=>{requested=[key,mid];return mid===8?quoted:null;}}};
 const entry={mid:9,directImageMedia:[{kind:'image',url:'https://example.test/direct'}],media:[{kind:'image',url:'https://example.test/forward-must-not-be-added'}],reply:{mid:8}};
 assert.deepEqual(referenceEntries(ctx,entry),[entry,quoted]);assert.deepEqual(requested,['group:12345',8]);
 assert.deepEqual(referenceEntries(ctx,{...entry,reply:null,directImageMedia:[]}),[]);
 const missing=referenceEntries(ctx,{...entry,reply:{mid:42},directImageMedia:[]});assert.equal(missing[0].missingReference,true);
});

test('image download validates formats, sizes and URL policy before upload',async()=>{
 const entry={media:[{kind:'image',url:'https://example.test/image'}]};let validated=0;
 const results=await loadReferenceImages({},[entry],{validateUrl:async url=>{validated++;return url;},fetchImage:async()=>({buffer:png})});
 assert.equal(validated,1);assert.equal(results[0].mime,'image/png');assert.equal(results[0].buffer,png);
 await assert.rejects(loadReferenceImages({},[entry],{validateUrl:async()=>{throw Error('private address');},fetchImage:async()=>{throw Error('must not fetch');}}),error=>error.code==='reference_image');
 await assert.rejects(loadReferenceImages({},[{missingReference:true}]),error=>error.code==='reference_image');
 await assert.rejects(loadReferenceImages({},[entry],{validateUrl:async url=>url,fetchImage:async()=>({buffer:Buffer.alloc(20)})}),error=>error.code==='reference_image');
});

test('QQ split submission binds only immediate same-sender image within five seconds',()=>{
 const image={id:10,mid:80,ts:100000,senderId:'67890',directText:'',directImageMedia:[{kind:'image',url:'https://example.test/input'}]};
 const entry={id:11,mid:81,ts:100000,senderId:'67890',directText:'/生图 Chat 改成红色',atMe:true,directImageMedia:[]};
 let records=[image,entry];const ctx={chatKey:'group:12345',store:{recent:(key)=>{assert.equal(key,'group:12345');return records;}}};
 assert.deepEqual(referenceEntries(ctx,entry),[image]);
 for(const patch of [{senderId:'123456'},{ts:94999},{recalled:true},{peerDirected:true},{self:true},{id:9},{directText:'随便聊天'},{directImageMedia:[]},{directImageMedia:undefined,media:image.directImageMedia}]){
  records=[{...image,...patch},entry];assert.deepEqual(referenceEntries(ctx,entry),[],JSON.stringify(patch));
 }
 records=[image,{id:10.5,mid:99,senderId:'other'},entry];assert.deepEqual(referenceEntries(ctx,entry),[]);
 records=[image,entry];assert.deepEqual(referenceEntries(ctx,{...entry,reply:{mid:123}})[0].missingReference,true);
});

test('split group command uploads the original adjacent image and preserves original prompt',async()=>{
 const image={id:10,mid:80,ts:100000,senderId:'67890',directText:'',directImageMedia:[{kind:'image',url:'https://example.test/input'}]};
 const entry={id:11,mid:81,ts:100000,senderId:'67890',directText:'/生图 Chat 生成蓝色鲸鱼与橙色小猫的合照',atMe:true,directImageMedia:[]};
 let generated=0;const tool=createImageTool({getConfig:()=>({allow:{group:['12345']}}),ledger:new ImageRequestLedger(path.join(root,'split.json')),loadReferences:async(ctx,refs)=>{assert.deepEqual(refs,[image]);return [{buffer:png,mime:'image/png'}];},generateChat:async args=>{assert.equal(args.prompt,'生成蓝色鲸鱼与橙色小猫的合照');assert.equal(args.inputImages.length,1);generated++;return {buffer:png,mime:'image/png'};},saveImage:async()=>path.join(root,'output.png')});
 const ctx={chatKey:'group:12345',kind:'group',chatId:'12345',triggerEntries:[entry],store:{recent:()=>[image,entry],findByMid:(key,mid)=>mid===80?image:entry},sender:{sendMedia:async()=>({message_id:123})}};
 assert.equal((await tool.execute(ctx,{prompt:'expanded'})).isError,undefined);assert.equal(generated,1);
});

test('natural request with conversational prefix is accepted without rewriting',async()=>{
 const entry={mid:91,senderId:'67890',atMe:true,directText:'那你给我生成一张类似的图片'};
 const tool=createImageTool({getConfig:()=>({allow:{group:['12345']},skills:{'local-image':{provider:'chat'}}}),ledger:new ImageRequestLedger(path.join(root,'natural-prefix.json')),generateChat:async args=>{assert.equal(args.prompt,entry.directText);return {buffer:png,mime:'image/png'};},saveImage:async()=>path.join(root,'output.png')});
 assert.equal((await tool.execute({chatKey:'group:12345',kind:'group',chatId:'12345',triggerEntries:[entry],sender:{sendMedia:async()=>({message_id:123})}},{prompt:'expanded'})).isError,undefined);
});

test('natural edit with an image selects Chat, preserves exact text and ignores model expansion',async()=>{
 let captured,sends=0;const entry={id:9,mid:9,senderId:'67890',atMe:true,directText:'把这张图里的蓝色圆球改成红色，其他保持不变',media:[{kind:'image',url:'https://example.test/source'}]};
 const tool=createImageTool({getConfig:()=>({allow:{group:['12345']}}),ledger:new ImageRequestLedger(path.join(root,'natural.json')),loadReferences:async(ctx,entries)=>{assert.deepEqual(entries,[entry]);return [{buffer:png,mime:'image/png'}];},generateChat:async args=>{captured=args;return {buffer:png,mime:'image/png'};},generate:async()=>{throw Error('unexpected default Gemini');},saveImage:async()=>path.join(root,'output.png')});
 const ctx={chatKey:'group:12345',kind:'group',chatId:'12345',selfId:'77777',triggerEntries:[entry],sender:{sendMedia:async()=>{sends++;return {message_id:123};}}};
 const result=await tool.execute(ctx,{prompt:'model expansion',provider:'gemini'});assert.equal(result.isError,undefined);assert.equal(captured.prompt,entry.directText);assert.equal(captured.inputImages.length,1);assert.equal(sends,1);
});

test('withdrawn reference stops before generation and cancellation text never invokes edit',async()=>{
 let generated=0;const quoted={mid:8,media:[{kind:'image',url:'https://example.test/ref'}]};const entry={mid:9,senderId:'67890',atMe:true,directText:'/生图 Chat 把照片改成素描',reply:{mid:8}};
 const ctx={chatKey:'group:12345',kind:'group',chatId:'12345',selfId:'77777',triggerEntries:[entry],store:{findByMid:(key,mid)=>mid===8?quoted:entry},sender:{sendMedia:async()=>{throw Error('must not send');}}};
 const tool=createImageTool({getConfig:()=>({allow:{group:['12345']}}),ledger:new ImageRequestLedger(path.join(root,'withdrawn.json')),loadReferences:async()=>{quoted.recalled=true;return [{buffer:png,mime:'image/png'}];},generateChat:async()=>{generated++;throw Error('must not generate');}});
 assert.match((await tool.execute(ctx,{prompt:'copy'})).content,/参考图片已撤回/);assert.equal(generated,0);
 entry.directText='把图片不要改成红色';quoted.recalled=false;
 assert.equal((await tool.execute(ctx,{prompt:'copy'})).isError,true);assert.equal(generated,0);
});

test('Chat transport sends reference bytes without accepting model-selected URLs or paths',async()=>{
 let submitted;
 const client=createCodexImageClient({engine:'chatgpt',readToken:()=> 'test-only',fetchImpl:async(url,options)=>{submitted=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,data:{id:'a'.repeat(12),status:'failed',error_code:'blocked'}}));}});
 await assert.rejects(client({prompt:'原话',requestKey:'key',inputImages:[{buffer:png,mime:'image/png'}]}),error=>error.code==='blocked');
 assert.equal(submitted.prompt,'原话');assert.equal(submitted.input_images[0].base64,png.toString('base64'));assert.equal(submitted.input_images[0].mime,'image/png');assert.equal(submitted.input_images[0].url,undefined);
});

test('message store persists authoritative quote and direct-image metadata',()=>{
 const store=new ChatStore();store.appendIncoming('group:12345',{mid:9,senderId:'67890',text:'[引用][图片]',directText:'改成红色',reply:{mid:8},media:[{kind:'image',url:'https://example.test/a'}],directImageMedia:[]});
 const reload=new ChatStore();const entry=reload.findByMid('group:12345',9);assert.equal(entry.reply.mid,8);assert.deepEqual(entry.directImageMedia,[]);assert.equal(entry.directText,'改成红色');
});

test('explicit image commands preserve negative visual constraints without treating them as cancellation',async()=>{
 for(const text of ['/生图 Chat 把这张图片里的蓝色圆球改成红色圆球，保持白色背景，不要文字。','/生图 Chat 一只猫，不要文字']){
  let generated=0;const tool=createImageTool({getConfig:()=>({allow:{private:['67890']}}),ledger:new ImageRequestLedger(path.join(root,Math.random()+'.json')),generateChat:async()=>{generated++;return {buffer:png,mime:'image/png'};},saveImage:async()=>path.join(root,'output.png')});
  const entry={mid:9,senderId:'67890',directText:text};const ctx={chatKey:'private:67890',kind:'private',chatId:'67890',triggerEntries:[entry],sender:{sendMedia:async()=>({message_id:1})}};
  assert.equal((await tool.execute(ctx,{prompt:'copy'})).isError,undefined,text);assert.equal(generated,1);
 }
 for(const text of ['/生图 Chat 不要画图','/生图 Chat 帮助']){
  const tool=createImageTool({getConfig:()=>({allow:{private:['67890']}}),ledger:new ImageRequestLedger(path.join(root,Math.random()+'.json')),generateChat:async()=>{throw Error('must not generate');}});
  const ctx={chatKey:'private:67890',kind:'private',chatId:'67890',triggerEntries:[{mid:9,senderId:'67890',directText:text}],sender:{sendMedia:async()=>{throw Error('must not send');}}};
  assert.equal((await tool.execute(ctx,{prompt:'copy'})).isError,true);
 }
});

test('confirmed generated-image cache is confined to the same chat and image directory',async()=>{
 const directory=path.join(root,'generated-images');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'cached.png');fs.writeFileSync(file,png);
 const ledgerFile=path.join(root,'image-generation-state.json');const record={status:'sent',messageId:22,file};fs.writeFileSync(ledgerFile,JSON.stringify([['private:67890:67890:mid:11',record]]));
 const ctx={chatKey:'private:67890'};assert.deepEqual(cachedGeneratedReference(ctx,{mid:22}),png);assert.equal(cachedGeneratedReference({chatKey:'private:67891'},{mid:22}),null);
 const own={mid:22,self:true,media:[]};const refs=referenceEntries({...ctx,store:{findByMid:()=>own}},{mid:23,reply:{mid:22}});assert.equal(refs.length,1);assert.equal(refs[0].directImageMedia[0].cachedGenerated,true);
 const entry={mid:22,self:true,media:[{kind:'image',file:'cached-id',url:''}]};const result=await loadReferenceImages(ctx,[entry],{fetchImage:async()=>{throw Error('cache should not need network');}});assert.deepEqual(result[0].buffer,png);
 const outside=path.join(root,'outside.png');fs.writeFileSync(outside,png);record.file=outside;fs.writeFileSync(ledgerFile,JSON.stringify([['private:67890:67890:mid:11',record]]));assert.equal(cachedGeneratedReference(ctx,{mid:22}),null);
 fs.unlinkSync(ledgerFile);
});
