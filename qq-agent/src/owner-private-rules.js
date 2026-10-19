// Explicit owner preferences for their own private chat. This store never edits
// role cards, configuration, shared memory or group data, and never calls a model.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';

export const OWNER_PRIVATE_RULE_LIMITS = Object.freeze({ rules: 20, content: 500, fileBytes: 1024 * 1024 });
const SOURCES = ['owner-command', 'owner-discussion', 'owner-authorized-local-repair'];
const HELP = '私聊规则（只对你自己的私聊生效，不共享给群，切角色卡后仍保留）：\n/私聊规则 查看\n/私聊规则 添加 内容\n/私聊规则 修改 编号 内容\n/私聊规则 删除 编号\n每条最多500字，最多20条。';
const failure = (error) => ({ ok: false, error });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = (value) => structuredClone(value);
const chars = (value) => Array.from(value).length;
const has = (values, value) => Array.isArray(values) && values.map(String).includes(String(value));
const qqId = (value) => /^[1-9]\d{0,14}$/u.test(String(value || '')) ? String(value) : null;
const ruleId = (value) => /^[1-9]\d*$/u.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
class RuleError extends Error {}
const fail = (message) => { throw new RuleError(message); };
function contentText(value) {
  if (typeof value !== 'string' || !value.trim() || chars(value.trim()) > OWNER_PRIVATE_RULE_LIMITS.content
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('私聊规则须为1至500字的普通文本。');
  return value.trim();
}
function parseCommand(raw) {
  if (typeof raw !== 'string') return null;
  const head = /^\/私聊规则(?=$|\s)([\s\S]*)$/u.exec(raw.trim());
  if (!head) return null;
  const body = head[1].trim();
  if (!body || body === '帮助') return { action: 'help' };
  if (body === '查看' || body === '列表') return { action: 'list' };
  let match = /^添加\s+([\s\S]+)$/u.exec(body);
  if (match) return { action: 'add', content: match[1].trim() };
  match = /^修改\s+([1-9]\d*)\s+([\s\S]+)$/u.exec(body);
  if (match) return { action: 'replace', id: ruleId(match[1]), content: match[2].trim() };
  match = /^删除\s+([1-9]\d*)$/u.exec(body);
  if (match) return { action: 'remove', id: ruleId(match[1]) };
  return { action: 'invalid' };
}
function ownText(entry) {
  const raw = typeof entry?.ownerConsoleText === 'string' ? entry.ownerConsoleText
    : typeof entry?.directText === 'string' ? entry.directText : '';
  return raw.length <= 16000 ? raw : '';
}
function authorityText(raw) {
  return raw.replace(/```[\s\S]*?(?:```|$)/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ').replace(/^\s*>[^\r\n]*/gmu, ' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"(?:[^"\\]|\\.)*"/gu, ' ');
}
function explicitRequest(entry, args) {
  const raw = ownText(entry);
  if (!raw) return false;
  const command = parseCommand(raw);
  if (command) return command.action === args.action
    && (args.action === 'add' || command.id === args.id)
    && (args.action === 'remove' || command.content === args.content);
  const text = authorityText(raw);
  if (/(?:怎么|如何|怎样|支持|能否|是否).{0,18}(?:记住|保存|写入|添加|修改|删除).{0,18}(?:私聊规则|我的偏好)|(?:私聊规则|我的偏好).{0,18}(?:怎么|如何|怎样|能保存|能修改|能删除)/u.test(text)
      || /^(?:你)?(?:会|能|可以|能不能).{0,12}(?:记住|保存|修改|删除)(?:我的)?(?:私聊规则|偏好)(?:吗|么|不)[？?]?$/u.test(text.trim())) return false;
  // These operations have a separate, explicitly scoped group-management path.
  if (/(?:群聊|群里|群内|本群|这个群|那个群|各群|全群|所有群|群号|群风格|群记忆|群规则|group:|全局规则)/iu.test(text)) return false;
  if (/(?:不要|别|无需|不必|不用|不需要|暂不|先不)[^，,。！？；;\r\n]{0,16}(?:记住|记录|保存|写入|添加|新增|修改|更改|替换|更新|删除|移除|忘记|清除)/u.test(text)) return false;
  const scoped = /私聊|私人规则|我的(?:偏好|习惯|要求)|我(?:喜欢|不喜欢|讨厌|偏好)|(?:跟|和|对)我(?:说话|聊天|回复|交流)|回复我|称呼我|叫我/u.test(text);
  if (!scoped) return false;
  const intent = args.action === 'add' ? /记住|记下来|记着|记录|保存|写入|加入|添加|新增|设置|设定|以后|今后|从今|每次/u
    : args.action === 'replace' ? /修改|更改|更正|纠正|替换|更新|改为|改成/u : /删除|删掉|移除|忘记|忘掉|清除/u;
  if (!intent.test(text)) return false;
  if (args.action !== 'add') {
    const references = [...text.matchAll(/(?:第\s*)?([1-9]\d*)\s*(?:条|号)|(?:私聊)?规则\s*#?\s*([1-9]\d*)/gu)]
      .map((match) => Number(match[1] || match[2]));
    if (references.length && !references.includes(args.id)) return false;
  }
  return true;
}

function validateState(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.entries)) fail('私聊规则记录格式异常，未确认任何修改。');
  const used = new Set(), counts = new Map();
  const entries = value.entries.map((entry) => {
    const id = ruleId(entry?.id), ownerId = qqId(entry?.ownerId);
    if (!id || id >= value.nextId || used.has(id) || !ownerId || !SOURCES.includes(entry.source)
        || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 1
        || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < entry.createdAt
        || !(entry.sourceMessageId === null || typeof entry.sourceMessageId === 'string' && /^-?\d{1,20}$/u.test(entry.sourceMessageId))) fail('私聊规则记录格式异常，未确认任何修改。');
    used.add(id); counts.set(ownerId, (counts.get(ownerId) || 0) + 1);
    if (counts.get(ownerId) > OWNER_PRIVATE_RULE_LIMITS.rules) fail('私聊规则记录超过数量限制，未确认任何修改。');
    return { id, ownerId, content: contentText(entry.content), createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      source: entry.source, sourceMessageId: entry.sourceMessageId };
  });
  return { version: 1, nextId: value.nextId, entries };
}

