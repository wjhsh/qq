import test from 'node:test';
import assert from 'node:assert/strict';
import {GeminiVoice,audioFromInteraction,registerVoiceTool} from '../qq-agent/src/gemini-voice.mjs';
import {createVoiceTool,setup} from '../qq-agent/skills/local-voice/index.js';
import {setRuntimeConfig,DEFAULT_CONFIG,deepMerge} from '../qq-agent/src/config.js';
function wav(){const b=Buffer.alloc(52);b.write('RIFF');b.writeUInt32LE(44,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(8,40);return b;}
const response=()=>({status:'completed',steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/wav',data:wav().toString('base64')}]}]});
const config={voice:{enabled:true,model:'gemini-3.8-flash-lite-tts',voice:'Kore',apiKeyEnv:'TEST_TTS_KEY'}};
test('Google TTS uses verbatim transcript with separate style metadata and actual WAV bytes',async()=>{
  let request;const client=new GeminiVoice({getConfig:()=>config,env:{TEST_TTS_KEY:'test-only'},fetchImpl:async(url,options)=>{request={url,...options};return new Response(JSON.stringify(response()));}});
  const text='才没有等你，罐头都凉了。',out=await client.synthesize({chatKey:'group:12345',text,style:'playful'});
  const body=JSON.parse(request.body);assert.equal(body.input[0].content[0].text,text);assert.equal(body.model,config.voice.model);
  assert.match(request.url,/generativelanguage\.googleapis\.com\/v1beta\/interactions$/);assert.equal(request.redirect,'error');
  assert.equal(out.bytes.toString('ascii',0,4),'RIFF');assert.equal(out.usage,null);
});
test('missing auth never becomes subscription fallback and calls no network',async()=>{
  let calls=0;const c=new GeminiVoice({getConfig:()=>config,env:{},fetchImpl:async()=>calls++});
  assert.equal(c.available(),false);await assert.rejects(c.synthesize({chatKey:'group:12345',text:'你好'}),/VOICE_NOT_CONFIGURED/);assert.equal(calls,0);
});
test('unrecognized, multi-audio, non-WAV and unfinished responses are rejected',()=>{
  for(const data of [{}, {...response(),status:'in_progress'}, {steps:[{type:'model_output',content:[{type:'audio',data:'AAAA'}]}]},
    {steps:[{type:'model_output',content:[...response().steps[0].content,...response().steps[0].content]}]}])assert.throws(()=>audioFromInteraction(data),/VOICE_/);
});
test('failed calls consume bounded attempts, no retry, no upstream body or key in errors',async()=>{
  let calls=0;const c=new GeminiVoice({getConfig:()=>config,env:{TEST_TTS_KEY:'secret-key'},fetchImpl:async()=>{calls++;return new Response('secret-upstream',{status:429});}});
  await assert.rejects(c.synthesize({chatKey:'group:12345',text:'你好'}),/VOICE_HTTP_429/);
  await assert.rejects(c.synthesize({chatKey:'group:12345',text:'你好'}),/VOICE_BUSY_OR_LIMITED/);assert.equal(calls,1);
});
test('voice tool returns a real current-chat record receipt without writing audio files',async()=>{
  let tool,segments;registerVoiceTool(x=>tool=x,{getConfig:()=>config});const ctx={kind:'group',chatKey:'group:12345',triggerEntries:[{atMe:true,directText:'用语音说一句你好'}],
    voice:{available:()=>true,synthesize:async()=>({bytes:wav(),dedupeKey:'key'})},onebot:{call:async()=>({yes:true})},sender:{sendMedia:async(chat,s)=>{assert.equal(chat,ctx.chatKey);segments=s;return{message_id:123};}},session:{sent:[]}};
  const out=await tool.execute(ctx,{text:'你好'});assert.equal(out.isError,false);assert.equal(segments[0].type,'record');assert.match(segments[0].data.file,/^base64:\/\//);
  assert.equal(ctx.session.sent[0].type,'voice');assert.equal((await tool.execute(ctx,{text:'再发'})).isError,true);
});
test('voice tool respects no-voice request, transport capability, aborts and false receipts',async()=>{
  let tool,calls=0;registerVoiceTool(x=>tool=x,{getConfig:()=>config});const ctx={kind:'private',chatKey:'private:12345',triggerEntries:[{directText:'不要语音'}],voice:{available:()=>true,synthesize:async()=>{calls++;return{bytes:wav(),dedupeKey:'key'};}},onebot:{call:async()=>({yes:true})},sender:{sendMedia:async()=>({})},session:{sent:[]}};
  assert.equal((await tool.execute(ctx,{text:'你好'})).isError,true);assert.equal(calls,0);
  ctx.triggerEntries=[{directText:'朗读这句话'}];const out=await tool.execute(ctx,{text:'你好'});assert.equal(out.isError,true);assert.equal(ctx.session.sent.length,0);
});
test('existing speech proxy is attached per client without changing global routing',async()=>{
  let options;const c=new GeminiVoice({getConfig:()=>config,env:{TEST_TTS_KEY:'test-only',QQ_AGENT_SPEECH_PROXY:'http://127.0.0.1:7890'},fetchImpl:async(url,o)=>{options=o;return new Response(JSON.stringify(response()));}});
  try{await c.synthesize({chatKey:'group:12345',text:'你好'});assert.ok(options.dispatcher);}finally{await c.close();}
});
test('one existing plugin entry selects a single backend and Edge delivery still accepts finishAfterSend',async()=>{
  let defs=[];setRuntimeConfig(deepMerge(structuredClone(DEFAULT_CONFIG),{voice:{provider:'gemini'}}));setup({registerTool:d=>defs.push(d)});
  assert.equal(defs.length,1);assert.equal(defs[0].voiceProvider,'gemini');
  defs=[];setRuntimeConfig(deepMerge(structuredClone(DEFAULT_CONFIG),{voice:{provider:'edge'}}));setup({registerTool:d=>defs.push(d)});
  assert.equal(defs.length,1);assert.equal(defs[0].voiceProvider,undefined);
  const edge=createVoiceTool({synthesize:async()=>wav()}),ctx={chatKey:'group:12345',sender:{sendMedia:async()=>({message_id:987})},session:{sent:[]}};
  const out=await edge.execute(ctx,{text:'你好',finishAfterSend:true});assert.notEqual(out.isError,true);assert.equal(ctx.session.sent.length,1);
});
