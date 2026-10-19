const HELP = '你是机器人内部管理员。群内 @我 可以说：\n切换成凑企鹅／咕咕嘎嘎／高松灯\n记住：这周五晚上八点集合（仅本群）\n共享给所有群：明确要公开的内容\n接话概率调到30%\n闭嘴30分钟／恢复说话\n任务：写一个CSV去重脚本\n/群任务 列表、/群任务 结果 编号\n/开发者 状态、/开发者 自然管理 开或关、/开发者 判定 开或关、/开发者 RP 开或关\n只执行预设操作；角色切换仅影响本群，管理权限绑定真实QQ账号。';
const listed = (values, id) => Array.isArray(values) && values.map(String).includes(String(id));
const idPattern = /^[a-f0-9]{12}$/;

export function extractAdminText(segments, selfId) {
  if (!Array.isArray(segments) || !segments.length) return null;
  let mentioned = false;
  for (const segment of segments) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') continue;
    if (segment?.type === 'at' && selfId && String(segment.data?.qq) === String(selfId) && !mentioned) { mentioned = true; continue; }
    return null;
  }
  const text = segments.filter(s => s.type === 'text').map(s => s.data.text).join('').trim();
  if (!text || text.length > 6000 || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) return null;
  return { text, mentioned };
}

const stripPolite = text => text.replace(/^(?:(?:请|麻烦你?|帮我|给我|现在|先|你|直接|我想让你|能不能)\s*)+/u, '').replace(/[。！!？?]+$/u, '').trim();
const safeIntent = text => !/(?:如果|假如|假设|他说|她说|有人说|群友说|转发|引用|复述|总结|解释|这句话|这段话|代码|不要|不用|不许|先不|暂时不|别切|别换)/u.test(text.split(/[：:]/u,1)[0]);
const roleIntent = /(?:切换(?:成|为|到)?|切成|换成|改成|扮演|变成|角色)/u;
const normalize = s => String(s || '').trim().toLocaleLowerCase();
export function resolveRole(target, cards) {
  const key = normalize(target).replace(/(?:这个角色|这个人设|的角色|的人设|角色|人设|模式)?(?:吧|呀|呗|好吗|好不好)?$/u, '').trim();
  const matches = cards.filter(card => [card.id, card.name, ...(card.aliases || [])].some(name => normalize(name) === key));
  if (matches.length !== 1) return null;
  return matches[0].id;
}

export function localIntent(raw, cards) {
  const text = stripPolite(raw);
  const mute = /^(?:闭嘴|别说话|不要说话|安静)(?:\s*([1-9]\d{0,3})(?:分钟|分)?)?$/u.exec(text);
  if (mute) return { action: 'command', command: '/闭嘴' + (mute[1] ? ' ' + mute[1] : '') };
  if (!safeIntent(text)) return null;
  let m = /^(?:切换(?:成|为|到)?|切成|换成|改成|扮演|变成)\s*(.+)$/u.exec(text);
  if (m) {
    const cardId = resolveRole(m[1], cards);
    return cardId ? { action: 'role_switch', cardId } : { action: 'unknown_role' };
  }
  if (/^(?:看看|查看|查询|查一下|查下)?(?:剩余)?额度(?:还剩多少|还有多少)?$/u.test(text)) return { action: 'command', command: '/额度' };
  if (/^(?:看看|查看|查询|查一下|查下)?(?:剩余)?流量(?:还剩多少|还有多少)?$/u.test(text)) return { action: 'command', command: '/流量' };
  if (/^(?:看看|查看|查询|检查|查一下)?(?:服务器|运行|服务)?状态$/u.test(text)) return { action: 'command', command: '/状态' };
  if (/^(?:恢复说话|恢复聊天|可以说话了|开口)$/u.test(text)) return { action: 'command', command: '/开口' };
  if (/^(?:角色列表|有哪些角色|有什么角色|看看角色)$/u.test(text)) return { action: 'role_list' };
  if (/^(?:当前角色|现在是什么角色|你现在是谁)$/u.test(text)) return { action: 'profile_status' };
  m = /^(?:把)?(?:本群)?接话(?:概率)?(?:调到|改为|设为|设置为|调成)?\s*(\d{1,3})[%％]?$/u.exec(text);
  if (m && Number(m[1]) <= 100) return { action: 'participation', percent: Number(m[1]) };
  m = /^(?:记住|记下来|记到本群|本群记住)\s*[：:]\s*([\s\S]+)$/u.exec(text);
  if (m) return { action: 'memory_add', content: m[1], scope: 'group' };
  m = /^(?:共享给所有群|共享给全部群|所有群共享|全群共享)\s*[：:]\s*([\s\S]+)$/u.exec(text);
  if (m) return { action: 'memory_add', content: m[1], scope: 'all' };
  if (/^(?:查看|看看)?(?:共享记忆|本群记忆)$/u.test(text)) return { action: 'memory_list' };
  m = /^(?:执行)?任务\s*[：:]\s*([\s\S]+)$/u.exec(text);
  if (m) return { action: 'task_submit', prompt: m[1] };
  m = /^任务(?:结果|状态)\s*([a-f0-9]{12})$/iu.exec(text);
  if (m) return { action: 'task_result', id: m[1].toLowerCase() };
  return null;
}

