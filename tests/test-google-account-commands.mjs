import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCommandHandler, parseGoogleAccountCommand } from '../qq-agent/src/model-commands.js';
import { createModelCatalog, modelEndpointIdentity, modelSelectionPatch, selectableModels } from '../qq-agent/src/model-selection.js';
import { googleRequestGuardKey } from '../qq-agent/src/google-request-guard.mjs';

const text = value => [{ type: 'text', data: { text: value } }];
const catalogIds = ['gemini-3.5-flash-lite', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium',
  'account2/gemini-3.5-flash-lite', 'account2/gemini-3.8-flash-high', 'account2/gpt-oss-120b-medium'];
const catalog = ids => selectableModels({ data: ids.map(id => ({ id })) });

function fixture(options = {}) {
  const config = { api: { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'SECRET_TEST_KEY',
    model: options.model || 'gemini-3.5-flash-lite', preferredRecovery: { enabled: true, model: 'gemini-3.8-flash-high' },
    visionModel: 'stale', videoModel: 'stale', fallbackModels: [{ model: 'stale' }] },
    modelCommands: { enabled: true, ownerIds: ['100'], defaultModel: 'gemini-3.5-flash-lite', defaultVision: true },
    roleCard: 'ROLE_UNCHANGED', memory: 'MEMORY_UNCHANGED' };
  const sent = [], changes = [];
  let reads = 0;
  const models = () => catalog(options.ids || catalogIds);
  const handler = createModelCommandHandler({ ownerIds: ['100'], getConfig: () => config,
    listModels: async () => { reads++; return options.listModels ? options.listModels(config) : models(); },
    getActiveModel: c => c.api.model,
    activateModel: async (id, context) => {
      if (options.activate) return options.activate(id, context, config);
      const patch = modelSelectionPatch(config, id, models(), context);
      config.api = { ...config.api, ...patch.api,
        preferredRecovery: { ...config.api.preferredRecovery, ...patch.api.preferredRecovery } };
      changes.push({ id, context });
      return { ok: true };
    },
    sendReply: async (chatKey, reply) => {
      sent.push({ chatKey, text: reply });
      if (options.failReply) throw new Error('transport uncertain');
    }
  });
  return { config, sent, changes, reads: () => reads, handle: (value, context = {}) => handler.handle({
    chatKey: 'private:100', senderId: '100', segments: text(value), ...context }) };
}

test('account commands accept original single-line text and reject quoted, media and embedded forms', () => {
  assert.deepEqual(parseGoogleAccountCommand(text('/账号 切换2')), { action: 'switch', scope: 'account', account: 2 });
  assert.deepEqual(parseGoogleAccountCommand(text('#账号 切换 1')), { action: 'switch', scope: 'account', account: 1 });
  for (const value of ['前文 /账号 切换2', '/账号 切换2\n', '\n/账号 切换2', '/账号 切换2\u2028']) {
    assert.equal(parseGoogleAccountCommand(text(value)), null);
  }
  assert.equal(parseGoogleAccountCommand([{ type: 'reply', data: { id: '123' } }, ...text('/账号 切换2')]), null);
  assert.equal(parseGoogleAccountCommand([{ type: 'image', data: { file: 'x' } }, ...text('/账号 切换2')]), null);
  assert.deepEqual(parseGoogleAccountCommand(text('/账号 切换3')), { action: 'help', scope: 'account' });
});

test('only the real configured owner can list or change accounts', async () => {
  const f = fixture();
  for (const command of ['/账号 列表', '/账号 当前', '/账号 切换2']) {
    await f.handle(command, { senderId: '101', claimedOwner: '100' });
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.changes.length, 0);
  assert.ok(f.sent.every(reply => reply.text === '只有主人可以使用账号指令。'));
});

test('current account reads saved state without model directory or upstream inference', async () => {
  const f = fixture({ model: 'account2/gemini-3.8-flash-high', listModels: () => { throw new Error('offline'); } });
  await f.handle('/账号 当前');
  assert.equal(f.reads(), 0);
  assert.match(f.sent[0].text, /当前账号：账号2/);
  assert.match(f.sent[0].text, /gemini-3\.8-flash-high/);
  assert.doesNotMatch(f.sent[0].text, /SECRET_TEST_KEY|127\.0\.0\.1|ROLE_UNCHANGED|MEMORY_UNCHANGED/);
});

test('account lists use only live catalog metadata and show both deterministic routes', async () => {
  const f = fixture(); await f.handle('/账号 列表');
  assert.equal(f.reads(), 1);
  assert.match(f.sent[0].text, /账号1（当前）/);
  assert.match(f.sent[0].text, /账号2/);
  assert.match(f.sent[0].text, /不自动轮换/);
  assert.equal(f.changes.length, 0);
});

test('manual account switching retains the base model and disables recovery and fallback', async () => {
  const f = fixture({ model: 'gemini-3.8-flash-high' });
  const result = await f.handle('/账号 切换 2', { chatKey: 'group:200' });
  assert.equal(result.changed, true);
  assert.equal(f.config.api.model, 'account2/gemini-3.8-flash-high');
  assert.equal(f.config.api.preferredRecovery.enabled, false);
  assert.deepEqual(f.config.api.fallbackModels, []);
  assert.equal(f.config.api.visionModel, ''); assert.equal(f.config.api.videoModel, '');
  assert.equal(f.config.roleCard, 'ROLE_UNCHANGED'); assert.equal(f.config.memory, 'MEMORY_UNCHANGED');
  assert.equal(f.changes[0].context.senderId, '100');
  assert.match(f.sent[0].text, /已切换为账号2/);
  await f.handle('/账号 切换1');
  assert.equal(f.config.api.model, 'gemini-3.8-flash-high');
});

