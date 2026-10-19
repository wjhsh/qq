import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerHarness, formatQuotas } from './owner-harness.mjs';

function fixture() {
  const requests = [], replies = [];
  const handler = createOwnerHarness({ ownerConsole: { authorized: (ctx) => ctx.chatKey === 'private:42' && ctx.triggerEntries[0].senderId === '42' },
    sendReply: async (...args) => replies.push(args), sendFile: async () => { throw Error('unexpected send'); }, dataDir: '/tmp',
    request: async (...args) => { requests.push(args); return { id: 'abcdef123456', status: 'queued' }; } });
  const call = (text, chatKey = 'private:42', senderId = '42', segments = [{ type: 'text', data: { text } }]) => handler.handle({ chatKey, senderId, segments });
  return { requests, replies, call };
}

test('only original owner private commands submit jobs', async () => {
  const f = fixture();
  await f.call('/任务 create report', 'group:42');
  await f.call('/任务 create report', 'private:43', '43');
  await f.call('', 'private:42', '42', [{ type: 'reply', data: {} }, { type: 'text', data: { text: '/任务 create report' } }]);
  await f.call('> /任务 create report');
  assert.equal(f.requests.length, 0);
  assert.equal(f.replies.length, 0);
  await f.call('/任务 create report');
  assert.deepEqual(f.requests, [['/jobs', { prompt: 'create report' }]]);
  assert.equal(f.replies.length, 1);
});

test('restart shell injection is rejected before requesting broker', async () => {
  const f = fixture();
  await f.call('/维护 重启 qq-agent;whoami');
  await f.call('/维护 重启 ssh');
  assert.equal(f.requests.length, 0);
  assert.equal(f.replies.length, 2);
});

test('cancel validates id and dispatches fixed endpoint', async () => {
  const f = fixture();
  await f.call('/任务 取消 ../../maintenance');
  assert.equal(f.requests.length, 0);
  await f.call('/任务 取消 abcdef123456');
  assert.deepEqual(f.requests, [['/jobs/abcdef123456/cancel', {}]]);
});

test('only the configured group and owner can read quotas or change routes', async () => {
  let allowed = true;
  const requests = [], replies = [];
  const h = createOwnerHarness({ dataDir: '/tmp', getConfig: () => ({ allow: { groups: ['99'] }, harnessControl: { enabled: allowed, groupIds: ['99'] } }),
    ownerConsole: { authorized: (ctx, options) => ctx.chatKey === 'private:42' && ctx.triggerEntries[0].senderId === '42' && options?.groupId === '99' },
    sendReply: async (chat, text) => replies.push([chat, text]), request: async (...args) => { requests.push(args); return { google: { available: false }, traffic: { available: false } }; } });
  const run = (text, chatKey = 'group:99', senderId = '42') => h.handle({ chatKey, senderId, segments: [{ type: 'text', data: { text } }] });
  await run('/额度', 'group:98');
  await run('/额度', 'group:99', '43');
  await run('/任务 结果 abcdef123456');
  assert.equal(requests.length, 0);
  await run('/额度');
  assert.equal(requests.length, 1);
  assert.equal(replies[0][0], 'group:99');
  assert.match(replies[0][1], /不代表额度为零/);
  allowed = false;
  await run('/额度');
  assert.equal(requests.length, 1);
});

test('members of any allowed group can query but cannot mutate or read private tasks', async () => {
  const requests = [];
  const cfg = { allow: { groups: ['99', '98'] }, deny: { groups: [] }, harnessControl: { enabled: true, groupMode: 'allowlist', readForMembers: true } };
  const h = createOwnerHarness({ dataDir: '/tmp', getConfig: () => cfg, ownerConsole: { authorized: () => false },
    sendReply: async () => {}, request: async (...args) => { requests.push(args); return { google: { available: false }, traffic: { available: false } }; } });
  const run = (text, chatKey = 'group:99') => h.handle({ chatKey, senderId: '43', segments: [{ type: 'text', data: { text } }] });
  await run('/额度');
  await run('/额度', 'group:98');
  assert.equal(requests.length, 2);
  for (const text of ['/线路 自动', '/线路 切换 A', '/维护 重启 qq-agent', '/任务 结果 abcdef123456']) await run(text);
  await run('/额度', 'group:97');
  assert.equal(requests.length, 2);
  cfg.deny.groups = ['99'];
  await run('/额度');
  cfg.deny.groups = [];
  cfg.blocklist = { 99: ['43'] };
  await run('/额度');
  assert.equal(requests.length, 2);
});

test('owner task files cross a separate protocol filesystem without sharing host paths', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-owner-file-'));
  const sent=[],bytes=Buffer.from('任务文件内容','utf8');
  try{
    const h=createOwnerHarness({dataDir:directory,getConfig:()=>({}),ownerConsole:{authorized:()=>true},sendReply:async()=>{},
      request:async()=>({name:'result.txt',base64:bytes.toString('base64')}),
      sendFile:async(chat,ref,name,authorize)=>{assert.equal(authorize(),true);sent.push({chat,ref,name});}});
    await h.handle({chatKey:'private:42',senderId:'42',segments:[{type:'text',data:{text:'/任务 文件 abcdef123456 result.txt'}}]});
    assert.equal(sent.length,1);assert.equal(sent[0].chat,'private:42');assert.equal(sent[0].name,'result.txt');
    assert.deepEqual(Buffer.from(sent[0].ref.slice('base64://'.length),'base64'),bytes);
    assert.ok(sent[0].ref.startsWith('base64://'));
  }finally{
    assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory,{recursive:true});
  }
});

test('route commands validate targets and quota output never guesses missing values', async () => {
  const f = fixture();
  await f.call('/线路 切换 A;whoami');
  await f.call('/线路 切换 DIRECT');
  assert.equal(f.requests.length, 0);
  const text = formatQuotas({ google: { available: true, models: [{ model: 'test', remaining_percent: null }] }, traffic: { available: false } });
  assert.match(text, /test：未知/);
  assert.doesNotMatch(text, /0%|undefined|NaN/);
});
