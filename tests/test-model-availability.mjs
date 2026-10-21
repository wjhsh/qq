import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModelAvailability, modelAvailabilityKey } from '../qq-agent/src/model-availability.mjs';

const source = fs.readFileSync(new URL('../qq-agent/src/llm.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = source.slice(source.indexOf('export function isRetryableError'), source.indexOf('\n/**\n * 单次对话请求。')).replace(/export /g, '');
function fixture({ backup = true, cooldownMs = 1000, complete } = {}) {
  let now = 10000;
  const calls = [], primary = { baseUrl: 'http://example.invalid/v1', apiKey: 'test-only', model: 'primary' };
  const gate = createModelAvailability({ now: () => now });
  const candidates = () => [{ overrides: primary, label: 'primary' }, ...(backup ? [{ overrides: { ...primary, model: 'backup' }, label: 'backup', fallbackEffort: 'off' }] : [])];
  const run = new Function('modelAvailability', 'modelAvailabilityKey', 'buildCandidateApis', 'chatCompletion', 'getConfig', 'recoveryTimer', block + ';return chatCompletionWithRetry;')(
    gate, modelAvailabilityKey, candidates,
    async args => { calls.push(args.overrides.model); return complete(args); },
    () => ({ api: { ...primary, availabilityCooldownMs: cooldownMs, requestRetryAttempts: 0 } }), null
  );
  return { run, calls, gate, primary, setNow: value => { now = value; } };
}
const success = model => ({ model, message: { tool_calls: [{ function: { name: 'say_ok', arguments: '{"text":"OK"}' } }] } });

test('a failed primary is skipped across subsequent model/tool rounds', async () => {
  const f = fixture({ complete: async ({ overrides }) => {
    if (overrides.model === 'primary') throw new Error('HTTP 503 MODEL_CAPACITY_EXHAUSTED');
    return success('backup');
  } });
  assert.equal((await f.run({}))._availabilitySkippedCandidates, 0);
  assert.equal((await f.run({}))._availabilitySkippedCandidates, 1);
  assert.deepEqual(f.calls, ['primary', 'backup', 'backup']);
});

test('one recovery request is allowed after cooldown and success restores the primary', async () => {
  let recovered = false;
  const f = fixture({ complete: async ({ overrides }) => {
    if (overrides.model === 'primary' && !recovered) throw new Error('模型请求失败：请求超时');
    return success(overrides.model);
  } });
  await f.run({}); recovered = true; f.setNow(11000);
  assert.equal((await f.run({}))._usedModel, 'primary');
  assert.equal((await f.run({}))._usedModel, 'primary');
  assert.deepEqual(f.calls, ['primary', 'backup', 'primary', 'primary']);
});

test('concurrent chats do not duplicate the recovery probe', async () => {
  let resolveProbe;
  const f = fixture({ complete: async ({ overrides }) => overrides.model === 'primary'
    ? new Promise(resolve => { resolveProbe = resolve; }) : success('backup') });
  f.gate.failed(modelAvailabilityKey(f.primary), 1000); f.setNow(11000);
  const probe = f.run({});
  assert.equal((await f.run({}))._usedModel, 'backup');
  resolveProbe(success('primary')); await probe;
  assert.deepEqual(f.calls, ['primary', 'backup']);
});

test('cancellation releases a recovery probe without routing the cancelled request', async () => {
  const f = fixture({ complete: async ({ overrides }) => success(overrides.model) });
  f.gate.failed(modelAvailabilityKey(f.primary), 1000); f.setNow(11000);
  const controller = new AbortController(); controller.abort(new Error('用户已中止'));
  await assert.rejects(() => f.run({ signal: controller.signal }), /中止/);
  assert.equal((await f.run({}))._usedModel, 'primary');
  assert.deepEqual(f.calls, ['primary']);
});

test('content, verification, malformed responses and client errors never open a bypass', async () => {
  for (const error of ['HTTP 503 content_policy', 'HTTP 403 verification_required', 'HTTP 400 invalid parameter', '模型 API 响应缺少 choices']) {
    const f = fixture({ complete: async () => { throw new Error(error); } });
    await assert.rejects(() => f.run({}), actual => actual.message === error);
    await assert.rejects(() => f.run({}), actual => actual.message === error);
    assert.deepEqual(f.calls, ['primary', 'primary']);
  }
});

test('without an explicit backup or with cooldown disabled the primary is not skipped', async () => {
  for (const options of [{ backup: false }, { cooldownMs: 0 }]) {
    const f = fixture({ ...options, complete: async ({ overrides }) => {
      if (overrides.model === 'primary') throw new Error('HTTP 503 UNAVAILABLE');
      return success('backup');
    } });
    for (let i = 0; i < 2; i++) await f.run({}).catch(() => {});
    assert.equal(f.calls.filter(model => model === 'primary').length, 2);
  }
});

test('availability keys separate accounts, endpoints and models without retaining plaintext keys', () => {
  const base = { baseUrl: 'https://example.invalid/v1/', apiKey: 'private-test-key', model: 'a' };
  const key = modelAvailabilityKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, modelAvailabilityKey({ ...base, baseUrl: 'https://example.invalid/v1' }));
  for (const change of [{ apiKey: 'other' }, { model: 'b' }, { baseUrl: 'https://other.invalid' }]) assert.notEqual(key, modelAvailabilityKey({ ...base, ...change }));
});

test('availability bookkeeping stays bounded as configuration changes', () => {
  const gate = createModelAvailability({ now: () => 0, maxEntries: 2 });
  for (const key of ['old', 'current', 'new']) gate.failed(key, 1000);
  assert.equal(gate.allow('old'), true);
  assert.equal(gate.allow('current'), false);
  assert.equal(gate.allow('new'), false);
});
