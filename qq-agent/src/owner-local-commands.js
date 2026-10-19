// Local, owner-private shortcuts. Each mutation still passes the same service
// checks as natural-language tool calls; no model or cross-chat sends are used.
const PREFIX = /^\/(管理群|群列表|群记录|我的发言|群风格|群特点|群友记忆|管理帮助)(?=$|\s)/u;
const HELP = [
  '主人私聊管理：', '/管理群 群号（选择后，讨论时可说“这个群”）', '/管理群 清除', '/群列表',
  '/群记录 [群号] [条数]', '/我的发言 [群号] [条数]（看机器人在群里的发言）', '/群风格 [群号] 查看',
  '/群风格 群号 风格要求', '/群风格 群号 清除', '/群特点 群号 修改 序号 内容', '/群特点 群号 删除 序号',
  '/群友记忆 群号 QQ号 修改 序号 内容', '/群友记忆 群号 QQ号 删除 序号',
  '/角色卡 列表、当前 群号、查看 卡名、草稿 [编号]', '/角色卡 保存 草稿编号 [名称]', '/角色卡 应用 草稿编号 当前或群号',
  '/角色卡 使用 卡名 当前或群号', '也可直接说“查看20001群最近的聊天和你说过的话”“记住，20001群里……”或“请为角色卡起草修改版”。',
  '群记录只包含本机接入后已保存的聊天；群外私聊不开放读取。普通私聊不会自动共享。'
].join('\n');
const plain = (segments) => Array.isArray(segments) && segments.length && segments.every((s) => s?.type === 'text' && typeof s.data?.text === 'string')
  ? segments.map((s) => s.data.text).join('').trim() : null;
const id = (value) => /^[1-9]\d{0,14}$/.test(String(value || ''));
export function createOwnerLocalCommands({ ownerConsole, getConfig, updateConfig, sendReply, saveStyle }) {
  let pending = Promise.resolve();
  async function run({ chatKey, senderId, raw, name, body }) {
    const ctx = { chatKey, triggerEntries: [{ senderId: String(senderId), text: raw, ownerConsoleText: raw }] };
    if (!ownerConsole.authorized(ctx)) return { handled: true, changed: false };
    const reply = async (text) => { if (ownerConsole.authorized(ctx)) await sendReply(chatKey, String(text)); };
    const selected = () => String(getConfig().ownerConsole?.selectedGroups?.[senderId] || '');
    try {
      if (name === '管理帮助') { await reply(HELP); return { handled: true }; }
      if (name === '管理群') {
        const target = body.trim();
        if (!target) { await reply(`当前管理群：${selected() || '尚未选择'}。用 /管理群 群号 选择。`); return { handled: true }; }
        if (target !== '清除' && (!id(target) || !ownerConsole.authorized(ctx, { groupId: target }))) throw new Error('群不在允许管理范围内');
        updateConfig({ ownerConsole: { selectedGroups: { [senderId]: target === '清除' ? '' : target } } });
        await reply(target === '清除' ? '已清除默认管理群。' : `已选择管理群 ${target}。此后在私聊说“这个群”会指向它；普通聊天仍不会自动共享。`);
        return { handled: true, changed: true };
      }
      if (name === '群列表') {
        const result = await ownerConsole.groups(ctx);
        if (!result.ok) throw new Error('暂时无法读取群列表');
        await reply(JSON.stringify(result, null, 1)); return { handled: true };
      }
      if (name === '群记录' || name === '我的发言') {
        const args = body.trim().split(/\s+/u).filter(Boolean);
        let groupId = selected();
        if (args[0] && (args.length > 1 || args[0].length > 3)) groupId = args.shift();
        if (!id(groupId)) throw new Error('请先 /管理群 群号，或在指令中填写群号');
        if (args.length > 1 || (args[0] && !/^\d{1,2}$/.test(args[0]))) throw new Error('格式：/群记录 群号 条数（最多50）');
        const result = await ownerConsole.history(ctx, { groupId, selfOnly: name === '我的发言', limit: Math.min(50, Math.max(1, Number(args[0]) || 15)), offset: 0 });
        if (!result.ok) throw new Error('没有权限或无法读取记录');
        const rows = (result.messages || []).map((message) => `${message.timestamp ? new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false }) : ''} ${message.senderName || message.sender || message.senderId || ''}\n${message.text || ''}`);
        await reply(`群 ${groupId} 的本机已保存记录：\n${rows.join('\n\n') || '暂无符合条件的消息。'}`); return { handled: true };
      }
      if (name === '群风格') {
        const match = /^(?:([1-9]\d{0,14})\s+)?([\s\S]*)$/u.exec(body.trim());
        const groupId = match[1] || selected();
        const content = match[2].trim();
        if (!id(groupId) || !ownerConsole.authorized(ctx, { groupId })) throw new Error('请指定允许管理的群号');
        if (!content || content === '查看') { await reply(`群 ${groupId} 的主人指定风格：\n${getConfig().ownerConsole?.groupStyles?.[groupId] || '尚未单独设置'}`); return { handled: true }; }
        // This explicit slash grammar is itself the write authorization.
        const result = await saveStyle(groupId, content === '清除' ? '' : content, { chatKey, senderId: String(senderId), canCommit: () => ownerConsole.authorized(ctx, { groupId }) });
        if (!result.ok) throw new Error('语言风格尚未保存');
        await reply(content === '清除' ? `已清除群 ${groupId} 的单独风格。` : `已保存群 ${groupId} 的语言风格。`); return { handled: true, changed: true };
      }
      const args = body.trim().split(/\s+/u);
      const groupId = args.shift();
      const userId = name === '群友记忆' ? args.shift() : undefined;
      const action = args.shift();
      const index = Number(args.shift());
      const content = args.join(' ');
      if (!id(groupId) || (userId && !id(userId)) || !['修改', '删除'].includes(action) || !Number.isInteger(index) || index < 1 || (action === '修改' && !content)) throw new Error('请用 /管理帮助 查看正确格式');
      const result = await ownerConsole.editMemory(ctx, { groupId, kind: userId ? 'member' : 'trait', action: action === '删除' ? 'remove' : 'replace', index, userId, content });
      if (!result.ok) throw new Error('记忆尚未修改，请先查看实际序号');
      await reply(`已${action}群 ${groupId} 的${userId ? '群友印象' : '群特点'}。`); return { handled: true, changed: true };
    } catch { await reply('操作尚未完成，请用 /管理帮助 核对群号和格式，或先查看对应记忆序号。'); return { handled: true, changed: false }; }
  }
  function handle({ chatKey, senderId, segments }) {
    const raw = plain(segments);
    const match = raw?.match(PREFIX);
    if (!match) return Promise.resolve({ handled: false });
    const task = pending.then(() => run({ chatKey, senderId, raw, name: match[1], body: raw.slice(match[0].length).trim() }));
    pending = task.then(() => undefined, () => undefined);
    return task;
  }
  return { handle };
}
