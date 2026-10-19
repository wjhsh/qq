import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createOwnerConsole } from '/opt/codex-qq/QQ-agent/src/owner-console.js';
import { createOwnerHarness, createHarnessClient, controlGroup } from '/opt/codex-qq/QQ-agent/src/owner-harness.js';
const cfg=JSON.parse(fs.readFileSync('/var/lib/qq-agent/config.json','utf8'));
const noop=()=>({});
const ownerConsole=createOwnerConsole({ownerIds:cfg.ownerConsole.ownerIds,getConfig:()=>cfg,listGroups:noop,readMessages:noop,
  getGroupMemory:noop,appendGroupMemory:noop,saveGroupStyle:noop,editGroupMemory:noop,roleDraft:noop});
const fetch=createHarnessClient();
const replies=[], mutations=[];
const commands=createOwnerHarness({ownerConsole,getConfig:()=>cfg,dataDir:'/tmp',sendReply:async(chat,text)=>replies.push({chat,text}),
  request:async(route,body)=>{if(body)mutations.push(route);return fetch(route,body);}});
const groups=(cfg.allow.group??cfg.allow.groups).map(String);
assert.equal(groups.length,4);
const guest='100000001';
assert.ok(!cfg.ownerConsole.ownerIds.map(String).includes(guest));
const call=(text,id,senderId=guest)=>commands.handle({chatKey:`group:${id}`,senderId,segments:[{type:'text',data:{text}}]});
for(const id of groups){
  assert.ok(controlGroup(cfg,id));
  const before=replies.length;
  await call('/额度',id);
  assert.equal(replies.length,before+1);
  assert.equal(replies.at(-1).chat,`group:${id}`);
  assert.match(replies.at(-1).text,/Google Antigravity 配额/);
  assert.match(replies.at(-1).text,/剩余.*GiB/);
  await call('/线路 自动',id);
  await call('/维护 重启 qq-agent',id);
}
assert.equal(mutations.length,0);
const previous=replies.length;
await call('/额度','100000002');
assert.equal(replies.length,previous);
assert.equal(cfg.harnessControl.commandOnlyGroups.length,2);
console.log(JSON.stringify({groups_verified:groups,member_quota_replies:4,guest_mutations:0,command_only_groups:cfg.harnessControl.commandOnlyGroups,test_messages_sent:false}));
