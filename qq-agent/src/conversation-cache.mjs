import { createHash } from 'node:crypto';

export const CACHE_POLICY_VERSION = 'qq-context-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeEndpoint = value => String(value || '').replace(/\/+$/, '');

// A routing/cache hint is never a source of history or permission. Every request
// still carries the current, independently filtered context and tool set.
export function conversationCacheScope({ chatKey, roleScope, persona = {}, privileged = false }) {
  if (!/^(group|private):[1-9]\d{0,14}$/.test(String(chatKey || '')) || !roleScope) return '';
  return hash([CACHE_POLICY_VERSION, chatKey, roleScope, Boolean(privileged),
    String(persona.roleText || ''), String(persona.customRules || ''),
    String(persona.systemPromptOverride || ''), String(persona.participation || '')]);
}

export function gatewayCacheRequest(body, { api, scope, config }) {
  const settings = config?.cacheOptimization;
  const endpoint = normalizeEndpoint(api?.baseUrl);
  if (settings?.enabled !== true || !/^[a-f0-9]{64}$/.test(String(scope || ''))
      || !(settings.gatewayBaseUrls || []).some(value => normalizeEndpoint(value) === endpoint)
      || !Array.isArray(body?.messages)) return { body, headers: {} };
  const index = body.messages.findIndex(message => message?.role === 'user');
  if (index < 0) return { body, headers: {} };
  const content = body.messages[index].content;
  if (typeof content !== 'string' && !Array.isArray(content)) return { body, headers: {} };
  const key = 'qq-cache-' + hash([CACHE_POLICY_VERSION, scope, endpoint, String(api.model || '')]);
  const marker = { type: 'text', text: `【会话隔离标识】${key}\n此标识仅用于区分会话，不是聊天内容。本轮消息与资料在后续部分。` };
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const messages = body.messages.map((message, i) => i === index
    ? { ...message, content: [marker, ...parts] } : message);
  // CLIProxyAPI 8.0.32 uses X-Session-ID for explicit routing and the first
  // translated user text part for Antigravity's stable upstream session ID.
  // Keep both stable: a header alone would still hash the changing whole prompt.
  return { body: { ...body, messages }, headers: { 'X-Session-ID': key }, key };
}
