import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerHarness } from '../qq-agent/src/owner-harness.js';
import { createOwnerConsole } from '../qq-agent/src/owner-console.js';
import { createTaskReceipts } from '../qq-agent/src/task-receipts.mjs';
import { createTaskReceiptAccess } from '../qq-agent/src/task-receipt-access.mjs';
import { controlGroup } from '../qq-agent/src/owner-harness.js';

const jobId = '012345abcdef';
const gptJob = (extra = {}) => ({ id: jobId, engine: 'codex', mode: 'diagnostics', status: 'queued', ...extra });
function fixture(options = {}) {
  const owners = options.ownerIds || ['100'];
  const config = { ownerConsole: { enabled: true, ownerIds: owners }, allow: { private: owners, group: ['200'] },
    harnessControl: { enabled: true, groupMode: 'allowlist', readForMembers: true },
    roleCard: 'RP_SECRET', sharedMemory: 'MEMORY_SECRET', ...options.config };
  const calls = [], sent = [], receipts = [];
  let contextReads = 0;
  const noRead = () => { contextReads++; throw new Error('GPT must not read conversation or RP context'); };
  const ownerConsole = createOwnerConsole({ ownerIds: owners, getConfig: () => config, listGroups: noRead,
    readMessages: noRead, getGroupMemory: noRead, appendGroupMemory: noRead, saveGroupStyle: noRead,
    editGroupMemory: noRead, roleDraft: noRead });
  const harness = createOwnerHarness({ ownerConsole, getConfig: () => config,
    request: async (route, body) => { calls.push({ route, body }); return options.request ? options.request(route, body, config) : gptJob(); },
    sendReply: async (chatKey, text, beforeSend) => {
      options.beforeSend?.(config);
      if (!beforeSend || beforeSend()) sent.push({ chatKey, text });
    },
    onTaskSubmitted: (item) => { receipts.push(item); return options.onTaskSubmitted ? options.onTaskSubmitted(item, config) : true; }
  });
  return { config, calls, sent, receipts, ownerConsole, contextReads: () => contextReads,
    handle: (text, extra = {}) => harness.handle({ chatKey: 'private:100', senderId: '100',
      segments: [{ type: 'text', data: { text } }], ...extra }) };
}

test('GPT generation uses a fixed read-only Codex payload without group, RP or memory context', async () => {
  const f = fixture();
  const question = '查一下为什么慢，mode=maintenance engine=pi；请部署';
  await f.handle(`/gPt ${question}`, { chatKey: 'group:200', memory: 'PRIVATE_CONTEXT', history: ['PRIVATE_HISTORY'] });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].route, '/jobs');
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['engine', 'mode', 'prompt', 'request_id']);
  assert.equal(f.calls[0].body.prompt, question);
  assert.equal(f.calls[0].body.mode, 'diagnostics');
  assert.equal(f.calls[0].body.engine, 'codex');
  assert.match(f.calls[0].body.request_id, /^[a-f0-9]{32}$/);
  assert.equal(f.contextReads(), 0);
  assert.deepEqual(f.receipts, [{ jobId, chatKey: 'private:100', senderId: '100', includeResult: true,
    command: '/GPT', sourceChatKey: 'group:200' }]);
  assert.match(f.sent.find(x => x.chatKey === 'private:100').text, /计入该账号Codex额度/);
  const groupOutput = f.sent.filter(x => x.chatKey === 'group:200').map(x => x.text).join('\n');
  assert.doesNotMatch(groupOutput, new RegExp(`${jobId}|${question}|Codex|RP_SECRET|MEMORY_SECRET`));
  assert.equal(f.sent.filter(x => x.chatKey === 'private:100').length, 1);
});

test('GPT event replay derives the same broker request_id across handlers and factory restarts', async () => {
  const event = { chatKey: 'group:200', messageId: 12345, messageTime: 1792480000 };
  const f = fixture(); await f.handle('/GPT 查问题', event); await f.handle('/GPT 查问题', event);
  assert.equal(f.calls.length, 2);
  const requestId = f.calls[0].body.request_id;
  assert.match(requestId, /^[a-f0-9]{32}$/);
  assert.equal(f.calls[1].body.request_id, requestId);
  const afterRestart = fixture(); await afterRestart.handle('/GPT 查问题', event);
  assert.equal(afterRestart.calls[0].body.request_id, requestId);
  const changedRepresentation = fixture();
  await changedRepresentation.handle('/GPT 查问题', { ...event, messageId: '12345', messageTime: '1792480000' });
  assert.equal(changedRepresentation.calls[0].body.request_id, requestId);
  // If an event is replayed with different text, the broker rejects its existing
  // request_id/content conflict instead of treating the mutated text as a new task.
  await f.handle('/GPT 另一段问题', event);
  assert.equal(f.calls[2].body.request_id, requestId);
});