export function validateJudgment(value, raw, cards) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.confidence !== 'number' || value.confidence < .92 || value.confidence > 1 || !safeIntent(stripPolite(raw))) return null;
  const allowed = ['action', 'confidence', 'target', 'content', 'percent', 'scope'];
  if (Object.keys(value).some(k => !allowed.includes(k))) return null;
  if (value.action === 'none') return null;
  if (value.action === 'role_switch' && roleIntent.test(raw)) {
    const card = cards.find(c => c.id === value.target);
    // A model cannot choose a role the original author never named.
    if (!card || ![card.name, ...(card.aliases || [])].some(n => n.length >= 2 && raw.includes(n))) return null;
    return { action: 'role_switch', cardId: card.id };
  }
  if (value.action === 'memory_add' && /记住|共享|记下来/u.test(raw) && typeof value.content === 'string' && value.content.trim() && raw.includes(value.content) && value.content.length <= 300) {
    const head = raw.slice(0,raw.indexOf(value.content));
    const all = /(?:共享(?:给|到)?|分享给|发布到).{0,8}(?:所有群|全部群)|(?:所有群|全部群|全群)共享/u.test(head);
    if (value.scope === 'all' && !all) return null;
    return { action: 'memory_add', content: value.content, scope: all ? 'all' : 'group' };
  }
  if (value.action === 'participation' && /接话/u.test(raw) && Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100 && raw.includes(String(value.percent))) return { action: 'participation', percent: value.percent };
  return null;
}

function developerCommand(text) {
  const m = /^\/开发者(?:\s+([\s\S]+))?$/u.exec(text);
  if (!m) return null;
  const body = m[1]?.trim() || '帮助';
  if (['帮助', '状态', '审计'].includes(body)) return { action: body === '帮助' ? 'help' : (body === '状态' ? 'profile_status' : 'audit_list') };
  const option = /^(自然管理|判定|RP)\s+(开|关)$/iu.exec(body);
  if (option) return { action: 'developer_set', option: { 自然管理: 'natural', 判定: 'judge', RP: 'rp' }[option[1].toUpperCase() === 'RP' ? 'RP' : option[1]], enabled: option[2] === '开' };
  return { action: 'help' };
}

