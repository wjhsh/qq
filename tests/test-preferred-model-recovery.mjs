import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPreferredModelRecovery } from '../qq-agent/src/preferred-model-recovery.mjs';

function fixture({ probe = async () => {}, failures = /timeout|503/ } = {}) {
  let now = 1000;
  const config = { enabled: true, identity: 'endpoint/account/policy', activeModel: 'fallback',
    preferredModel: 'preferred', fallbackModel: 'fallback', probeKey: 'probe-key',
    intervalMs: 120000, cooldownMs: 300000, successThreshold: 2 };
  const changes = [], events = [], calls = [];
  const controller = createPreferredModelRecovery({
    getPlan: () => ({ ...config }), now: () => now,
    probe: async (p, signal) => { calls.push(p.preferredModel); await probe(p, signal); },
    switchModel: (p, target) => { changes.push(target); config.activeModel = target === 'preferred' ? p.preferredModel : p.fallbackModel; },
    isAvailabilityFailure: error => failures.test(String(error)), report: e => events.push(e)
  });
  return { controller, config, changes, calls, events, advance: ms => { now += ms; } };
}

test('two spaced successful generations restore preference and stop periodic model calls', async () => {
  const f = fixture(); await f.controller.tick(); assert.deepEqual(f.changes, []);
  await f.controller.tick(); assert.equal(f.calls.length, 1);
  f.advance(120000); await f.controller.tick(); assert.deepEqual(f.changes, ['preferred']);
  f.advance(3600000); await f.controller.tick(); assert.equal(f.calls.length, 2);
});

test('an intermittent failure resets the success streak', async () => {
  let n = 0; const f = fixture({ probe: async () => { if (++n === 2) throw new Error('503'); } });
  for (let i = 0; i < 3; i++) { await f.controller.tick(); f.advance(120000); }
  assert.equal(f.changes.length, 0); await f.controller.tick(); assert.deepEqual(f.changes, ['preferred']);
});

test('real preferred-model timeout demotes promptly and enforces recovery cooldown', async () => {
  const f = fixture(); f.config.activeModel = 'preferred';
  assert.equal(f.controller.failed('probe-key', new Error('timeout')), true);
  assert.equal(f.config.activeModel, 'fallback'); await f.controller.tick(); assert.equal(f.calls.length, 0);
  f.advance(299999); await f.controller.tick(); assert.equal(f.calls.length, 0);
  f.advance(1); await f.controller.tick(); assert.equal(f.calls.length, 1);
});

test('policy, verification, client and unknown errors never switch models', () => {
  const f = fixture(); f.config.activeModel = 'preferred';
  for (const message of ['content_policy', 'verification_required', 'HTTP 401', 'invalid response']) {
    assert.equal(f.controller.failed('probe-key', new Error(message)), false);
  }
  assert.equal(f.controller.failed('other-account', new Error('503')), false);
  assert.deepEqual(f.changes, []);
});

test('overlapping ticks cannot start duplicate probes', async () => {
  let resolve; const f = fixture({ probe: () => new Promise(r => { resolve = r; }) });
  const pending = f.controller.tick(); await f.controller.tick(); assert.equal(f.calls.length, 1);
  resolve(); await pending; assert.equal(f.controller.status().probing, false);
});

test('manual model/provider changes or disabling recovery invalidate in-flight results', async () => {
  for (const patch of [{ activeModel: 'manually-selected' }, { identity: 'new-account' }, { enabled: false }]) {
    let resolve; const f = fixture({ probe: () => new Promise(r => { resolve = r; }) });
    await (async () => { const p = f.controller.tick(); resolve(); await p; })();
    f.advance(120000); const pending = f.controller.tick(); Object.assign(f.config, patch); resolve(); await pending;
    assert.deepEqual(f.changes, []);
  }
});

test('shutdown aborts probe and prevents late config writes', async () => {
  let signal, resolve; const f = fixture({ probe: (p, s) => { signal = s; return new Promise(r => { resolve = r; }); } });
  const pending = f.controller.tick(); f.controller.stop(); assert.equal(signal.aborted, true);
  resolve(); await pending; f.advance(120000); await f.controller.tick(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.changes, []);
});