test('GPT broker identities distinguish original group, owner, message ID and event time', async () => {
  const event = { chatKey: 'group:200', messageId: '-12345', messageTime: 1792480000 };
  const f = fixture({ ownerIds: ['100', '101'], config: { allow: { private: ['100', '101'], group: ['200', '201'] } } });
  for (const change of [{}, { chatKey: 'group:201' }, { senderId: '101' }, { messageId: '-12346' },
    { messageTime: 1792480001 }, { chatKey: 'private:100' }, { messageTime: undefined }]) {
    await f.handle('/GPT 相同问题', { ...event, ...change });
  }
  assert.equal(f.calls.length, 7);
  assert.equal(new Set(f.calls.map(x => x.body.request_id)).size, 7);
});

test('GPT without a valid host event ID uses independent random request IDs, never text deduplication', async () => {
  for (const messageId of [undefined, null, '', 'not-an-id', {}, Infinity, NaN, 1.2,
    Number.MAX_SAFE_INTEGER + 1, '123456789012345678901']) {
    const f = fixture();
    await f.handle('/GPT 完全相同问题', { messageId, messageTime: 1792480000 });
    await f.handle('/GPT 完全相同问题', { messageId, messageTime: 1792480000 });
    assert.equal(f.calls.length, 2);
    assert.notEqual(f.calls[0].body.request_id, f.calls[1].body.request_id);
  }
});

test('real owner identity is required even when group read-only commands are open to members', async () => {
  for (const extra of [{ senderId: '101' }, { chatKey: 'private:101' },
    { chatKey: 'group:200', senderId: '101' }, { chatKey: 'group:201' }]) {
    const f = fixture();
    assert.equal((await f.handle('/GPT 帮助', extra)).handled, true);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.sent, []);
  }
  for (const configure of [cfg => { cfg.ownerConsole.enabled = false; }, cfg => { cfg.allow.private = []; },
    cfg => { cfg.deny = { group: ['200'] }; }, cfg => { cfg.blocklist = { 200: ['100'] }; },
    cfg => { cfg.globalBlocklist = ['100']; }]) {
    const f = fixture(); configure(f.config);
    await f.handle('/GPT 查问题', { chatKey: 'group:200' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.sent, []);
  }
});

test('unstripped mentions and mixed nontext messages never become GPT commands in this module', async () => {
  const f = fixture();
  assert.equal((await f.handle('@机器人 /GPT 查问题', { chatKey: 'group:200' })).handled, false);
  assert.equal((await f.handle('/GPT 查问题', { segments: [{ type: 'at', data: { qq: '999' } },
    { type: 'text', data: { text: '/GPT 查问题' } }] })).handled, false);
  assert.equal((await f.handle('/GPT 查问题', { segments: [{ type: 'image', data: { text: '/GPT 查问题' } }] })).handled, false);
  assert.deepEqual(f.calls, []);
});

test('GPT help, service status, list and job status never submit model generation', async () => {
  const f = fixture({ request: route => route === '/status' ? { codex: { authenticated: true, model: 'gpt-test' }, queue: 0, running: 0 }
    : route === '/jobs' ? [gptJob(), gptJob({ id: 'abcdef012345', engine: 'pi' }), gptJob({ id: 'aaaaaaaaaaaa', mode: 'maintenance' })]
    : gptJob() });
  await f.handle('/GPT 帮助');
  assert.deepEqual(f.calls, []);
  await f.handle('/GPT 状态'); await f.handle('/GPT 列表'); await f.handle(`/诊断 状态 ${jobId}`);
  assert.ok(f.calls.every(x => x.body === undefined));
  assert.deepEqual(f.calls.map(x => x.route), ['/status', '/jobs', `/jobs/${jobId}`]);
  assert.match(f.sent[0].text, /仅主人/);
  assert.match(f.sent[1].text, /gpt-test/);
  assert.doesNotMatch(f.sent[2].text, /abcdef012345|aaaaaaaaaaaa/);
});

