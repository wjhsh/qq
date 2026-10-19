// Explicit shared-memory commands. This module never reads ordinary chat history or calls a model.
const USAGE = '共享记忆指令（仅主人私聊可用）：\n/共享记忆 添加 内容\n/共享记忆 群 群号 内容\n/共享记忆 列表\n/共享记忆 修改 编号 新内容\n/共享记忆 删除 编号\n每条最多 300 字；“添加”只共享给当前白名单中的群，之后新加入的群不会自动获得。';
const PREFIX = /^\/共享记忆(?=$|[\t \u3000])/u;
const SPACE = '[\\t \\u3000]+';
const ADD = new RegExp('^添加' + SPACE + '(.+)$', 'u');
const GROUP = new RegExp('^群' + SPACE + '([^\\s]+)' + SPACE + '(.+)$', 'u');
const UPDATE = new RegExp('^修改' + SPACE + '([^\\s]+)' + SPACE + '(.+)$', 'u');
const REMOVE = new RegExp('^删除' + SPACE + '([^\\s]+)$', 'u');

function positiveId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d*$/u.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

/** Parse only a complete, one-line message made exclusively from original text segments. */
export function parseSharedMemoryCommand(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;
  if (segments.some((segment) => segment?.type !== 'text' || typeof segment.data?.text !== 'string')) return null;
  const raw = segments.map((segment) => segment.data.text).join('');
  // Check before trimming: leading/trailing newlines must not disguise a quoted command block.
  if (/[\r\n\u2028\u2029]/u.test(raw)) return null;
  const text = raw.trim();
  const prefix = text.match(PREFIX);
  if (!prefix) return null;
  const body = text.slice(prefix[0].length).trim();
  if (body === '列表' || body === '查看') return { action: 'list' };
  let match = body.match(ADD);
  if (match) return { action: 'add', content: match[1].trim() };
  match = body.match(GROUP);
  if (match) return positiveId(match[1])
    ? { action: 'add', groupId: match[1], content: match[2].trim() }
    : { action: 'invalid', error: '群号必须是有效的正整数。' };
  match = body.match(UPDATE);
  if (match) return positiveId(match[1])
    ? { action: 'update', id: Number(match[1]), content: match[2].trim() }
    : { action: 'invalid', error: '记忆编号必须是有效的正整数，请用 /共享记忆 列表 查看。' };
  match = body.match(REMOVE);
  if (match) return positiveId(match[1])
    ? { action: 'remove', id: Number(match[1]) }
    : { action: 'invalid', error: '记忆编号必须是有效的正整数，请用 /共享记忆 列表 查看。' };
  return { action: 'help' };
}

function display(value) {
  if (typeof value !== 'string') return '';
  // OneBot may interpret literal CQ codes; metadata/content must remain visible plain text.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\[\]]/gu, ' ').trim();
}

function groupIds(config) {
  const denied = new Set((Array.isArray(config?.deny?.groups) ? config.deny.groups : []).map(positiveId).filter(Boolean));
  return [...new Set((Array.isArray(config?.allow?.groups) ? config.allow.groups : []).map(positiveId).filter((id) => id && !denied.has(id)))];
}

function entriesMetadata(raw) {
  if (!Array.isArray(raw)) throw new TypeError('listEntries must return an array');
  return raw.flatMap((entry) => {
    const id = positiveId(entry?.id);
    if (!id || typeof entry?.content !== 'string') return [];
    return [{
      id: Number(id),
      content: display(entry.content),
      targetGroupIds: [...new Set((Array.isArray(entry.targetGroupIds) ? entry.targetGroupIds : []).map(positiveId).filter(Boolean))]
    }];
  });
}

function committed(result) {
  return result === true || (result && typeof result === 'object' && result.ok === true);
}

/**
 * Callbacks may be async. listEntries(config, ctx) returns only explicit shared entries.
 * addEntry({ content, targetGroupIds }, ctx), updateEntry(id, content, ctx), removeEntry(id, ctx)
 * must return true/{ok:true} only after persistence. ctx is {chatKey,senderId,config}.
 * ownerIds is copied once. Neither text, a model, nor mutable config can grant command access.
 */