// Exercise the actual production integration with fake IO: verify the probe has no
// user history, native readiness tool must succeed, and configuration is preserved.
function integration({ result, activeModel = 'fallback' } = {}) {
  let now = 1000, scheduled;
  const cfg = { api: { model: activeModel, apiKey: 'test-secret', baseUrl: 'http://test.invalid',
    preferredRecovery: { enabled: true, model: 'preferred', fallbackModel: 'fallback', thinkingEffort: 'high' },
    fallbackModels: [{ model: 'lite', thinkingEffort: 'off' }] }, persona: { text: 'unchanged' } };
  const source = fs.readFileSync(new URL('../qq-agent/src/llm.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('let recoveryTimer'), source.indexOf('\nfunction joinUrl')).replace(/export /g, '');
  const calls = [], writes = [];
  const FakeController = options => createPreferredModelRecovery({ ...options, now: () => now });
  const api = new Function('getConfig','effectiveApi','updateConfig','modelAvailabilityKey','modelAvailability',
    'createPreferredModelRecovery','mayFallbackModel','chatCompletion','setInterval','clearInterval','console',
    block + ';return {startPreferredModelRecovery,stopPreferredModelRecovery,controller:preferredModelRecovery};')(
    () => cfg, () => ({ ...cfg.api }), patch => { writes.push(patch); Object.assign(cfg.api, patch.api); },
    a => [a.baseUrl,a.apiKey,a.model].join('|'), { succeeded() {} }, FakeController, e => /503|timeout/.test(String(e)),
    async args => { calls.push(args); return result || { model: 'preferred', message: { tool_calls: [{ function: { name: 'health_ready', arguments: '{"ok":true}' } }] } }; },
    callback => { scheduled = callback; return { unref() {} }; }, () => {}, { info() {}, warn() {} });
  return { api, cfg, calls, writes, advance: () => { now += 120000; }, tick: () => scheduled() };
}

test('production recovery preserves keys/persona and restores the complete nonduplicated fallback chain', async () => {
  const f = integration(); f.api.startPreferredModelRecovery(); await Promise.resolve(); await Promise.resolve();
  f.advance(); await f.tick();
  assert.equal(f.cfg.api.model, 'preferred'); assert.equal(f.cfg.api.thinkingEffort, 'high');
  assert.deepEqual(f.cfg.api.fallbackModels.map(x => x.model), ['fallback', 'lite']);
  assert.equal(f.cfg.api.apiKey, 'test-secret'); assert.equal(f.cfg.persona.text, 'unchanged');
  assert.equal(f.calls[0].messages.length, 1); assert.match(f.calls[0].messages[0].content, /^Health check/);
  assert.deepEqual(f.calls[0].tools.map(x => x.function.name), ['health_ready']);
  assert.equal(f.cfg.api.preferredRecovery.enabled, true);
  assert.equal(f.api.controller.failed('http://test.invalid|test-secret|preferred', new Error('503')), true);
  assert.equal(f.cfg.api.model, 'fallback'); assert.deepEqual(f.cfg.api.fallbackModels.map(x => x.model), ['lite']);
  f.api.stopPreferredModelRecovery();
});

test('an HTTP success with wrong model, plain text or invalid readiness args cannot restore preference', async () => {
  for (const result of [
    { model: 'other', message: { tool_calls: [{ function: { name: 'health_ready', arguments: '{"ok":true}' } }] } },
    { model: 'preferred', message: { content: 'OK' } },
    { model: 'preferred', message: { tool_calls: [{ function: { name: 'health_ready', arguments: '{"ok":false}' } }] } }
  ]) {
    const f = integration({ result }); f.api.startPreferredModelRecovery(); await Promise.resolve(); await Promise.resolve();
    f.advance(); await f.tick(); assert.deepEqual(f.writes, []); f.api.stopPreferredModelRecovery();
  }
});