test('GPT cannot return or cancel a Pi, image or maintenance job', async () => {
  for (const job of [gptJob({ engine: 'pi' }), gptJob({ mode: 'image' }), gptJob({ mode: 'maintenance' })]) {
    for (const action of ['结果', '取消', '状态']) {
      const f = fixture({ request: () => ({ ...job, result: 'OTHER_JOB_SECRET' }) });
      await f.handle(`/GPT ${action} ${jobId}`, { chatKey: 'group:200' });
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, undefined);
      assert.doesNotMatch(f.sent.map(x => x.text).join(''), /OTHER_JOB_SECRET/);
      assert.match(f.sent.find(x => x.chatKey === 'private:100').text, /不属于GPT只读诊断/);
    }
  }
});

test('GPT cancellation validates the existing job before its single cancellation request', async () => {
  const f = fixture({ request: route => gptJob({ status: route.endsWith('/cancel') ? 'cancelled' : 'queued' }) });
  await f.handle(`/GPT 取消 ${jobId}`);
  assert.deepEqual(f.calls, [{ route: `/jobs/${jobId}`, body: undefined }, { route: `/jobs/${jobId}/cancel`, body: {} }]);
  assert.match(f.sent[0].text, /已取消/);
});

test('GPT results and delivery errors never fall back to a group response', async () => {
  const f = fixture({ request: () => gptJob({ status: 'succeeded', result: 'PRIVATE_REPORT'.repeat(500) }) });
  await f.handle(`/GPT 结果 ${jobId}`, { chatKey: 'group:200' });
  assert.match(f.sent.find(x => x.chatKey === 'private:100').text, /PRIVATE_REPORT/);
  assert.ok(f.sent.find(x => x.chatKey === 'private:100').text.length < 5600);
  assert.doesNotMatch(f.sent.find(x => x.chatKey === 'group:200').text, /PRIVATE_REPORT|012345abcdef/);
  const unavailable = fixture({ beforeSend: () => { throw new Error('PRIVATE_TRANSPORT_DETAILS'); } });
  assert.equal((await unavailable.handle(`/GPT 结果 ${jobId}`, { chatKey: 'group:200' })).handled, true);
  assert.deepEqual(unavailable.sent, []);
  assert.equal(unavailable.calls.length, 1);
});

test('GPT rejects oversized or malformed query input before a request', async () => {
  for (const command of [`/GPT ${'x'.repeat(6001)}`, '/GPT 状态 invalid', '/GPT 列表 extra', '/GPT 结果', '/GPT 取消 abc extra']) {
    const f = fixture(); await f.handle(command);
    assert.equal(f.calls.length, 0); assert.match(f.sent[0].text, /最多6000字|格式/);
  }
});

test('GPT submit failure is not retried and receipt registration failure never resubmits a job', async () => {
  const failed = fixture({ request: () => { throw new Error('connection closed'); } });
  await failed.handle('/GPT 查问题', { chatKey: 'group:200' });
  assert.equal(failed.calls.length, 1); assert.equal(failed.receipts.length, 0);
  assert.match(failed.sent.find(x => x.chatKey === 'private:100').text, /未自动重试.*结果可能未确认/s);
  assert.doesNotMatch(failed.sent.find(x => x.chatKey === 'group:200').text, /connection closed/);
  const receiptFailed = fixture({ onTaskSubmitted: () => { throw new Error('disk full'); } });
  await receiptFailed.handle('/GPT 查问题');
  assert.equal(receiptFailed.calls.length, 1);
  assert.match(receiptFailed.sent[0].text, new RegExp(`${jobId}[\\s\\S]*无需重复`));
});