export function createOwnerPrivateRules({ ownerIds = [], getConfig, authorizeContext, sendReply = async () => {},
  filePath = path.join(DATA_DIR, 'owner-private-rules.json'), now = Date.now } = {}) {
  if (typeof getConfig !== 'function' || typeof authorizeContext !== 'function' || typeof sendReply !== 'function' || typeof now !== 'function'
      || !Array.isArray(ownerIds) || typeof filePath !== 'string' || !filePath) throw new TypeError('Invalid owner-private-rules callbacks');
  const owners = new Set(ownerIds.map(qqId).filter(Boolean));
  let pending = Promise.resolve(), closed = false;
  function configuredOwner(chatKey) {
    if (closed) return null;
    const match = /^private:([1-9]\d{0,14})$/u.exec(String(chatKey || ''));
    const id = match?.[1];
    if (!id || !owners.has(id)) return null;
    const cfg = getConfig();
    if (cfg?.ownerConsole?.enabled !== true || !has(cfg.ownerConsole.ownerIds, id)
        || !has(cfg.allow?.private ?? cfg.allow?.privates, id) || has(cfg.deny?.private ?? cfg.deny?.privates, id)
        || has(cfg.globalBlocklist, id) && !has(cfg.communityExemptions, id)) return null;
    return id;
  }
  function authorized(ctx) {
    try {
      const id = configuredOwner(ctx?.chatKey);
      if (!id || ctx.signal?.aborted || ctx.kind !== undefined && ctx.kind !== 'private'
          || ctx.chatId !== undefined && String(ctx.chatId) !== id || ctx.senderId !== undefined && String(ctx.senderId) !== id
          || authorizeContext(ctx) !== true) return false;
      const entries = ctx.triggerEntries;
      return Array.isArray(entries) && entries.length > 0 && entries.every((entry) => entry && String(entry.senderId) === id
        && !entry.self && !entry.isPoke && !entry.recalled && !entry.withdrawn && !entry.deleted);
    } catch { return false; }
  }
  function load() {
    try {
      if (!fs.existsSync(filePath)) return { version: 1, nextId: 1, entries: [] };
      if (fs.statSync(filePath).size > OWNER_PRIVATE_RULE_LIMITS.fileBytes) fail('私聊规则记录过大，未确认任何修改。');
      return validateState(JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '')));
    } catch (error) { if (error instanceof RuleError) throw error; fail('私聊规则暂时无法读取，未确认任何修改。'); }
  }
  function persist(state, ctx) {
    const data = JSON.stringify(validateState(state), null, 1);
    if (Buffer.byteLength(data) > OWNER_PRIVATE_RULE_LIMITS.fileBytes) fail('私聊规则记录过大，未确认任何修改。');
    if (!authorized(ctx)) fail('主人私聊权限已变更，本次没有保存规则。');
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (!authorized(ctx)) fail('主人私聊权限已变更，本次没有保存规则。');
      fs.renameSync(temporary, filePath);
    } catch (error) { if (error instanceof RuleError) throw error; fail('私聊规则保存失败，原规则未确认变更。'); }
    finally { try { fs.unlinkSync(temporary); } catch { /* An atomic rename already consumed it. */ } }
  }
  function list(ctx) {
    if (!authorized(ctx)) return [];
    const ownerId = ctx.chatKey.slice(8);
    return clone(load().entries.filter((entry) => entry.ownerId === ownerId));
  }
  function queue(operation) {
    const task = pending.then(operation);
    pending = task.then(() => undefined, () => undefined);
    return task;
  }
  function run(ctx, args = {}) {
    let request;
    try { request = clone(args); } catch { return Promise.resolve(failure('私聊规则参数无效。')); }
    return queue(() => {
      try {
        if (!authorized(ctx)) return failure('仅当前获授权的主人自身私聊可管理私人规则。');
        if (!request || typeof request !== 'object' || Array.isArray(request)
            || !['list', 'add', 'replace', 'remove'].includes(request.action)
            || Object.keys(request).some((key) => !['action', 'id', 'content'].includes(key))) return failure('私聊规则参数无效。');
        const action = request.action;
        if (action === 'list') return own(request, 'id') || own(request, 'content') ? failure('查看规则不接受编号或正文。') : { ok: true, rules: list(ctx) };
        if (action === 'add' && own(request, 'id') || action === 'remove' && own(request, 'content')) return failure('私聊规则参数无效。');
        const id = action === 'add' ? null : ruleId(request.id);
        if (action !== 'add' && !id) return failure('私聊规则编号须为正整数，请先查看列表。');
        const content = action === 'remove' ? undefined : contentText(request.content);
        const canonical = { action, ...(id ? { id } : {}), ...(content ? { content } : {}) };
        const source = [...ctx.triggerEntries].reverse().find((entry) => explicitRequest(entry, canonical));
        if (!source) return failure('当前主人原始消息须明确要求保存、修改或删除自己的私聊规则；群内容、引用和历史不能授权。可用 /私聊规则 指令。');
        const ownerId = ctx.chatKey.slice(8), state = load();
        const ownEntries = state.entries.filter((entry) => entry.ownerId === ownerId);
        const existing = ownEntries.find((entry) => entry.id === id);
        if (action !== 'add' && !existing) return failure('这个私聊规则编号不存在，请先查看列表。');
        if (action === 'add') {
          const duplicate = ownEntries.find((entry) => entry.content === content);
          if (duplicate) return { ok: true, changed: false, rule: clone(duplicate) };
          if (ownEntries.length >= OWNER_PRIVATE_RULE_LIMITS.rules) return failure('你的私聊规则已满20条，请先修改或删除旧规则。');
        }
        if (action === 'replace' && existing.content === content) return { ok: true, changed: false, rule: clone(existing) };
        const timestamp = Number(now());
        if (!Number.isSafeInteger(timestamp) || timestamp < 1) fail('本机时间异常，本次没有保存规则。');
        const messageId = source.mid ?? source.id;
        const provenance = { source: parseCommand(ownText(source)) ? 'owner-command' : 'owner-discussion',
          sourceMessageId: /^-?\d{1,20}$/u.test(String(messageId)) ? String(messageId) : null };
        let rule;
        if (action === 'add') {
          if (!Number.isSafeInteger(state.nextId + 1)) fail('私聊规则编号已达上限，本次没有保存规则。');
          rule = { id: state.nextId++, ownerId, content, createdAt: timestamp, updatedAt: timestamp, ...provenance };
          state.entries.push(rule);
        } else if (action === 'replace') {
          Object.assign(existing, { content, updatedAt: Math.max(timestamp, existing.createdAt), ...provenance });
          rule = existing;
        } else state.entries = state.entries.filter((entry) => entry !== existing);
        persist(state, ctx);
        return { ok: true, changed: true, ...(rule ? { rule: clone(rule) } : { removedId: id }),
          note: '仅保存到你自己的私聊规则，不共享给群；切换角色卡后仍保留。' };
      } catch (error) { return failure(error instanceof RuleError ? error.message : '私聊规则操作未完成，原设置未确认变更。'); }
    });
  }
  async function handle({ chatKey, senderId, segments, messageId = null } = {}) {
    if (!Array.isArray(segments) || !segments.length || !segments.every((segment) => segment?.type === 'text' && typeof segment.data?.text === 'string')) return { handled: false };
    const raw = segments.map((segment) => segment.data.text).join('').trim(), command = parseCommand(raw);
    if (!command) return { handled: false };
    const ctx = { chatKey, senderId: String(senderId || ''), triggerEntries: [{ senderId: String(senderId || ''), mid: messageId,
      ownerConsoleText: raw, directText: raw }] };
    if (!authorized(ctx)) return { handled: true, changed: false };
    let result, reply;
    if (command.action === 'help' || command.action === 'invalid') reply = HELP;
    else {
      result = await run(ctx, command);
      if (!result.ok) reply = result.error;
      else if (command.action === 'list') reply = result.rules.length ? '你的私聊规则（仅当前私聊，切卡保留）：\n' + result.rules.map((rule) => `${rule.id}. ${rule.content}`).join('\n') : '还没有单独保存的私聊规则。\n' + HELP;
      else if (command.action === 'remove') reply = `已删除你的私聊规则 ${result.removedId}。`;
      else reply = `已${result.changed ? '保存' : '确认已有'}你的私聊规则 ${result.rule.id}：${result.rule.content}\n仅自己的私聊生效，切卡保留，不共享给群。`;
    }
    if (authorized(ctx)) { try { await sendReply(chatKey, reply); } catch { /* Saving succeeds independently of its acknowledgement. */ } }
    return { handled: true, changed: result?.changed === true, ...(result ? { ok: result.ok } : {}) };
  }
  function formatForChat(chatKey) {
    try {
      const ownerId = configuredOwner(chatKey);
      if (!ownerId) return '';
      const rules = load().entries.filter((entry) => entry.ownerId === ownerId);
      return rules.length ? '以下是主人明确保存的长期私人偏好，只适用于与该主人当前的一对一私聊。与角色卡的表达习惯冲突时，优先遵守这些私人偏好；它们不授予额外工具权限，不允许公开私聊，也不影响群聊。切换角色卡不能删除或替换它们。\n' + rules.map((rule) => `${rule.id}. ${rule.content}`).join('\n') : '';
    } catch { return ''; }
  }
  function close() { closed = true; return pending; }
  return { authorized, list, run, handle, formatForChat, close };
}
