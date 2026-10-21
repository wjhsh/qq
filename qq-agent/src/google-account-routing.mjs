// CLIProxyAPI account routing is explicit. An unprefixed model stays on account 1;
// only this exact prefix selects account 2. Never strip arbitrary provider paths.
const ACCOUNT_TWO_PREFIX = 'account2/';
const GOOGLE_GATEWAY_MODEL = /^(?:gemini-|claude-|gpt-oss-)/i;

export function parseGoogleAccountModel(id) {
  const model = String(id ?? '').trim();
  return model.startsWith(ACCOUNT_TWO_PREFIX)
    ? { account: 2, model: model.slice(ACCOUNT_TWO_PREFIX.length) }
    : { account: 1, model };
}

export function googleAccountModel(id, account) {
  const parsed = parseGoogleAccountModel(id);
  // Other provider prefixes and model families are outside this Google route.
  if (!GOOGLE_GATEWAY_MODEL.test(parsed.model) || parsed.model.includes('/')) return String(id ?? '').trim();
  return Number(account) === 2 ? ACCOUNT_TWO_PREFIX + parsed.model : parsed.model;
}

export function followGoogleAccountModel(baseModel, selectedModel) {
  return googleAccountModel(baseModel, parseGoogleAccountModel(selectedModel).account);
}
