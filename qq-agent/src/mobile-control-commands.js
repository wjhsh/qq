// Deterministic phone-side administration. No model, history, filesystem or secret access.
// The host supplies filtered display strings and commits all persistent mutations.

const SPACE = /[\t \u3000]+/u;
const PREFIX = /^(\/帮助|\/状态|\/接话|\/安静|\/恢复|\/群记忆)(?=$|[\t \u3000])/u;
const USAGE = [
  '手机管理指令（仅主人，管理结果私聊发送）：',
  '/帮助',
  '/状态 [群号]',
  '/接话 [群号] 0~100%',
  '/安静 [群号]（仅 @ 回应）',
  '/恢复 [群号]（恢复原接话概率）',
  '/群记忆 [群号] 查看',
  '/群记忆 [群号] 总结',
  '/群记忆 [群号] 自动 开 或 关',
  '群内省略群号表示当前群；私聊操作群时必须填群号。/状态 在私聊省略群号显示总览。',
  '已有指令：',
  '/私聊规则 查看、/私聊规则 添加 内容、/私聊规则 修改 编号 内容、/私聊规则 删除 编号（仅主人私聊，切角色不丢失）',
  '/生图 画面描述（例如：/生图 雨夜街头的成年猫耳画师，横屏；群里请 @我）',
  '/角色 列表、/角色 当前、/角色 切换 名称、/角色 重置（当前聊天）',
  '/模型 列表、/模型 当前、/模型 切换 名称、/模型 重置（所有聊天）',
  '/共享记忆 添加 内容、/共享记忆 群 群号 内容、/共享记忆 列表',
  '/共享记忆 修改 编号 内容、/共享记忆 删除 编号（仅主人私聊）',
  '主人私聊进阶：/管理帮助、/管理群 群号、/群列表、/群记录 群号 条数、/我的发言 群号 条数、/群风格 群号 内容、/群特点 群号 修改 序号 内容、/角色卡 列表。',
  '群记忆只总结该群记录；普通私聊不会自动共享。总结会使用当前模型额度。'
].join('\n');

function positiveId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d*$/u.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

function invalid(error) { return { action: 'invalid', error }; }

/** Only original, complete, single-line text can invoke a management command. */
export function parseMobileControlCommand(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;
  if (segments.some((segment) => segment?.type !== 'text' || typeof segment.data?.text !== 'string')) return null;
  const raw = segments.map((segment) => segment.data.text).join('');
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw)) return null;
  const text = raw.trim();
  const prefix = text.match(PREFIX);
  if (!prefix) return null;
  const body = text.slice(prefix[0].length).trim();
  const args = body ? body.split(SPACE) : [];
  const name = prefix[1];
  if (name === '/帮助') return args.length ? invalid('使用 /帮助 查看指令，不需要其他参数。') : { action: 'help' };
  if (name === '/状态' || name === '/安静' || name === '/恢复') {
    if (args.length > 1 || (args.length && !positiveId(args[0]))) return invalid('群号必须是有效的正整数，且只能指定一个群。');
    const command = { action: name === '/状态' ? 'status' : (name === '/安静' ? 'quiet' : 'resume') };
    if (args.length) command.groupId = args[0];
    return command;
  }
  if (name === '/接话') {
    if (args.length !== 1 && args.length !== 2) return invalid('格式：群内 /接话 30%；私聊 /接话 群号 30%。');
    const groupId = args.length === 2 ? positiveId(args[0]) : undefined;
    if (args.length === 2 && !groupId) return invalid('群号必须是有效的正整数。');
    const value = args.at(-1).match(/^(0|[1-9]\d?|100)%?$/u);
    if (!value) return invalid('接话概率必须是 0 至 100 的整数，例如 30%。');
    return { action: 'participation', ...(groupId ? { groupId } : {}), percent: Number(value[1]) };
  }
  // /群记忆 [groupId] 查看|总结|自动 开|关
  let groupId;
  if (args.length && positiveId(args[0])) groupId = args.shift();
  const target = groupId ? { groupId } : {};
  if (args.length === 1 && args[0] === '查看') return { action: 'memoryView', ...target };
  if (args.length === 1 && args[0] === '总结') return { action: 'memorySummary', ...target };
  if (args.length === 2 && args[0] === '自动' && (args[1] === '开' || args[1] === '关')) {
    return { action: 'memoryAuto', ...target, enabled: args[1] === '开' };
  }
  return invalid('格式：/群记忆 [群号] 查看、总结、自动 开 或 自动 关。私聊必须填写群号。');
}

function listed(values, id) {
  return Array.isArray(values) && values.some((value) => positiveId(value) === id);
}

// Administration fails closed even when ordinary chatting has allowAllWhenEmpty enabled.
function allowed(kind, id, config) {
  return listed(config?.allow?.[kind === 'group' ? 'groups' : 'private'], id)
    && !listed(config?.deny?.[kind === 'group' ? 'groups' : 'private'], id);
}

function blocked(senderId, groupId, config) {
  const globallyBlocked = listed(config?.globalBlocklist, senderId) && !listed(config?.communityExemptions, senderId);
  return globallyBlocked || (groupId && listed(config?.blocklist?.[groupId], senderId));
}

function safeDisplay(value) {
  // Display callbacks must explicitly return safe strings; never stringify a config/object.
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected a nonempty filtered display string');
  return Array.from(value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\[\]]/gu, ' ').trim()).slice(0, 6000).join('');
}