test('missing counterpart or unavailable directory never selects a replacement model', async () => {
  const missing = fixture({ ids: ['gemini-3.8-flash-high', 'account2/gemini-3.5-flash-lite'], model: 'gemini-3.8-flash-high' });
  await missing.handle('/账号 切换2');
  assert.equal(missing.changes.length, 0);
  assert.equal(missing.config.api.model, 'gemini-3.8-flash-high');
  assert.match(missing.sent[0].text, /没有列出当前模型，未切换/);
  const offline = fixture({ listModels: () => { throw new Error('SECRET_TEST_KEY upstream error'); } });
  await offline.handle('/账号 切换2');
  assert.equal(offline.changes.length, 0);
  assert.equal(offline.config.api.model, 'gemini-3.5-flash-lite');
  assert.doesNotMatch(offline.sent[0].text, /SECRET_TEST_KEY/);
});

test('an unsupported model family cannot acknowledge an account change without changing route', async () => {
  for (const model of ['other-model', 'provider/gemini-test']) {
    const f = fixture({ model, ids: [model] });
    const result = await f.handle('/账号 切换2');
    assert.equal(result.changed, false);
    assert.equal(f.changes.length, 0);
    assert.equal(f.config.api.model, model);
    assert.doesNotMatch(f.sent[0].text, /已切换为账号2/);
  }
});

test('account commands and model commands share one serialization queue across chats', async () => {
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const f = fixture({ activate: async (id, context, config) => {
    events.push(`begin:${id}`);
    if (id.startsWith('account2/')) { enter(); await gate; }
    config.api.model = id; events.push(`end:${id}`); return { ok: true };
  } });
  const first = f.handle('/账号 切换2', { chatKey: 'group:200' });
  await entered;
  const second = f.handle('/模型 切换 gemini-3.8-flash-high', { chatKey: 'private:100' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads(), 1); assert.equal(events.length, 1);
  release(); await Promise.all([first, second]);
  assert.deepEqual(events, ['begin:account2/gemini-3.5-flash-lite', 'end:account2/gemini-3.5-flash-lite',
    'begin:gemini-3.8-flash-high', 'end:gemini-3.8-flash-high']);
});

test('failed persistence and uncertain acknowledgements do not retry committed changes', async () => {
  const denied = fixture({ activate: async () => ({ ok: false }) });
  assert.equal((await denied.handle('/账号 切换2')).changed, false);
  assert.match(denied.sent[0].text, /保存未成功/);
  const uncertain = fixture({ failReply: true });
  assert.equal((await uncertain.handle('/账号 切换2')).changed, true);
  assert.equal(uncertain.changes.length, 1); assert.equal(uncertain.sent.length, 1);
});

test('prefixed metadata preserves family labels, distinct aliases and text-only vision flags', async () => {
  const models = catalog(catalogIds);
  const a = models.find(model => model.id === 'gemini-3.8-flash-high');
  const b = models.find(model => model.id === 'account2/gemini-3.8-flash-high');
  assert.match(b.name, /Gemini 3\.8 Flash High/);
  assert.equal(b.account, 2); assert.equal(b.baseModel, a.id);
  assert.ok(b.aliases.every(alias => !a.aliases.includes(alias)));
  const oss = models.find(model => model.id === 'account2/gpt-oss-120b-medium');
  assert.equal(oss.vision, false);
  const f = fixture(); await f.handle('/模型 列表');
  assert.match(f.sent[0].text, /账号1 ·/); assert.match(f.sent[0].text, /账号2 ·/);
  await f.handle('/模型 切换 账号2 Flash');
  assert.equal(f.config.api.model, 'account2/gemini-3.8-flash-high');
});

test('manual model patch and reset both disable recovery while protecting credentials and private state', () => {
  const f = fixture(); const models = catalog(catalogIds);
  for (const options of [{}, { reset: true }]) {
    const patch = modelSelectionPatch(f.config, 'account2/gpt-oss-120b-medium', models, options);
    assert.equal(patch.api.preferredRecovery.enabled, false);
    assert.deepEqual(patch.api.fallbackModels, []);
    assert.equal(patch.api.apiKey, undefined); assert.equal(patch.roleCard, undefined);
    if (!options.reset) { assert.equal(patch.api.vision, false); assert.equal(patch.api.video, false); }
  }
  assert.throws(() => modelSelectionPatch(f.config, 'account2/unknown', models), /Unknown/);
});

test('account changes invalidate catalog activation identity but share the request protection bucket', () => {
  const first = fixture().config;
  const second = structuredClone(first); second.api.model = 'account2/gemini-3.5-flash-lite';
  assert.notEqual(modelEndpointIdentity(first), modelEndpointIdentity(second));
  assert.equal(googleRequestGuardKey(first.api), googleRequestGuardKey(second.api));
});

test('live discovery only calls GET /models and invalidates its cached identity after account change', async () => {
  const f = fixture(); const calls = [];
  const directory = createModelCatalog({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: catalogIds.map(id => ({ id })) }) };
  } });
  await directory.list(f.config); await directory.list(f.config);
  assert.equal(calls.length, 1);
  f.config.api.model = 'account2/gemini-3.5-flash-lite'; await directory.list(f.config);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.endsWith('/models') && call.options.method === 'GET' && !call.options.body));
});
