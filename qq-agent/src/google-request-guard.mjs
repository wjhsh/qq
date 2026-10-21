import { createHash } from 'node:crypto';

const normalizedUrl = value => String(value || '').replace(/\/+$/, '');
const integer = (value, fallback, min, max) => {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : fallback));
};

// Deliberately omit model: chat, tools and background jobs share one gateway budget.
// Only the hash is retained in bookkeeping; never retain/log keys, prompts or URLs.
export function googleRequestGuardKey(api) {
  return createHash('sha256').update(JSON.stringify([
    normalizedUrl(api?.baseUrl), String(api?.apiKey || '')
  ])).digest('hex');
}

export function googleRequestGuardPolicy(api, configured = api?.requestGuard) {
  if (configured?.enabled !== true) return null;
  const base = normalizedUrl(api?.baseUrl);
  let url;
  try { url = new URL(base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  // Explicit scope also covers Claude/GPT-OSS behind this same Google gateway.
  // Without an explicit allowlist, enable only Gemini at a loopback endpoint.
  if (Array.isArray(configured.baseUrls)) {
    if (!configured.baseUrls.some(value => normalizedUrl(value) === base)) return null;
  } else if (!/^gemini-/i.test(String(api?.model || ''))) return null;
  return {
    minIntervalMs: integer(configured.minIntervalMs, 1500, 1500, 60000),
    maxQueue: integer(configured.maxQueue, 8, 0, 32),
    rateLimitCooldownMs: integer(configured.rateLimitCooldownMs, 120000, 1000, 300000),
    unavailableCooldownMs: integer(configured.unavailableCooldownMs, 60000, 1000, 300000),
    networkCooldownMs: integer(configured.networkCooldownMs, 15000, 1000, 300000)
  };
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? Math.ceil(ms) : null;
  }
  const when = Date.parse(text);
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

function protectionError(kind, remainingMs = 0, cause) {
  const detail = kind === 'QUEUE_FULL' ? '等待队列已满，请稍后再试'
    : kind === 'STATE_FULL' ? '保护状态已满，请稍后再试'
      : `上游请求保护冷却中，请约 ${Math.max(1, Math.ceil(remainingMs / 1000))} 秒后再试`;
  const error = new Error(`Google 网关${detail}；本次不继续请求或切换账号。`, cause ? { cause } : undefined);
  error.code = `GOOGLE_REQUEST_GUARD_${kind}`;
  if (remainingMs > 0) error.retryAfterMs = remainingMs;
  return error;
}

/** One instance per process; inject a clock/timers only for deterministic offline tests. */
export function createGoogleRequestGuard({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, maxEntries = 128 } = {}) {
  const states = new Map();

  function cooldown(state, policy, status, retryAfter) {
    state.failures++;
    const base = status === 429 ? policy.rateLimitCooldownMs
      : status ? policy.unavailableCooldownMs : policy.networkCooldownMs;
    const exponential = Math.min(300000, base * 2 ** Math.min(state.failures - 1, 9));
    // A provider's longer Retry-After must never be shortened to our five-minute cap.
    const duration = Math.max(exponential, retryAfterMilliseconds(retryAfter, now()) ?? 0);
    state.until = Math.max(state.until, now() + duration);
    return Math.max(0, state.until - now());
  }

  function removeAbort(item) {
    item.signal?.removeEventListener('abort', item.onAbort);
  }

  function rejectQueued(state) {
    if (state.timer !== null) { clearTimer(state.timer); state.timer = null; }
    for (const item of state.queue.splice(0)) {
      removeAbort(item);
      item.reject(item.signal?.aborted ? item.signal.reason ?? new Error('aborted')
        : protectionError('COOLDOWN', state.until - now()));
    }
  }

  function pump(state) {
    if (state.active || state.timer !== null || state.queue.length === 0) return;
    if (state.until > now()) { rejectQueued(state); return; }
    const delay = Math.max(0, state.nextStart - now());
    if (delay) {
      state.timer = setTimer(() => { state.timer = null; pump(state); }, delay);
      return;
    }
    const item = state.queue.shift();
    removeAbort(item);
    if (item.signal?.aborted) { item.reject(item.signal.reason ?? new Error('aborted')); pump(state); return; }
    state.active = true;
    state.nextStart = now() + item.policy.minIntervalMs;
    Promise.resolve().then(() => {
      if (item.signal?.aborted) throw item.signal.reason ?? new Error('aborted');
      return item.operation();
    }).then(result => {
      const status = Number(result?.status);
      if (status === 429 || status >= 500 && status <= 599) {
        const wait = cooldown(state, item.policy, status, result?.retryAfter);
        // Metadata only; preserve the original failed response, never fabricate success.
        item.resolve({ ...result, requestGuardCooldownMs: wait });
      } else {
        if (result?.ok === true) state.failures = 0;
        item.resolve(result);
      }
    }, error => {
      if (item.externalSignal?.aborted) item.reject(item.externalSignal.reason ?? new Error('aborted'));
      else {
        const wait = cooldown(state, item.policy, 0);
        item.reject(protectionError('COOLDOWN', wait, error));
      }
    }).finally(() => {
      state.active = false;
      state.touched = now();
      pump(state);
    });
  }

  return {
    run(api, { policy = googleRequestGuardPolicy(api), signal = null, externalSignal = signal } = {}, operation) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
      if (!policy) return operation();
      const key = googleRequestGuardKey(api);
      let state = states.get(key);
      if (!state) {
        // Never evict live/cooling entries: rotating config cannot erase protection.
        for (const [oldKey, old] of states) {
          if (!old.active && old.queue.length === 0 && old.until <= now() && old.nextStart <= now() && now() - old.touched > 600000) states.delete(oldKey);
        }
        if (states.size >= maxEntries) return Promise.reject(protectionError('STATE_FULL'));
        state = { active: false, queue: [], timer: null, nextStart: 0, until: 0, failures: 0, touched: now() };
        states.set(key, state);
      }
      state.touched = now();
      if (state.until > now()) return Promise.reject(protectionError('COOLDOWN', state.until - now()));
      // The immediately dispatchable request does not consume a waiting queue slot.
      if ((state.active || state.nextStart > now()) && state.queue.length >= policy.maxQueue) {
        return Promise.reject(protectionError('QUEUE_FULL'));
      }
      return new Promise((resolve, reject) => {
        const item = { operation, policy, signal, externalSignal, resolve, reject };
        item.onAbort = () => {
          const index = state.queue.indexOf(item);
          if (index >= 0) state.queue.splice(index, 1);
          removeAbort(item);
          reject(signal.reason ?? new Error('aborted'));
          if (state.queue.length === 0 && state.timer !== null) { clearTimer(state.timer); state.timer = null; }
        };
        signal?.addEventListener('abort', item.onAbort, { once: true });
        state.queue.push(item);
        pump(state);
      });
    }
  };
}

export const googleRequestGuard = createGoogleRequestGuard();
