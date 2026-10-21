import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createGoogleRequestGuard, googleRequestGuardKey, googleRequestGuardPolicy, retryAfterMilliseconds
} from '../qq-agent/src/google-request-guard.mjs';

const base = { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'test-secret', model: 'gemini-test',
  requestGuard: { enabled: true, baseUrls: ['http://127.0.0.1:8317/v1'], maxQueue: 2 } };
const ok = { ok: true, status: 200, text: 'OK' };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(options = {}) {
  let time = 1000000, serial = 0;
  const timers = new Map();
  const guard = createGoogleRequestGuard({ now: () => time,
    setTimer: (fn, ms) => { const id = ++serial; timers.set(id, { fn, when: time + ms }); return id; },
    clearTimer: id => timers.delete(id), ...options });
  return { guard, run: (operation, api = base, options = {}) => guard.run(api, options, operation),
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.when <= time) { timers.delete(id); timer.fn(); }
      await flush();
    }, now: () => time, timers };
}

test('protection is opt-in, loopback and explicitly scoped; one key covers all Google models', () => {
  assert.equal(googleRequestGuardPolicy({ ...base, requestGuard: undefined }), null);
  assert.equal(googleRequestGuardPolicy({ ...base, baseUrl: 'https://api.deepseek.com/v1' }), null);
  assert.equal(googleRequestGuardPolicy({ ...base, baseUrl: 'http://127.0.0.1:9911/v1' }), null);
  assert.equal(googleRequestGuardPolicy({ ...base, model: 'claude-test', requestGuard: { enabled: true } }), null);
  assert.ok(googleRequestGuardPolicy({ ...base, model: 'claude-test' }));
  assert.ok(googleRequestGuardPolicy({ ...base, model: 'gpt-oss-test' }));
  assert.equal(googleRequestGuardKey(base), googleRequestGuardKey({ ...base, model: 'different', baseUrl: `${base.baseUrl}/` }));
  assert.notEqual(googleRequestGuardKey(base), googleRequestGuardKey({ ...base, apiKey: 'other' }));
  assert.match(googleRequestGuardKey(base), /^[a-f0-9]{64}$/);
  assert.equal(googleRequestGuardPolicy({ ...base, requestGuard: { ...base.requestGuard, minIntervalMs: 1 } }).minIntervalMs, 1500);
});

test('parallel models and direct background jobs share a single inflight request and start interval', async () => {
  const f = fixture(), calls = []; let release;
  const first = f.run(async () => { calls.push('chat'); return new Promise(resolve => { release = resolve; }); });
  const second = f.run(async () => { calls.push('background'); return ok; }, { ...base, model: 'claude-test' });
  await flush(); assert.deepEqual(calls, ['chat']);
  await f.advance(2000); assert.deepEqual(calls, ['chat']);
  release(ok); await first; await flush(); await second;
  assert.deepEqual(calls, ['chat', 'background']);
  const third = f.run(async () => { calls.push('probe'); return ok; });
  await f.advance(1499); assert.equal(calls.length, 2);
  await f.advance(1); await third; assert.deepEqual(calls, ['chat', 'background', 'probe']);
});