export function createNaturalAdmin({ getConfig, getSelfId, ownerConsole, listCards, groupAllowed = () => false, classify, perform, dispatchCommand, sendReply, audit = () => {} }) {
  let pending = Promise.resolve();
  const lastJudge = new Map();
  async function run(event) {
    const { chatKey, senderId, segments } = event;
    const parsed = extractAdminText(segments, getSelfId());
    if (!parsed || !/^group:[1-9]\d{0,14}$/u.test(chatKey)) return { handled: false };
    const groupId = chatKey.slice(6);
    const context = { chatKey: `private:${senderId}`, triggerEntries: [{ senderId: String(senderId), text: parsed.text, ownerConsoleText: parsed.text }] };
    const authorized = () => {
      const c = getConfig();
      return groupAllowed(c, groupId) && c.naturalAdmin?.enabled === true && listed(c.naturalAdmin.adminIds, senderId)
        && ownerConsole.authorized(context, { groupId });
    };
    // Explicit @ slash commands still pass through their original permission checks.
    if (parsed.mentioned && parsed.text.startsWith('/') && !/^\/(开发者|群任务|共享记忆)(?=$|\s)/u.test(parsed.text)) {
      return dispatchCommand({ ...event, segments: [{ type: 'text', data: { text: parsed.text } }] });
    }
    const explicit = /^\/(开发者|群任务|共享记忆)(?=$|\s)/u.test(parsed.text);
    if (!explicit && !parsed.mentioned) return { handled: false };
    if (!authorized()) return { handled: explicit };
    let intent = developerCommand(parsed.text);
    const cfg = getConfig();
    const prefs = cfg.naturalAdmin?.groups?.[groupId] || {};
    if (!intent && !explicit && prefs.natural === false) return { handled: false };
    const cards = listCards(cfg).map(c => ({ id: c.id, name: c.name, aliases: c.aliases || [] }));
    if (!intent && parsed.text.startsWith('/共享记忆')) {
      const body = parsed.text.replace(/^\/共享记忆\s*/u, '');
      const match = /^(添加|本群|全部群)\s+([\s\S]+)$/u.exec(body);
      if (match) intent = { action: 'memory_add', content: match[2], scope: match[1] === '全部群' ? 'all' : 'group' };
      else intent = ['列表', '查看'].includes(body) ? { action: 'memory_list' } : { action: 'help' };
    }
    if (!intent && parsed.text.startsWith('/群任务')) {
      const body = parsed.text.replace(/^\/群任务\s*/u, '');
      const m = /^(结果|状态|取消)\s+([a-f0-9]{12})$/iu.exec(body);
      if (m) intent = { action: m[1] === '取消' ? 'task_cancel' : 'task_result', id: m[2].toLowerCase() };
      else intent = body === '列表' ? { action: 'task_list' } : (body && !body.startsWith('结果') && !body.startsWith('取消') ? { action: 'task_submit', prompt: body } : { action: 'help' });
    }
    if (!intent) intent = localIntent(parsed.text, cards);
    const candidate = safeIntent(stripPolite(parsed.text)) && /切换|换成|扮演|改.{0,4}人设|记住|共享|接话.{0,6}(?:调|改|设)/u.test(parsed.text);
    if (!intent && prefs.judge !== false && candidate && parsed.text.length <= 1500) {
      if (Date.now() - (lastJudge.get(senderId) || 0) >= 8000) {
        lastJudge.set(senderId, Date.now());
        try { intent = validateJudgment(await classify(parsed.text, cards), parsed.text, cards); } catch { /* No mutation when the judge is unavailable. */ }
      }
    }
    const reply = async text => { if (authorized()) await sendReply(chatKey, text); };
    if (!intent) {
      if (candidate) { await reply('这句话尚未识别为可执行管理操作，设置未改变。可以用 /开发者 查看支持的操作。'); return {handled:true}; }
      return { handled: false };
    }
    if (!authorized()) return { handled: true };
    if (intent.action === 'help') { await reply(HELP); return { handled: true }; }
    if (intent.action === 'unknown_role') { await reply('没找到唯一的角色，请用 /角色 列表 查看名称。'); return { handled: true }; }
    if (intent.action === 'role_list') { await reply('角色：\n' + cards.map(c => c.name).join('\n')); return { handled: true }; }
    if (intent.action === 'command') return dispatchCommand({ ...event, segments: [{ type: 'text', data: { text: intent.command } }] });
    if (intent.action === 'memory_add' && (intent.content.length > 300 || !intent.content.trim() || !['group', 'all'].includes(intent.scope))) { await reply('每条记忆需为1至300字；尚未保存。'); return { handled: true }; }
    if (/^task_(?:result|cancel)$/u.test(intent.action) && !idPattern.test(intent.id || '')) return { handled: true };
    if (intent.action === 'task_submit' && (!intent.prompt?.trim() || intent.prompt.length > 6000)) return { handled: true };
    const details = { chatKey, groupId, senderId: String(senderId), canCommit: authorized };
    try {
      audit({ action: intent.action, groupId, senderId: String(senderId), phase: 'attempt' });
      if (!authorized()) return { handled: true };
      const result = await perform(intent, details);
      audit({ action: intent.action, groupId, senderId: String(senderId), phase: result?.ok ? 'done' : 'failed' });
      await reply(result?.message || (result?.ok ? '已完成。' : '操作未完成，设置未确认改变。'));
    } catch { await reply('这次操作未确认完成，请先查询状态；不会自动重复执行。'); }
    return { handled: true };
  }
  return { handle(event) {
    const task = pending.then(() => run(event));
    pending = task.catch(() => {});
    return task;
  } };
}
