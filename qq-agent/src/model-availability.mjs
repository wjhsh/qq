import { createHash } from 'node:crypto';

// Availability state contains no prompts, memories or plaintext credentials.
export function modelAvailabilityKey(api) {
  return createHash('sha256').update(JSON.stringify([
    String(api?.baseUrl || '').replace(/\/+$/, ''),
    String(api?.model || ''), String(api?.apiKey || '')
  ])).digest('hex');
}

export function createModelAvailability({ now = Date.now, maxEntries = 64 } = {}) {
  const states = new Map();
  return {
    allow(key) {
      const state = states.get(key);
      if (!state) return true;
      if (state.probing || now() < state.until) return false;
      state.probing = true;
      return true;
    },
    failed(key, cooldownMs) {
      if (!key) return;
      if (!states.has(key) && states.size >= maxEntries) states.delete(states.keys().next().value);
      states.set(key, { until: now() + cooldownMs, probing: false });
    },
    succeeded(key) { if (key) states.delete(key); },
    release(key) { const state = states.get(key); if (state) state.probing = false; }
  };
}