test('bounded queues reject excess work and cancellation removes queued requests promptly', async () => {
  const f = fixture(); let release, sent = 0;
  const first = f.run(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController(), reason = new Error('用户已中止');
  const queued = f.run(async () => { sent++; return ok; }, base, { signal: controller.signal });
  const cancelled = assert.rejects(queued, error => error === reason);
  const last = f.run(async () => { sent++; return ok; });
  await assert.rejects(f.run(async () => { sent++; return ok; }), { code: 'GOOGLE_REQUEST_GUARD_QUEUE_FULL' });
  controller.abort(reason); await cancelled; await flush();
  assert.equal(sent, 0); release(ok); await first; await f.advance(1500); await last;
  assert.equal(sent, 1);
});

test('429 preserves failed response and Retry-After, rejecting already queued and new work without sending', async () => {
  const f = fixture(); let sent = 0;
  const result = f.run(async () => { sent++; return { ok: false, status: 429, text: 'rate_limited', retryAfter: '600' }; });
  const queued = assert.rejects(f.run(async () => { sent++; return ok; }), { code: 'GOOGLE_REQUEST_GUARD_COOLDOWN' });
  const response = await result; await queued;
  assert.equal(response.ok, false); assert.equal(response.text, 'rate_limited');
  assert.equal(response.requestGuardCooldownMs, 600000);
  await f.advance(599999);
  await assert.rejects(f.run(async () => { sent++; return ok; }), error => error.retryAfterMs === 1);
  assert.equal(sent, 1); await f.advance(1); await f.run(async () => { sent++; return ok; }); assert.equal(sent, 2);
});

test('Retry-After supports seconds and HTTP dates without truncating long provider delays', () => {
  const now = Date.parse('2026-10-20T08:00:00Z');
  assert.equal(retryAfterMilliseconds('1.5', now), 1500);
  assert.equal(retryAfterMilliseconds('Tue, 20 Oct 2026 08:10:00 GMT', now), 600000);
  assert.equal(retryAfterMilliseconds('Tue, 20 Oct 2026 07:00:00 GMT', now), 0);
  for (const value of [null, '', 'nonsense']) assert.equal(retryAfterMilliseconds(value, now), null);
});

test('default cooldowns, exponential failures and successful reset do not need request retries', async () => {
  const f = fixture();
  for (const expected of [60000, 120000, 240000, 300000, 300000]) {
    const response = await f.run(async () => ({ ok: false, status: 503 }));
    assert.equal(response.requestGuardCooldownMs, expected);
    await assert.rejects(f.run(async () => ok), { code: 'GOOGLE_REQUEST_GUARD_COOLDOWN' });
    await f.advance(expected);
  }
  await f.run(async () => ok); await f.advance(1500);
  assert.equal((await f.run(async () => ({ ok: false, status: 429 }))).requestGuardCooldownMs, 120000);
});

test('network failures open a short circuit, but external aborts preserve reason and do not open it', async () => {
  const f = fixture(), original = new Error('network failed');
  await assert.rejects(f.run(async () => { throw original; }), error => error.code === 'GOOGLE_REQUEST_GUARD_COOLDOWN' && error.cause === original && error.retryAfterMs === 15000);
  await f.advance(15000);
  const controller = new AbortController(), reason = new Error('用户已取消');
  let rejectOperation;
  const active = f.run(() => new Promise((resolve, reject) => { rejectOperation = reject; }), base, { signal: controller.signal });
  const cancelled = assert.rejects(active, error => error === reason); await flush();
  controller.abort(reason); rejectOperation(reason); await cancelled;
  await f.advance(1500); assert.equal((await f.run(async () => ok)).ok, true);
});

test('disabled or other-provider calls keep their own concurrency and error semantics', async () => {
  const f = fixture(); let sent = 0;
  const other = { ...base, baseUrl: 'https://api.deepseek.com/v1' }, original = new Error('original');
  const calls = Array.from({ length: 10 }, () => f.run(async () => { sent++; return ok; }, other));
  await Promise.all(calls); assert.equal(sent, 10);
  await assert.rejects(f.run(async () => { throw original; }, other), error => error === original);
});

test('bounded state never evicts a cooling account to make a repeated request bypass protection', async () => {
  const f = fixture({ maxEntries: 1 });
  await f.run(async () => ({ ok: false, status: 429 }));
  await assert.rejects(f.run(async () => ok, { ...base, apiKey: 'different' }), { code: 'GOOGLE_REQUEST_GUARD_STATE_FULL' });
  await assert.rejects(f.run(async () => ok), { code: 'GOOGLE_REQUEST_GUARD_COOLDOWN' });
  await f.advance(600001); assert.equal((await f.run(async () => ok, { ...base, apiKey: 'different' })).ok, true);
});

// Exercise the production request boundary with fake IO, without importing the
// application's real config, storing credentials or making any network request.
function productionFixture(response) {
  const source = fs.readFileSync(new URL('../qq-agent/src/llm.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('export async function chatCompletion({'), source.indexOf('\n/**\n * 回报账号池')).replace('export ', '');
  const f = fixture(), requests = [], feedback = [], api = { ...base, timeoutMs: 5000 };
  const skillManager = { getCapabilityProviders: () => [], getRequestTransforms: () => [], recordError() {} };
  const names = ['getConfig', 'effectiveApi', 'skillManager', 'specializedModelFor', 'resolveThinkingRequest', 'buildThinkingParams',
    'gatewayCacheRequest', 'googleRequestGuard', 'googleRequestGuardPolicy', 'joinUrl', 'authHeaders', 'fetch', 'reportPoolFeedback',
    'applyResultTransforms', 'withoutRejectedParams'];
  const complete = new Function(...names, `${block};return chatCompletion;`)(
    () => ({ api }), () => api, skillManager, () => '', () => ({}), () => ({ applied: false }),
    body => ({ body, headers: {} }), f.guard, googleRequestGuardPolicy, (url, path) => `${url}${path}`, () => ({}),
    async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return response; },
    data => feedback.push(data), async () => {}, async () => null
  );
  const retryBlock = source.slice(source.indexOf('export function isRetryableError'), source.indexOf('\n/**\n * 单次对话请求。')).replace(/export /g, '');
  const classifiers = new Function(`${retryBlock};return {isRetryableError,mayFallbackModel};`)();
  return { ...f, complete, requests, feedback, classifiers };
}

test('production direct and overridden background calls both stop after first 429 even with zero request retries', async () => {
  const f = productionFixture({ ok: false, status: 429, text: async () => '{"error":"rate limited"}', headers: new Headers({ 'retry-after': '600' }) });
  let first;
  try { await f.complete({ messages: [{ role: 'user', content: 'synthetic' }] }); } catch (error) { first = error; }
  assert.match(first.message, /HTTP 429/); assert.equal(first.retryAfterMs, 600000);
  assert.equal(f.classifiers.isRetryableError(first), false); assert.equal(f.classifiers.mayFallbackModel(first), false);
  await assert.rejects(f.complete({ messages: [], overrides: { ...base, model: 'claude-test' } }), { code: 'GOOGLE_REQUEST_GUARD_COOLDOWN' });
  assert.equal(f.requests.length, 1);
});

test('production successful responses remain real parsed responses and pre-aborted callers send nothing', async () => {
  const f = productionFixture({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'gemini-test', choices: [{ message: { content: 'OK' } }] }), headers: new Headers() });
  const controller = new AbortController(), reason = new Error('用户已中止'); controller.abort(reason);
  await assert.rejects(f.complete({ messages: [], signal: controller.signal }), error => error === reason);
  assert.equal(f.requests.length, 0);
  const result = await f.complete({ messages: [] }); assert.equal(result.message.content, 'OK'); assert.equal(f.requests.length, 1);
});

test('safety and verification responses never reach thinking/skill parameter retry advisors', async () => {
  const source = fs.readFileSync(new URL('../qq-agent/src/llm.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('async function withoutRejectedParams('), source.indexOf('\n/** 获取模型列表'));
  let advisors = 0, thinking = 0;
  const advise = new Function('looksLikeThinkingRejection', 'THINKING_BODY_KEYS', 'stripThinkingParams', 'skillManager',
    `${block};return withoutRejectedParams;`)(
    () => { thinking++; return true; }, ['reasoning_effort'], () => ({}),
    { getRetryAdvisors: () => { advisors++; return []; } }
  );
  for (const text of ['invalid reasoning_effort; content_policy', 'verification_required', 'challenge_required', 'captcha', 'safety']) {
    assert.equal(await advise({ reasoning_effort: 'high' }, text, {}, 400), null);
  }
  assert.equal(advisors, 0); assert.equal(thinking, 0);
});