/**
 * Callbacks may be async. Context is { chatKey, senderId, config }.
 * getSnapshot({ groupId?, senderId, chatKey, config }) -> safe display string
 * setGroupControl(groupId, { percent?, quiet?, autoMemory? }, context) -> { ok:true, changed? }
 *   Return ok only after persistence. percent commands also explicitly clear quiet mode.
 * getGroupMemory(groupId, context) -> safe display string
 * requestGroupSummary(groupId, context) -> { ok:true, queued:true }
 *   Enqueue an independent, tool-free job and return promptly; the host privately sends its result.
 * sendReply(chatKey, text) -> sender queue promise
 * The host must recheck authorization when an async job runs and before it saves or replies.
 */
export function createMobileControlHandler({ ownerIds = [], getConfig, getSnapshot, setGroupControl, getGroupMemory, requestGroupSummary, sendReply } = {}) {
  for (const [name, callback] of Object.entries({ getConfig, getSnapshot, setGroupControl, getGroupMemory, requestGroupSummary, sendReply })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!Array.isArray(ownerIds) && !(ownerIds instanceof Set)) throw new TypeError('ownerIds must be an array or Set');
  const owners = new Set(Array.from(ownerIds, positiveId).filter(Boolean));
  let pending = Promise.resolve();

  async function reply(senderId, text) {
    try { await sendReply(`private:${senderId}`, text); }
    catch { /* Never repeat a persisted change because its acknowledgement failed. */ }
  }

  async function run(command, chatKey, senderId) {
    try {
      const config = await getConfig();
      const [kind, sourceId] = chatKey.split(':');
      if (config?.mobileControl?.enabled !== true
        || (Array.isArray(config.mobileControl.ownerIds) && !listed(config.mobileControl.ownerIds, senderId))
        || !allowed(kind, sourceId, config) || !allowed('private', senderId, config)
        || blocked(senderId, kind === 'group' ? sourceId : null, config)) {
        return { handled: true, changed: false };
      }
      const context = { chatKey, senderId, config };
      if (command.action === 'help' || command.action === 'invalid') {
        await reply(senderId, command.error || USAGE);
        return { handled: true, changed: false };
      }
      let groupId = command.groupId;
      if (kind === 'group') {
        if (groupId && groupId !== sourceId) {
          await reply(senderId, '群内管理指令只作用于当前群。管理其他群请在私聊中明确填写群号。');
          return { handled: true, changed: false };
        }
        groupId = sourceId;
      }
      if (!groupId && command.action !== 'status') {
        await reply(senderId, '私聊管理群时必须填写群号，例如 /接话 20002 30% 或 /群记忆 20002 查看。');
        return { handled: true, changed: false };
      }
      if (groupId && (!allowed('group', groupId, config) || blocked(senderId, groupId, config))) {
        await reply(senderId, '该群未在当前允许管理的群白名单中，尚未执行。');
        return { handled: true, changed: false };
      }
      if (command.action === 'status') {
        const snapshot = await getSnapshot({ ...(groupId ? { groupId } : {}), senderId, chatKey, config });
        await reply(senderId, safeDisplay(snapshot));
        return { handled: true, changed: false };
      }
      if (command.action === 'memoryView') {
        const text = safeDisplay(await getGroupMemory(groupId, context));
        await reply(senderId, `群 ${groupId} 的群记忆：\n${text}`);
        return { handled: true, changed: false };
      }
      if (command.action === 'memorySummary') {
        const result = await requestGroupSummary(groupId, context);
        if (result?.ok !== true || result.queued !== true) {
          await reply(senderId, '群记忆总结未安排，可能已有任务在进行，请稍后查看。');
          return { handled: true, changed: false };
        }
        await reply(senderId, `已安排总结群 ${groupId} 的聊天特点；完成后私聊通知你，不向群里发送总结。`);
        return { handled: true, changed: false, queued: true };
      }
      let patch;
      let acknowledgement;
      if (command.action === 'participation') {
        patch = { percent: command.percent, quiet: false };
        acknowledgement = `群 ${groupId} 的随机接话概率已设为 ${command.percent}%，已解除安静模式。`;
      } else if (command.action === 'quiet') {
        patch = { quiet: true };
        acknowledgement = `群 ${groupId} 已进入安静模式，仅 @ 回应；原接话概率已保留。`;
      } else if (command.action === 'resume') {
        patch = { quiet: false };
        acknowledgement = `群 ${groupId} 已解除安静模式，恢复原接话设置。`;
      } else {
        patch = { autoMemory: command.enabled };
        acknowledgement = `群 ${groupId} 的自动群记忆已${command.enabled ? '开启' : '关闭'}。`;
      }
      const result = await setGroupControl(groupId, patch, context);
      if (result?.ok !== true) {
        await reply(senderId, '群管理设置保存未成功，尚未确认修改。');
        return { handled: true, changed: false };
      }
      await reply(senderId, acknowledgement);
      return { handled: true, changed: result.changed !== false };
    } catch {
      await reply(senderId, '管理操作未成功，请稍后再试。');
      return { handled: true, changed: false };
    }
  }

  function handle({ chatKey, senderId, segments } = {}) {
    const command = parseMobileControlCommand(segments);
    if (!command) return Promise.resolve({ handled: false });
    const match = String(chatKey || '').match(/^(group|private):([1-9]\d*)$/u);
    const sender = positiveId(senderId);
    // Silently consume untrusted control attempts. They cannot reach the conversational model.
    if (!match || !positiveId(match[2]) || !sender || !owners.has(sender)
      || (match[1] === 'private' && match[2] !== sender)) {
      return Promise.resolve({ handled: true, changed: false });
    }
    const result = pending.then(() => run(command, chatKey, sender));
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return { handle };
}
