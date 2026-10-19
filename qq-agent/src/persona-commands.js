// Local persona commands. Parse the original OneBot segments before flattening replies/media.
// Native customPersonas use { name, text, customRules? }; the caller supplies stable ids/aliases.

const USAGE = '角色卡指令：\n/角色 列表\n/角色 当前\n/角色 切换 编号或名称\n/角色 重置';
const COMMAND_PREFIX = /^(?:\/角色卡|#角色卡|\/角色|#角色)(?=$|[\t \u3000])/u;

/** Return a command only when the entire original message consists of text segments. */
export function parsePersonaCommand(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  if (segments.some((segment) => segment?.type !== 'text' || typeof segment.data?.text !== 'string')) return null;
  const text = segments.map((segment) => segment.data.text).join('').trim();
  // A quoted/forwarded block must never be searched for embedded commands.
  if (!text || /[\r\n\u2028\u2029]/u.test(text)) return null;
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

function displayName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').trim()).slice(0, 80).join('');
}

function cardMetadata(rawCards) {
  if (!Array.isArray(rawCards)) throw new TypeError('listCards must return an array');
  return rawCards.flatMap((raw) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || typeof raw.name !== 'string' || !displayName(raw.name)) return [];
    return [{
      id: raw.id,
      name: raw.name,
      label: displayName(raw.name),
      aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((alias) => typeof alias === 'string' && alias.length > 0) : []
    }];
  });
}

function activeId(value) {
  if (typeof value === 'string') return value;
  return value && typeof value.id === 'string' ? value.id : null;
}

function committed(result) {
  return result === true || (result && typeof result === 'object' && result.ok === true);
}

/**
 * Dependency contract (all callbacks may be async):
 * listCards(config) -> [{ id, name, aliases?, ...private fields }]
 * getActiveCard(config, { chatKey, cards }) -> id | card | null
 * activateCard(id | null, { chatKey, reset, config }) -> true | { ok: true, changed? }
 *   It must report success only after persistence. null/reset restores the caller's default.
 * sendReply(chatKey, text) -> sender queue promise
 * ownerIds is copied once; authorization never reads chat text or mutable config.
 */
export function createPersonaCommandHandler({ getConfig, listCards, getActiveCard, activateCard, sendReply, ownerIds = [] } = {}) {
  for (const [name, callback] of Object.entries({ getConfig, listCards, getActiveCard, activateCard, sendReply })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!Array.isArray(ownerIds) && !(ownerIds instanceof Set)) throw new TypeError('ownerIds must be an array or Set');
  const owners = new Set(Array.from(ownerIds, (id) => String(id)).filter((id) => /^[1-9]\d*$/.test(id)));
  // Persona settings can be global. Serialize even commands arriving from different chats.
  let pending = Promise.resolve();

  async function reply(chatKey, text) {
    try { await sendReply(chatKey, text); }
    catch { /* Persistence must not be retried because a rate-limited reply failed. */ }
  }

  async function run(command, chatKey) {
    if (command.action === 'help') {
      await reply(chatKey, USAGE);
      return { handled: true, changed: false };
    }
    try {
      const config = await getConfig();
      const rawCards = await listCards(config);
      const cards = cardMetadata(rawCards);
      if (command.action === 'list') {
        const menu = cards.length
          ? '可用角色卡：\n' + cards.map((card, index) => `${index + 1}. ${card.label}`).join('\n') + '\n使用 /角色 切换 编号或名称。'
          : '暂时没有可用的角色卡。';
        await reply(chatKey, menu);
        return { handled: true, changed: false };
      }
      if (command.action === 'current') {
        const current = activeId(await getActiveCard(config, { chatKey, cards: rawCards }));
        const card = cards.find((entry) => entry.id === current);
        await reply(chatKey, card ? `当前角色：${card.label}` : (current === null ? '当前角色：默认角色。' : '当前人设未匹配到角色卡。'));
        return { handled: true, changed: false };
      }
      if (command.action === 'reset') {
        const result = await activateCard(null, { chatKey, reset: true, config });
        if (!committed(result)) {
          await reply(chatKey, '角色卡保存未成功，尚未确认重置。');
          return { handled: true, changed: false };
        }
        await reply(chatKey, '已恢复默认角色。');
        return { handled: true, changed: result?.changed !== false };
      }

      const matches = cards.filter((card, index) => command.target === String(index + 1)
        || command.target === card.id || command.target === card.name || card.aliases.includes(command.target));
      if (matches.length === 0) {
        await reply(chatKey, '没有找到这个角色卡。请用 /角色 列表 查看名称和编号。');
        return { handled: true, changed: false };
      }
      if (matches.length > 1) {
        await reply(chatKey, '匹配到多个角色卡，未切换。请使用唯一的角色卡名称或编号。');
        return { handled: true, changed: false };
      }
      const selected = matches[0];
      if (activeId(await getActiveCard(config, { chatKey, cards: rawCards })) === selected.id) {
        await reply(chatKey, `当前已经是：${selected.label}`);
        return { handled: true, changed: false };
      }
      const result = await activateCard(selected.id, { chatKey, reset: false, config });
      if (!committed(result)) {
        await reply(chatKey, '角色卡保存未成功，尚未确认切换。');
        return { handled: true, changed: false };
      }
      await reply(chatKey, `已切换角色：${selected.label}`);
      return { handled: true, changed: result?.changed !== false };
    } catch {
      await reply(chatKey, '角色卡操作未成功，请稍后再试。');
      return { handled: true, changed: false };
    }
  }

  function handle({ chatKey, senderId, segments } = {}) {
    const command = parsePersonaCommand(segments);
    if (!command) return Promise.resolve({ handled: false });
    if (!/^(?:group|private):[1-9]\d*$/.test(String(chatKey || ''))) return Promise.resolve({ handled: true, changed: false });
    if (!owners.has(String(senderId))) {
      return reply(chatKey, '只有主人可以使用角色卡指令。').then(() => ({ handled: true, changed: false }));
    }
    const result = pending.then(() => run(command, chatKey));
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return { handle };
}