export function createSharedMemoryCommandHandler({ ownerIds = [], getConfig, listEntries, addEntry, updateEntry, removeEntry, sendReply } = {}) {
  for (const [name, callback] of Object.entries({ getConfig, listEntries, addEntry, updateEntry, removeEntry, sendReply })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!Array.isArray(ownerIds) && !(ownerIds instanceof Set)) throw new TypeError('ownerIds must be an array or Set');
  const owners = new Set(Array.from(ownerIds, positiveId).filter(Boolean));
  let pending = Promise.resolve();

  async function reply(chatKey, text) {
    try { await sendReply(chatKey, text); }
    catch { /* A failed acknowledgement must not retry an already-persisted mutation. */ }
  }

  async function run(command, chatKey, senderId) {
    try {
      // Serialize reads as well as writes so each command sees the preceding committed result.
      const config = await getConfig();
      const context = { chatKey, senderId, config };
      if (command.action === 'help' || command.action === 'invalid') {
        await reply(chatKey, command.error || USAGE);
        return { handled: true, changed: false };
      }
      if ('content' in command && (!command.content || Array.from(command.content).length > 300)) {
        await reply(chatKey, '共享内容须为 1 至 300 字，请缩短后重发；尚未保存。');
        return { handled: true, changed: false };
      }
      if (command.action === 'add') {
        const allowedGroups = groupIds(config);
        if (!allowedGroups.length) {
          await reply(chatKey, '当前没有可共享的白名单群，尚未保存。');
          return { handled: true, changed: false };
        }
        if (command.groupId && !allowedGroups.includes(command.groupId)) {
          await reply(chatKey, '该群未在当前允许的群白名单中，尚未保存。');
          return { handled: true, changed: false };
        }
        const targetGroupIds = command.groupId ? [command.groupId] : allowedGroups;
        const result = await addEntry({ content: command.content, targetGroupIds: [...targetGroupIds] }, context);
        if (!committed(result)) {
          await reply(chatKey, '共享记忆保存未成功，尚未确认添加。');
          return { handled: true, changed: false };
        }
        if (result?.changed === false) {
          await reply(chatKey, '共享内容未新增，请用 /共享记忆 列表 确认当前记录。');
          return { handled: true, changed: false };
        }
        await reply(chatKey, `已共享给群：${targetGroupIds.join('、')}。\n可用 /共享记忆 列表 查看稳定编号；没有向群里发送消息。`);
        return { handled: true, changed: true };
      }
      const entries = entriesMetadata(await listEntries(config, { chatKey, senderId }));
      if (command.action === 'list') {
        const menu = entries.length
          ? '已明确共享的记忆（编号固定）：\n' + entries.map((entry) => `编号 ${entry.id}｜群 ${entry.targetGroupIds.join('、') || '无'}\n${entry.content}`).join('\n\n')
          : '暂无明确共享的记忆。普通私聊内容不会自动共享。';
        await reply(chatKey, menu);
        return { handled: true, changed: false };
      }
      if (!entries.some((entry) => entry.id === command.id)) {
        await reply(chatKey, '没有这个记忆编号，请用 /共享记忆 列表 查看稳定编号。');
        return { handled: true, changed: false };
      }
      const result = command.action === 'update'
        ? await updateEntry(command.id, command.content, context)
        : await removeEntry(command.id, context);
      if (!committed(result)) {
        await reply(chatKey, '共享记忆保存未成功，尚未确认修改或删除。');
        return { handled: true, changed: false };
      }
      if (result?.changed === false) {
        await reply(chatKey, command.action === 'update'
          ? `共享记忆 ${command.id} 未发生修改，请用 /共享记忆 列表 确认当前内容。`
          : '没有这个记忆编号或记录已删除，请用 /共享记忆 列表 查看稳定编号。');
        return { handled: true, changed: false };
      }
      await reply(chatKey, command.action === 'update' ? `已修改共享记忆 ${command.id}，共享范围保持原样。` : `已删除共享记忆 ${command.id}。`);
      return { handled: true, changed: true };
    } catch {
      await reply(chatKey, '共享记忆操作未成功，请稍后再试。');
      return { handled: true, changed: false };
    }
  }

  function handle({ chatKey, senderId, segments } = {}) {
    const command = parseSharedMemoryCommand(segments);
    if (!command) return Promise.resolve({ handled: false });
    if (!/^(?:group|private):[1-9]\d*$/u.test(String(chatKey || ''))) return Promise.resolve({ handled: true, changed: false });
    const sender = positiveId(senderId);
    if (!sender || !owners.has(sender) || chatKey !== `private:${sender}`) {
      return reply(chatKey, '共享记忆指令只能由主人在与我的私聊中使用。').then(() => ({ handled: true, changed: false }));
    }
    const result = pending.then(() => run(command, chatKey, sender));
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return { handle };
}
