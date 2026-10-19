// Public Bili reads + one model extraction; all replies and library writes are local fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {getConfig} from '/opt/codex-qq/QQ-agent/src/config.js';
import {chatCompletion,resolveApiKey} from '/opt/codex-qq/QQ-agent/src/llm.js';
import {createMemeExtractor} from '/opt/codex-qq/QQ-agent/src/meme-extractor.mjs';
import {BiliHttpReader} from '/opt/codex-qq/QQ-agent/src/bili-reader.mjs';
import {MemeLibrary} from '/opt/codex-qq/QQ-agent/src/meme-library.mjs';
import {createCommunityCommands} from '/opt/codex-qq/QQ-agent/src/community-commands.mjs';
import {roleIdentity} from '/opt/codex-qq/QQ-agent/src/role-isolation.mjs';
import {buildToolDefs} from '/opt/codex-qq/QQ-agent/src/tools.js';
import {getToolAvailability} from '/opt/codex-qq/QQ-agent/src/tool-registry.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-community-live-')),reader=new BiliHttpReader();
try{
  const cfg=getConfig(),owner=String(cfg.ownerConsole.ownerIds[0]),gid=String((cfg.allow.group??cfg.allow.groups)[0]);
  const chatKey='group:'+gid,scope={chatKey,roleId:roleIdentity(cfg,chatKey).id};
  const library=new MemeLibrary({filePath:path.join(dir,'memes.json')}),replies=[];
  const commands=createCommunityCommands({getConfig,getSelfId:()=>9,access:{canRead:()=>true,canManage:()=>true},roleIdentity,biliReader:reader,memeLibrary:library,
    extractCandidates:createMemeExtractor({getConfig,chatCompletion,resolveApiKey}),sendReply:async(key,text,guard)=>{assert.ok(guard());replies.push(text);}});
  const event=text=>({chatKey,senderId:owner,segments:[{type:'at',data:{qq:9}},{type:'text',data:{text}}]});
  await commands.handle(event('/B站 搜索 凑企鹅 高松灯'));
  assert.match(replies.at(-1),/https:\/\/www\.bilibili\.com\/video\/BV/);
  console.log(JSON.stringify({phase:'command_search',ok:true,qq_messages_sent:0}));
  await commands.handle(event('/梗库 采集 BV1SdhgzCEXs'));
  const entries=library.list(scope);
  console.log(JSON.stringify({phase:'collection',candidate_count:entries.length,candidate_titles:entries.map(x=>x.title),reply:replies.at(-1).slice(0,350),production_library_changed:false,qq_messages_sent:0}));
  assert.ok(entries.length>0,'Live collection produced no candidates');
  assert.ok(entries.every(x=>x.status==='pending'));
  const definitions=buildToolDefs();
  const availability=['bili_search','bili_read','meme_search'].map(id=>({id,registered:definitions.some(x=>x.id===id),...getToolAvailability(id,{toolsCfg:cfg.tools||{},searchEnabled:cfg.webSearch?.enabled!==false,visionEnabled:true})}));
  assert.ok(availability.every(x=>x.registered&&x.enabled));
  console.log(JSON.stringify({phase:'model_tools',tools:availability.map(({id,enabled})=>({id,enabled})),all_passed:true}));
}finally{reader.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'qq-community-live-')));fs.rmSync(dir,{recursive:true,force:true});}
