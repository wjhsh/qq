import { resolveApiKey } from './llm.js';

const KNOWN_MODELS = {
  'gemini-3.8-flash-high': { name: 'Gemini 3.8 Flash High', aliases: ['Gemini', 'gemini', 'Flash', 'flash', '哈基米'] },
  'gemini-3-flash': { name: 'Gemini 3 Flash', aliases: ['Gemini 3 Flash'] },
  'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash Lite', aliases: ['3.1轻量', '3.1lite'] },
  'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash Lite', aliases: ['3.5轻量', '3.5lite'] },
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', aliases: ['Sonnet', 'sonnet', 'Claude', 'claude'] },
  'claude-opus-4-6-thinking': { name: 'Claude Opus 4.6 Thinking', aliases: ['Opus', 'opus'] },
  'gpt-oss-120b-medium': { name: 'GPT-OSS 120B Medium（纯文本）', aliases: ['GPT-OSS', 'gpt-oss'], vision: false }
};

export function modelEndpointIdentity(config) {
  // This identity is private process state; never include it in replies or logs.
  return JSON.stringify([config.api?.baseUrl || '', config.api?.provider || '', resolveApiKey(config)]);
}

export function selectableModels(body) {
  if (!Array.isArray(body?.data)) throw new Error('Invalid model catalog');
  const seen = new Set();
  return body.data.flatMap((entry) => {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/()@+-]{0,159}$/.test(id) || seen.has(id)) return [];
    // The bot uses chat completions. Image generators, speech and embeddings need
    // different request protocols and cannot be selected as its conversation model.
    if (/(?:^|[-_/:])(?:image|imagen\d*|embedding\w*|embed|tts|whisper|transcri\w*|rerank\w*|moderation)(?:$|[-_/:])/i.test(id)) return [];
    seen.add(id);
    return [{ id, name: id, aliases: [], ...KNOWN_MODELS[id] }];
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

/** /models discovery only: no inference, probing, or credential modifications. */
export function createModelCatalog({ fetchImpl = globalThis.fetch, ttlMs = 60_000 } = {}) {
  const cache = new Map();
  return {
    async list(config) {
      const identity = modelEndpointIdentity(config);
      const hit = cache.get(identity);
      if (hit && Date.now() - hit.at < ttlMs) return hit.models;
      const base = String(config.api?.baseUrl || '').replace(/\/+$/, '');
      const url = new URL(`${base}/models`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint');
      const key = resolveApiKey(config);
      const response = await fetchImpl(url.href, {
        method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5000), redirect: 'error'
      });
      if (!response.ok) throw new Error('Model catalog unavailable');
      const models = selectableModels(await response.json());
      // A live directory is required; never invent a selectable model from config.
      if (!models.length) throw new Error('No conversation models available');
      cache.clear();
      cache.set(identity, { at: Date.now(), models });
      return models;
    }
  };
}

/** Build the saved global selection; the caller owns authorization and commit. */
export function modelSelectionPatch(config, id, models, { reset = false } = {}) {
  const target = reset ? config.modelCommands?.defaultModel : id;
  const matches = models.filter((model) => model.id === target);
  if (matches.length !== 1) throw new Error('Unknown or unavailable conversation model');
  const selected = matches[0];
  const defaults = config.modelCommands || {};
  return {
    api: {
      model: selected.id,
      // Every ordinary request follows the selected model, including image inputs.
      visionModel: '', videoModel: '', fallbackModels: [],
      vision: selected.vision === false ? false : (defaults.defaultVision ?? config.api?.vision ?? true),
      video: selected.vision === false ? false : (defaults.defaultVideo ?? config.api?.video ?? false)
    }
  };
}
