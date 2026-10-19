// Host-side model selection. Only original, whole-message text can be a command.
// Model metadata is supplied by the caller; this module never calls a model or reads secrets.

const USAGE = '模型指令（切换会影响所有聊天）：\n/模型 列表\n/模型 当前\n/模型 切换 编号或完整名称\n/模型 重置';
const COMMAND_PREFIX = /^(?:\/模型|#模型)(?=$|[\t \u3000])/u;

export function parseModelCommand(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  if (segments.some((segment) => segment?.type !== 'text' || typeof segment.data?.text !== 'string')) return null;
  const raw = segments.map((segment) => segment.data.text).join('');
  // Check before trimming so leading/trailing newlines cannot hide a quoted block.
  if (/[\r\n\u2028\u2029]/u.test(raw)) return null;
  const text = raw.trim();
  const prefix = text.match(COMMAND_PREFIX);
  if (!prefix) return null;
  const body = text.slice(prefix[0].length).trim();
  if (body === '列表') return { action: 'list' };
  if (body === '当前') return { action: 'current' };
  if (body === '重置') return { action: 'reset' };
  const change = body.match(/^切换[\t \u3000]+(.+)$/u);
  if (change && change[1].trim()) return { action: 'switch', target: change[1].trim() };
  return { action: 'help' };
}

function display(value) {
  if (typeof value !== 'string') return '';
  // Never let metadata add lines, invisible direction changes, or CQ segments to replies.
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\[\]]/gu, ' ').trim()).slice(0, 160).join('');
}

function modelMetadata(rawModels) {
  if (!Array.isArray(rawModels)) throw new TypeError('listModels must return an array');
  return rawModels.flatMap((raw) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || !display(raw.id)) return [];
    const name = typeof raw.name === 'string' && display(raw.name) ? raw.name : raw.id;
    return [{
      id: raw.id,
      name,
      label: display(name),
      idLabel: display(raw.id),
      aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((alias) => typeof alias === 'string' && alias.length > 0) : []
    }];
  });
}

function activeId(value) {
  if (typeof value === 'string') return value;
  return value && typeof value.id === 'string' ? value.id : null;
}

function label(model) {
  return model.label === model.idLabel ? model.label : `${model.label}（${model.idLabel}）`;
}

function committed(result) {
  return result === true || (result && typeof result === 'object' && result.ok === true);
}

/**
 * Callback contract (callbacks may be async):
 * listModels(config) -> [{ id, name?, aliases?, ...private fields }]
 * getActiveModel(config, { chatKey, models }) -> id | { id } | null
 * activateModel(id | null, { chatKey, senderId, reset, config }) -> true | { ok: true, changed? }
 *   Return success only after persistence. null/reset restores the caller's default model.
 * sendReply(chatKey, text) -> sender queue promise
 * ownerIds is copied once. Model selection is global; the command chat is only for replies.
 */
export function createModelCommandHandler({ getConfig, listModels, getActiveModel, activateModel, sendReply, ownerIds = [] } = {}) {
  for (const [name, callback] of Object.entries({ getConfig, listModels, getActiveModel, activateModel, sendReply })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!Array.isArray(ownerIds) && !(ownerIds instanceof Set)) throw new TypeError('ownerIds must be an array or Set');
  const owners = new Set(Array.from(ownerIds, (id) => String(id)).filter((id) => /^[1-9]\d*$/.test(id)));
  // Serialize all global changes, including commands from different chats.
  let pending = Promise.resolve();

  async function reply(chatKey, text) {
    try { await sendReply(chatKey, text); }
    catch { /* A failed acknowledgement must never retry a committed configuration change. */ }
  }

  async function run(command, chatKey, senderId) {
    if (command.action === 'help') {
      await reply(chatKey, USAGE);
      return { handled: true, changed: false };
    }
    try {
      const config = await getConfig();
      // Reading the selected setting must also work when the proxy catalog is offline.
      if (command.action === 'current') {
        const current = await getActiveModel(config, { chatKey, models: [] });
        const id = activeId(current);
        const model = id ? modelMetadata([{ id, name: current?.name }])[0] : null;
        await reply(chatKey, model ? `当前模型：${label(model)}\n此设置对所有聊天生效。` : '当前模型：默认模型。此设置对所有聊天生效。');
        return { handled: true, changed: false };
      }
      const rawModels = await listModels(config);
      const models = modelMetadata(rawModels);
      if (command.action === 'list') {
        const menu = models.length
          ? '可用模型（切换会影响所有聊天）：\n' + models.map((model, index) => `${index + 1}. ${label(model)}`).join('\n') + '\n使用 /模型 切换 编号或完整名称。'
          : '暂时没有可用模型，请稍后再试。';
        await reply(chatKey, menu);
        return { handled: true, changed: false };
      }
      if (command.action === 'reset') {
        const result = await activateModel(null, { chatKey, senderId, reset: true, config });
        if (!committed(result)) {
          await reply(chatKey, '模型设置保存未成功，尚未确认重置。');
          return { handled: true, changed: false };
        }
        await reply(chatKey, '已恢复默认模型，对所有聊天生效。');
        return { handled: true, changed: result?.changed !== false };
      }

      const matches = models.filter((model, index) => command.target === String(index + 1)
        || command.target === model.id || command.target === model.name || model.aliases.includes(command.target));
      if (matches.length === 0) {
        await reply(chatKey, '没有找到这个模型。请用 /模型 列表 查看名称和编号。');
        return { handled: true, changed: false };
      }
      if (matches.length > 1) {
        await reply(chatKey, '匹配到多个模型，未切换。请使用唯一的模型名称或编号。');
        return { handled: true, changed: false };
      }
      const selected = matches[0];
      if (activeId(await getActiveModel(config, { chatKey, models: rawModels })) === selected.id) {
        await reply(chatKey, `当前已经是：${label(selected)}\n此设置对所有聊天生效。`);
        return { handled: true, changed: false };
      }
      const result = await activateModel(selected.id, { chatKey, senderId, reset: false, config });
      if (!committed(result)) {
        await reply(chatKey, '模型设置保存未成功，尚未确认切换。');
        return { handled: true, changed: false };
      }
      await reply(chatKey, `已切换模型：${label(selected)}\n对所有聊天生效。`);
      return { handled: true, changed: result?.changed !== false };
    } catch {
      await reply(chatKey, '模型操作未成功，请稍后再试。');
      return { handled: true, changed: false };
    }
  }

  function handle({ chatKey, senderId, segments } = {}) {
    const command = parseModelCommand(segments);
    if (!command) return Promise.resolve({ handled: false });
    if (!/^(?:group|private):[1-9]\d*$/.test(String(chatKey || ''))) return Promise.resolve({ handled: true, changed: false });
    if (!owners.has(String(senderId))) {
      return reply(chatKey, '只有主人可以使用模型指令。').then(() => ({ handled: true, changed: false }));
    }
    const result = pending.then(() => run(command, chatKey, String(senderId)));
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return { handle };
}
