import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleAccountModel, googleAccountModel, followGoogleAccountModel } from '../qq-agent/src/google-account-routing.mjs';
import { resolveThinkingRequest, buildThinkingParams } from '../qq-agent/src/thinking.js';
import { createMemeExtractor } from '../qq-agent/src/meme-extractor.mjs';
import { createGoogleRequestGuard, googleRequestGuardKey, googleRequestGuardPolicy } from '../qq-agent/src/google-request-guard.mjs';

test('only the exact account2 prefix is parsed and account switching does not nest prefixes', () => {
  assert.deepEqual(parseGoogleAccountModel('gemini-3.8-flash-high'), { account: 1, model: 'gemini-3.8-flash-high' });
  assert.deepEqual(parseGoogleAccountModel('account2/gemini-3.8-flash-high'), { account: 2, model: 'gemini-3.8-flash-high' });
  assert.equal(googleAccountModel('gemini-3.8-flash-high', 2), 'account2/gemini-3.8-flash-high');
  assert.equal(googleAccountModel('account2/gemini-3.8-flash-high', 2), 'account2/gemini-3.8-flash-high');
  assert.equal(googleAccountModel('account2/gemini-3.8-flash-high', 1), 'gemini-3.8-flash-high');
  assert.equal(googleAccountModel('claude-sonnet-4-6', 2), 'account2/claude-sonnet-4-6');
  assert.equal(googleAccountModel('gpt-oss-120b-medium', 2), 'account2/gpt-oss-120b-medium');
});

test('unsupported provider paths and unrelated model families remain unchanged', () => {
  for (const model of ['provider/gemini-3.8-flash-high', 'Account2/gemini-3.8-flash-high',
    'account20/gemini-3.8-flash-high', 'account2/provider/gemini-test']) {
    assert.equal(googleAccountModel(model, 2), model);
    assert.equal(googleAccountModel(model, 1), model);
  }
  for (const model of ['provider/gemini-test', 'Account2/gemini-test', 'account20/gemini-test']) {
    assert.deepEqual(parseGoogleAccountModel(model), { account: 1, model });
  }
  for (const model of ['deepseek-chat', 'gpt-6.1-sol', 'qwen3']) assert.equal(googleAccountModel(model, 2), model);
  assert.equal(followGoogleAccountModel('provider/gemini-test', 'account2/gemini-3.8-flash-high'), 'provider/gemini-test');
  assert.equal(followGoogleAccountModel('gemini-3.5-flash-lite', 'provider/gemini-test'), 'gemini-3.5-flash-lite');
});

test('explicit Gemini reasoning transport supports account2 while other prefixes retain existing dialects', () => {
  const api = { baseUrl: 'http://127.0.0.1:8317/v1', model: 'account2/gemini-3.8-flash-high',
    thinkingEffort: 'high', geminiThinkingTransport: 'reasoning_effort' };
  const before = structuredClone(api);
  const thinking = resolveThinkingRequest(api);
  assert.equal(thinking.dialect, 'gemini-openai');
  assert.deepEqual(buildThinkingParams(thinking).params, { reasoning_effort: 'high' });
  assert.deepEqual(api, before);
  assert.equal(resolveThinkingRequest({ ...api, model: 'provider/gemini-3.8-flash-high' }).dialect, 'ollama');
  assert.equal(resolveThinkingRequest({ ...api, model: 'Account2/gemini-3.8-flash-high' }).dialect, 'ollama');
  assert.equal(resolveThinkingRequest({ ...api, model: 'account2/claude-sonnet-4-6' }).dialect, 'ollama');
  assert.equal(resolveThinkingRequest({ ...api, geminiThinkingTransport: undefined }).dialect, 'ollama');
});

test('meme extraction follows the selected Google account without replacing key, endpoint or guard', async () => {
  for (const selected of ['gemini-3.8-flash-high', 'account2/gemini-3.8-flash-high']) {
    const api = { model: selected, baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'stored-marker',
      requestGuard: { enabled: true, baseUrls: ['http://127.0.0.1:8317/v1'] } };
    const current = { api }, before = structuredClone(current), calls = [];
    const extract = createMemeExtractor({ getConfig: () => current,
      resolveApiKey: cfg => { assert.equal(cfg, current); return 'resolved-marker'; },
      chatCompletion: async request => { calls.push(request); return { message: { content: '{"candidates":[]}' } }; } });
    assert.deepEqual(await extract('一段公开评论素材'), { candidates: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].overrides.model, selected.startsWith('account2/') ? 'account2/gemini-3.5-flash-lite' : 'gemini-3.5-flash-lite');
    assert.equal(calls[0].overrides.baseUrl, api.baseUrl);
    assert.equal(calls[0].overrides.apiKey, 'resolved-marker');
    assert.equal(calls[0].overrides.requestGuard, api.requestGuard);
    assert.deepEqual(calls[0].skillContext, { thinkingMode: 'off', thinkingEffort: 'off' });
    assert.deepEqual(current, before);
  }
});

test('manual account changes cannot evade the shared gateway cooldown', async () => {
  const api = { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'shared-marker', model: 'gemini-3.8-flash-high',
    requestGuard: { enabled: true, baseUrls: ['http://127.0.0.1:8317/v1'] } };
  const second = { ...api, model: googleAccountModel(api.model, 2) };
  assert.equal(googleRequestGuardKey(api), googleRequestGuardKey(second));
  assert.ok(googleRequestGuardPolicy(api));
  assert.ok(googleRequestGuardPolicy(second));
  const guard = createGoogleRequestGuard({ now: () => 100000 });
  let calls = 0;
  const result = await guard.run(api, {}, async () => { calls++; return { status: 429, ok: false, retryAfter: '120' }; });
  assert.equal(result.requestGuardCooldownMs, 120000);
  await assert.rejects(guard.run(second, {}, async () => { calls++; return { ok: true, status: 200 }; }),
    { code: 'GOOGLE_REQUEST_GUARD_COOLDOWN' });
  assert.equal(calls, 1);
});
