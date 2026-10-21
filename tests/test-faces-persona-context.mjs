import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {requirePlainTextMessages} from '../qq-agent/src/message-markup.mjs';
import {sharedEntriesForContext} from '../qq-agent/src/memory-context-policy.mjs';
import {NATURAL_CHAT_VERSION, NORMAL_ROLE_CARD} from '../qq-agent/src/natural-chat.mjs';

const tools=fs.readFileSync(new URL('../qq-agent/src/tools.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function textTool(){
 let tool;
 const start=tools.indexOf("  registerTool({\n    id: 'send_message'");
 const end=tools.indexOf("  registerTool({\n    id: 'send_to'",start);
 assert.ok(start>0&&end>start);
 new Function('registerTool','normalizeMessageList','requirePlainTextMessages','ok','err','FINISH_AFTER_SEND_RECEIPT',tools.slice(start,end))(
  value=>{tool=value;},value=>Array.isArray(value)?value:[value],requirePlainTextMessages,
  value=>({content:JSON.stringify(value)}),value=>({isError:true,content:String(value)}),Symbol('receipt'));
 return tool;
}
function context(){
 const calls=[];
 return {calls,ctx:{chatKey:'group:10001',session:{id:'test',sent:[]},emit(){},sender:{async sendTextBatch(key,messages){calls.push({key,messages});return {sent:messages.map(text=>({text,messageId:123,at:'now'})),failed:[]};}}}};
}

test('fake system-face and sticker placeholders are rejected before any text is sent',async()=>{
 for(const messages of [['你好 [表情178]'],['[表情包:呆呆吐舌头卖萌]'],['正常第一条','[表情178]']]){
  const {ctx,calls}=context();const result=await textTool().execute(ctx,{messages,finishAfterSend:true});
  assert.equal(result.isError,true);assert.equal(calls.length,0);assert.equal(ctx.session.sent.length,0);
  assert.match(result.content,/没有发送/);assert.equal(Object.getOwnPropertySymbols(result).length,0);
 }
});

test('tool errors tell the model the concrete native face id or sticker tool to use',()=>{
 assert.throws(()=>requirePlainTextMessages(['[表情178]']),error=>error.code==='MEDIA_MARKER_REQUIRES_TOOL'&&error.message.includes('faceId=178'));
 assert.throws(()=>requirePlainTextMessages(['[表情包：卖萌]']),/list_stickers.*send_sticker/);
});

test('ordinary text, unicode emoji and explanations without fake media markup still send',async()=>{
 const {ctx,calls}=context();const messages=['收到 😵‍💫','QQ 178号表情是斜眼笑','这只是[备注]'];
 const result=await textTool().execute(ctx,{messages});
 assert.notEqual(result.isError,true);assert.deepEqual(calls[0].messages,messages);assert.equal(ctx.session.sent.length,3);
});

test('obsolete style notes are suppressed only for their configured group',()=>{
 const entries=[{id:6,content:'旧猫娘风格'},{id:14,content:'结尾要带喵'},{id:20,content:'群友的稳定事实'}];
 const original=structuredClone(entries),config={sharedMemory:{suppressedContextEntryIdsByGroup:{10001:[6,14]}}};
 assert.deepEqual(sharedEntriesForContext(config,'group:10001',entries),[entries[2]]);
 assert.deepEqual(sharedEntriesForContext(config,'group:10002',entries),entries);
 assert.deepEqual(sharedEntriesForContext(config,'private:10001',entries),entries);
 assert.deepEqual(entries,original);
});

test('without a suppression policy all source entries remain available',()=>{
 const entries=[{id:14,content:'a'}];assert.equal(sharedEntriesForContext({},'group:10001',entries),entries);
});

test('expression revision changes the history boundary without replacing the role card',()=>{
 assert.equal(NATURAL_CHAT_VERSION,2);assert.equal(NORMAL_ROLE_CARD.id,'hajimi-normal');
 assert.match(NORMAL_ROLE_CARD.text,/猫耳和尾巴/);
 const source=fs.readFileSync(new URL('../qq-agent/src/role-isolation.mjs',import.meta.url),'utf8');
 const start=source.indexOf('export function filterRoleHistory('),end=source.indexOf('\nexport function roleBoundaryRules',start);
 const filter=new Function('roleIdentity',source.slice(start,end).replace('export function','function')+';return filterRoleHistory;')(()=>({scope:'same-card:new-expression'}));
 const records=[{self:true,personaScope:'same-card:old-expression',text:'旧口癖'},{self:false,text:'群友事实'},{self:true,personaScope:'same-card:new-expression',text:'当前回应'}];
 assert.deepEqual(filter({roleIsolation:{enabled:true}},'group:10001',records),records.slice(1));
 assert.equal(records.length,3);
});