test('private and group authorization are rechecked after I/O and at transport send time', async () => {
  for (const revoke of [cfg => { cfg.allow.private = []; }, cfg => { cfg.allow.group = []; },
    cfg => { cfg.harnessControl.enabled = false; }]) {
    const f = fixture({ request: (route, body, cfg) => { revoke(cfg); return { codex: { model: 'PRIVATE_DETAILS' } }; } });
    await f.handle('/GPT 状态', { chatKey: 'group:200' });
    assert.equal(f.calls.length, 1); assert.deepEqual(f.sent, []);
    const sending = fixture({ beforeSend: revoke });
    await sending.handle('/GPT 帮助', { chatKey: 'group:200' });
    assert.deepEqual(sending.sent, []);
  }
  const f = fixture({ request: (route, body, cfg) => { cfg.allow.group = []; return gptJob(); } });
  await f.handle('/GPT 查问题', { chatKey: 'group:200' });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.receipts, []); assert.deepEqual(f.sent, []);
});

function receiptFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-receipts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture(); const sent = [], requested = [];
  let connected = true;
  const access = createTaskReceiptAccess({ getConfig: () => f.config, ownerConsole: f.ownerConsole,
    groupAllowed: controlGroup, isConnected: () => connected, isSilenced: () => false, scopeForJob: () => null });
  const receipt = createTaskReceipts({ filePath: path.join(directory, 'receipts.json'), access,
    request: async route => { requested.push(route); return options.request ? options.request(f.config) : gptJob({ status: 'succeeded', result: 'R'.repeat(2000) }); },
    send: async (chatKey, text, canSend) => { options.beforeSend?.(f.config); if (canSend()) sent.push({ chatKey, text }); }
  });
  const metadata = { jobId, chatKey: 'private:100', senderId: '100', includeResult: true, command: '/GPT', sourceChatKey: 'group:200' };
  return { ...f, receipt, metadata, sent, requested, disconnect: () => { connected = false; } };
}

test('GPT auto receipt binds a private target and returns only a bounded local summary', async t => {
  const f = receiptFixture(t); f.receipt.register(f.metadata); await f.receipt.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].chatKey, 'private:100');
  assert.equal((f.sent[0].text.match(/R/g) || []).length, 1800);
  assert.match(f.sent[0].text, new RegExp(`/GPT 结果 ${jobId}`));
  await f.receipt.tick(); assert.equal(f.sent.length, 1);
  assert.throws(() => f.receipt.register({ ...f.metadata, sourceChatKey: 'group:201' }), /already bound/);
  assert.throws(() => f.receipt.register({ ...f.metadata, jobId: 'aaaaaaaaaaaa', chatKey: 'group:200' }), /Invalid GPT/);
});

test('GPT auto receipt is withheld when source group or private owner permission is revoked', async t => {
  for (const revoke of [cfg => { cfg.allow.group = []; }, cfg => { cfg.allow.private = []; },
    cfg => { cfg.blocklist = { 200: ['100'] }; }, cfg => { cfg.harnessControl.enabled = false; }]) {
    const f = receiptFixture(t); f.receipt.register(f.metadata); revoke(f.config); await f.receipt.tick();
    assert.deepEqual(f.sent, []); assert.deepEqual(f.requested, []);
    const changedAfterRead = receiptFixture(t, { request: cfg => { revoke(cfg); return gptJob({ status: 'succeeded', result: 'SECRET' }); } });
    changedAfterRead.receipt.register(changedAfterRead.metadata); await changedAfterRead.receipt.tick();
    assert.deepEqual(changedAfterRead.sent, []);
    const changedAtSend = receiptFixture(t, { beforeSend: revoke });
    changedAtSend.receipt.register(changedAtSend.metadata); await changedAtSend.receipt.tick(); assert.deepEqual(changedAtSend.sent, []);
  }
});

test('GPT receipts reject other job types and preserve legacy task notification behavior', async t => {
  const wrong = receiptFixture(t, { request: () => gptJob({ mode: 'maintenance', status: 'succeeded', result: 'SECRET' }) });
  wrong.receipt.register(wrong.metadata); await wrong.receipt.tick(); assert.deepEqual(wrong.sent, []);
  const legacy = receiptFixture(t, { request: () => gptJob({ engine: 'pi', mode: 'task', status: 'succeeded', result: 'LEGACY_SECRET' }) });
  legacy.receipt.register({ jobId, chatKey: 'private:100', senderId: '100' }); await legacy.receipt.tick();
  assert.equal(legacy.sent.length, 1);
  assert.equal(legacy.sent[0].text, `任务 ${jobId} 已完成。\n用 /任务 结果 ${jobId} 查看结果与文件。`);
  assert.doesNotMatch(legacy.sent[0].text, /LEGACY_SECRET/);
});
