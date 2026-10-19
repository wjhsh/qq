import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createOwnerConsole } from '/opt/codex-qq/QQ-agent/src/owner-console.js';
import { createOwnerHarness } from '/opt/codex-qq/QQ-agent/src/owner-harness.js';
import { SendQueue } from '/opt/codex-qq/QQ-agent/src/sender.js';

let cfg = { ownerConsole: { enabled: true, ownerIds: ['42'] }, allow: { private: ['42'], group: ['99'] } };
const noop = () => ({});
const ownerConsole = createOwnerConsole({ ownerIds: ['42'], getConfig: () => cfg, listGroups: noop, readMessages: noop,
  getGroupMemory: noop, appendGroupMemory: noop, saveGroupStyle: noop, editGroupMemory: noop, roleDraft: noop });
let requests = 0, replies = 0;
const module = createOwnerHarness({ ownerConsole, getConfig: () => cfg, sendReply: async () => { replies++; }, dataDir: '/tmp',
  request: async () => { requests++; return { id: 'abcdef123456', status: 'queued' }; } });
const call = (chatKey, senderId, segments) => module.handle({ chatKey, senderId, segments });
const text = [{ type: 'text', data: { text: '/任务 create csv' } }];
await call('group:99', '42', text);
await call('private:43', '43', text);
await call('private:42', '43', text);
await call('private:42', '42', [{ type: 'reply', data: {} }, ...text]);
assert.equal(requests, 0);
await call('private:42', '42', text);
assert.equal(requests, 1);
cfg.ownerConsole.enabled = false;
await call('private:42', '42', text);
assert.equal(requests, 1);
assert.equal(replies, 1);
console.log('REAL_OWNER_AUTHORIZER_OK');
cfg.ownerConsole.enabled = true;
cfg.harnessControl = { enabled: true, groupIds: ['99'] };
const quota = [{ type: 'text', data: { text: '/额度' } }];
await call('group:99', '42', quota);
assert.equal(requests, 2);
await call('group:99', '43', quota);
await call('group:98', '42', quota);
await call('group:99', '42', text);
assert.equal(requests, 2);
cfg.deny = { groups: ['99'] };
await call('group:99', '42', quota);
assert.equal(requests, 2);
console.log('REAL_GROUP_AUTHORIZER_OK');

// Exercise the real queued file sender with a fake OneBot transport. No QQ API is called.
const production = JSON.parse(fs.readFileSync('/var/lib/qq-agent/config.json', 'utf8'));
const owner = String(production.ownerConsole.ownerIds[0]);
const calls = [], stored = [];
const sender = new SendQueue({ onebot: { call: async (...args) => { calls.push(args); return {}; } },
  store: { appendSelf: (...args) => stored.push(args) } });
await sender.sendTaskFile(`private:${owner}`, '/tmp/example.csv', 'example.csv', { beforeSend: () => true });
assert.equal(calls.length, 1);
assert.equal(calls[0][0], 'upload_private_file');
assert.equal(calls[0][1].name, 'example.csv');
await assert.rejects(sender.sendTaskFile(`private:${owner}`, '/tmp/example.csv', 'example.csv', { beforeSend: () => false }));
assert.equal(calls.length, 1);
assert.equal(stored.length, 1);
console.log('REAL_FILE_QUEUE_WITH_FAKE_TRANSPORT_OK');
console.log('QQ_MESSAGES_SENT=0');
