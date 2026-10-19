// Owner-only role drafts. Text is stored as data; only explicit host commands
// can publish a card or apply it. Model-facing calls can create drafts only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, personaForChat } from './config.js';
import { listRoleCards, roleCardPatch, activeRoleCard } from './role-card-library.js';

export const PERSONA_WORKSHOP_LIMITS = Object.freeze({ drafts: 10, content: 6000, name: 60, batch: 5 });
const PREFIX = /^\/角色卡(?=$|[\t \u3000\r\n])/u;
const GROUP = /^[1-9]\d{0,14}$/;
const DRAFT = /^d-[1-9]\d{0,8}$/;
const FIXED_ACTIONS = new Set(['list', 'current', 'view', 'drafts', 'save', 'apply', 'use']);
const CHANGING_ACTIONS = new Set(['new', 'edit', 'style', 'save', 'apply', 'cancel', 'use']);
const clone = (value) => structuredClone(value);
const size = (value) => [...String(value || '')].length;
class WorkshopError extends Error {}
const USAGE = [
  '角色卡工作台（仅主人私聊）：', '/角色卡 列表', '/角色卡 当前 [群号]', '/角色卡 查看 卡名或ID',
  '/角色卡 新增 名称\n完整角色设定', '/角色卡 编辑 卡名或ID\n修改后的完整角色设定',
  '/角色卡 草稿 [草稿编号]', '/角色卡 保存 草稿编号 [名称]', '/角色卡 应用 草稿编号 当前或群号',
  '/角色卡 使用 卡名或ID 当前或群号', '/角色卡 取消 草稿编号', '/角色卡 风格 群号 语言风格要求（正文也可换行）',
  '列表、当前、查看、草稿、保存、应用、使用可逐行发送，单次最多 5 条；新增、编辑、风格、取消请单独发送。',
  '讨论改卡也可以先让我起草，再用保存或应用命令确认。保存不会自动切换角色。'
].join('\n');

const invalidCommand = (error = '') => ({ action: 'help', ...(error ? { error } : {}) });

function parseFixedCommand(text) {
  if (!PREFIX.test(text) || /[\r\n\u2028\u2029]/u.test(text)) return null;
  const body = text.replace(PREFIX, '').trim();
  if (body === '列表') return { action: 'list' };
  const current = /^当前(?:[\t \u3000]+(当前|[1-9]\d{0,14}))?$/u.exec(body);
  if (current) return { action: 'current', target: current[1] || '当前' };
  const view = /^查看[\t \u3000]+(.+)$/u.exec(body);
  if (view) return { action: 'view', target: view[1].trim() };
  const drafts = /^草稿(?:[\t \u3000]+(d-[1-9]\d{0,8}))?$/u.exec(body);
  if (drafts) return { action: 'drafts', id: drafts[1] || '' };
  const save = /^保存[\t \u3000]+(d-[1-9]\d{0,8})(?:[\t \u3000]+(.+))?$/u.exec(body);
  if (save) return { action: 'save', id: save[1], name: save[2]?.trim() || '' };
  const apply = /^应用[\t \u3000]+(d-[1-9]\d{0,8})[\t \u3000]+(当前|[1-9]\d{0,14})$/u.exec(body);
  if (apply) return { action: 'apply', id: apply[1], target: apply[2] };
  const use = /^使用[\t \u3000]+(.+?)[\t \u3000]+(当前|[1-9]\d{0,14})$/u.exec(body);
  if (use) return { action: 'use', target: use[1].trim(), destination: use[2] };
  const cancel = /^取消[\t \u3000]+(d-[1-9]\d{0,8})$/u.exec(body);
  if (cancel) return { action: 'cancel', id: cancel[1] };
  return null;
}

// Only these complete labels are accepted, never prose surrounding a command.
function operationLabel(line) {
  if (/^应用到私聊[：:]$/u.test(line)) return { action: 'apply', target: '当前' };
  const group = /^应用到群[\t \u3000]+([1-9]\d{0,14})[：:]$/u.exec(line);
  if (group) return { action: 'apply', target: group[1] };
  if (/^想永久存进角色库的话可以发[：:]$/u.test(line)) return { action: 'save' };
  return null;
}

function parseFixedBatch(text, labeled) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const commands = [];
  let label = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const nextLabel = labeled ? operationLabel(line) : null;
    if (nextLabel) {
      if (label) return invalidCommand(`第 ${index + 1} 行缺少上一标签对应的命令；整批未执行。`);
      label = nextLabel;
      continue;
    }
    const command = parseFixedCommand(line);
    if (!command || !FIXED_ACTIONS.has(command.action)) return invalidCommand(`第 ${index + 1} 行不是可批量执行的独立角色卡指令；整批未执行。请把新增、编辑、风格、取消单独发送。`);
    if (labeled && (!label || command.action !== label.action || label.target && command.target !== label.target)) return invalidCommand(`第 ${index + 1} 行与操作标签不对应；整批未执行。`);
    label = null;
    commands.push(command);
    if (commands.length > PERSONA_WORKSHOP_LIMITS.batch) return invalidCommand('每批最多 5 条角色卡指令；整批未执行。');
  }
  if (label || !commands.length) return invalidCommand('操作标签后缺少完整的角色卡指令；整批未执行。');
  return { action: 'batch', commands };
}

/** Parse only original all-text messages. Multiline role bodies remain literal data. */
export function parsePersonaWorkshopCommand(segments) {
  if (!Array.isArray(segments) || !segments.length || segments.some((segment) => segment?.type !== 'text' || typeof segment.data?.text !== 'string')) return null;
  const raw = segments.map((segment) => segment.data.text).join('');
  // A leading blank line can disguise a quoted command block.
  if (/^[\t \u3000]*[\r\n\u2028\u2029]/u.test(raw)) return null;
  const text = raw.trim();
  if (operationLabel(text.split(/\r?\n/u)[0])) return parseFixedBatch(text, true);
  if (!PREFIX.test(text)) return null;
  const body = text.replace(PREFIX, '').trim();
  if (!body) return invalidCommand();
  if (/^风格(?=$|[\t \u3000\r\n])/u.test(body)) {
    const style = /^风格[\t \u3000]+([^\t \u3000\r\n]+)(?:[\t \u3000]+|\r?\n)([\s\S]+)$/u.exec(body);
    if (!style || !GROUP.test(style[1]) || !style[2].trim()) return invalidCommand('风格指令需要合法群号和非空正文，例如：/角色卡 风格 20001 说话简短自然。');
    return { action: 'style', target: style[1], text: style[2].trim(), raw };
  }
  const multiline = /^(新增|编辑)[\t \u3000]+([^\r\n]+)\r?\n([\s\S]+)$/u.exec(body);
  if (multiline) {
    const [, action, target, content] = multiline;
    return { action: action === '新增' ? 'new' : 'edit', target: target.trim(), text: content.trim(), raw };
  }
  if (/[\r\n]/u.test(body)) return parseFixedBatch(text, false);
  return parseFixedCommand(text) || invalidCommand('角色卡指令格式无效；未执行任何操作。发送 /角色卡 查看用法。');
}

function allowed(config, kind, id) {
  const denied = config.deny?.[kind] ?? config.deny?.[`${kind}s`] ?? [];
  const permitted = config.allow?.[kind] ?? config.allow?.[`${kind}s`] ?? [];
  return !denied.map(String).includes(String(id)) && permitted.map(String).includes(String(id));
}

function validContent(input) {
  if (!input || typeof input !== 'object' || typeof input.text !== 'string' || !input.text.trim()) throw new WorkshopError('角色正文不能为空');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const text = input.text.trim();
  const customRules = typeof input.customRules === 'string' ? input.customRules.trim() : '';
  if (!name || size(name) > PERSONA_WORKSHOP_LIMITS.name || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)) throw new WorkshopError('名称须为 1 至 60 字单行文字');
  if (size(text) + size(customRules) > PERSONA_WORKSHOP_LIMITS.content || /\u0000/u.test(text + customRules)) throw new WorkshopError('角色正文及补充规则合计不得超过 6000 字');
  return { name, text, customRules, systemPromptOverride: '' };
}

export function createPersonaWorkshop(options) { return new PersonaWorkshop(options); }

export class PersonaWorkshop {
  constructor({ ownerIds = [], getConfig, updateConfig, sendReply, preparePersonaSwitch, applyStyle = null,
    isBlocked = null, authorizeContext = null, now = Date.now, filePath = path.join(DATA_DIR, 'persona-drafts.json') } = {}) {
    for (const [name, fn] of Object.entries({ getConfig, updateConfig, sendReply, preparePersonaSwitch })) if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
    this.owners = new Set([...ownerIds].map(String).filter((id) => GROUP.test(id)));
    Object.assign(this, { getConfig, updateConfig, sendReply, preparePersonaSwitch, applyStyle, isBlocked, authorizeContext, now, filePath });
    this.pending = Promise.resolve();
    this.closed = false;
  }

  close() { this.closed = true; }

  #authorized(auth, model = false) {
    if (this.closed || !auth || !this.owners.has(String(auth.senderId)) || auth.chatKey !== `private:${auth.senderId}`) return false;
    const cfg = this.getConfig();
    const id = String(auth.senderId);
    if (!allowed(cfg, 'private', id) || cfg.personaCommands?.enabled === false) return false;
    if (Array.isArray(cfg.personaCommands?.ownerIds) && !cfg.personaCommands.ownerIds.map(String).includes(id)) return false;
    const globallyBlocked = (cfg.globalBlocklist || []).map(String).includes(id) && !(cfg.communityExemptions || []).map(String).includes(id);
    if (globallyBlocked || this.isBlocked?.(id, auth.chatKey)) return false;
    if (model && (typeof this.authorizeContext !== 'function' || this.authorizeContext(auth) !== true)) return false;
    return true;
  }

  #require(auth, model = false) {
    if (!this.#authorized(auth, model)) throw new WorkshopError('仅当前获授权的主人私聊可以操作角色草稿');
  }

  #load() {
    let state;
    try { state = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, nextId: 1, drafts: [] }; throw new WorkshopError('角色草稿文件暂时无法读取'); }
    if (state?.version !== 1 || !Number.isSafeInteger(state.nextId) || state.nextId < 1 || !Array.isArray(state.drafts) || state.drafts.length > PERSONA_WORKSHOP_LIMITS.drafts) throw new WorkshopError('角色草稿文件格式无效');
    for (const draft of state.drafts) {
      if (!DRAFT.test(String(draft?.id)) || typeof draft.cardId !== 'string' || !/^owner-card-[a-f0-9-]+$/.test(draft.cardId)
        || !GROUP.test(String(draft.ownerId)) || !['card', 'style'].includes(draft.kind)) throw new WorkshopError('角色草稿记录格式无效');
      validContent(draft);
      if (draft.kind === 'style' && !GROUP.test(String(draft.targetGroupId))) throw new WorkshopError('语言风格草稿范围无效');
    }
    if (new Set(state.drafts.map((draft) => draft.id)).size !== state.drafts.length) throw new WorkshopError('角色草稿编号重复');
    return clone(state);
  }

  #persist(state, auth, model = false) {
    this.#require(auth, model);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(temporary, this.filePath);
  }

  #queue(operation) {
    const task = this.pending.then(operation);
    this.pending = task.then(() => undefined, () => undefined);
    return task;
  }

  #draft(state, id, auth) {
    const draft = state.drafts.find((entry) => entry.id === id && entry.ownerId === String(auth.senderId));
    if (!draft) throw new WorkshopError('没有这个草稿，请用 /角色卡 草稿 查看编号');
    return draft;
  }

  #target(auth, target) {
    if (target === '当前') return auth.chatKey;
    const cfg = this.getConfig();
    if (!GROUP.test(String(target)) || !allowed(cfg, 'group', String(target))) throw new WorkshopError('目标群不在当前白名单中');
    if ((cfg.blocklist?.[String(target)] || []).map(String).includes(String(auth.senderId)) || this.isBlocked?.(String(auth.senderId), `group:${target}`)) throw new WorkshopError('主人当前在目标群被屏蔽，不能查看或修改该群角色');
    return `group:${target}`;
  }

  #card(config, target) {
    const cards = listRoleCards(config);
    const matches = cards.filter((card, index) => target === String(index + 1) || target === card.id || target === card.name || card.aliases?.includes(target));
    if (matches.length !== 1) throw new WorkshopError('角色卡不存在或名称重复，请用 /角色卡 列表 查看唯一 ID');
    return matches[0];
  }

  #makeDraft(input, auth, model) {
    this.#require(auth, model);
    const content = validContent(input);
    const kind = input.kind === 'style' ? 'style' : 'card';
    if (kind === 'style') this.#target(auth, String(input.targetGroupId));
    const state = this.#load();
    if (state.drafts.length >= PERSONA_WORKSHOP_LIMITS.drafts) throw new WorkshopError('最多保留 10 份草稿，请先取消不需要的草稿');
    const id = `d-${state.nextId++}`;
    const draft = { ...content, id, cardId: `owner-card-${crypto.randomUUID()}`, kind, ownerId: String(auth.senderId), createdAt: this.now(),
      baseCardId: typeof input.baseCardId === 'string' ? input.baseCardId.slice(0, 100) : '',
      ...(kind === 'style' ? { targetGroupId: String(input.targetGroupId) } : {}),
      source: { chatKey: auth.chatKey, sessionId: String(auth.sessionId || '').slice(0, 100), sourceMessageId: String(auth.messageId || '').slice(0, 100),
        ownerTextHash: crypto.createHash('sha256').update(String(auth.rawText || '')).digest('hex'), via: model ? 'owner-discussion' : 'owner-command' } };
    state.drafts.push(draft);
    this.#persist(state, auth, model);
    return { ok: true, draft: clone(draft), note: `草稿 ${id} 已保存，尚未应用。主人可用 /角色卡 保存 ${id} 或 /角色卡 应用 ${id} 当前或群号。` };
  }

  // Model tool entry: host supplies current owner context, never model arguments.
  createDraft(input, auth) { return this.#queue(() => this.#makeDraft(input, auth, true)); }
  listDrafts(auth) { this.#require(auth, true); return clone(this.#load().drafts.filter((draft) => draft.ownerId === String(auth.senderId))); }
  readDraft(id, auth) { this.#require(auth, true); return clone(this.#draft(this.#load(), id, auth)); }

  async #reply(auth, text) {
    if (!this.#authorized(auth)) return;
    const receipt = auth.batchIndex ? `第 ${auth.batchIndex}/${auth.batchTotal} 项：\n${text}` : text;
    try { await this.sendReply(auth.chatKey, receipt); } catch { /* Persistence is not retried on acknowledgement failure. */ }
  }

  #formatDraft(draft) {
    return [`草稿 ${draft.id}｜${draft.name}${draft.kind === 'style' ? `｜群 ${draft.targetGroupId} 的语言风格` : ''}`, draft.text,
      ...(draft.customRules ? [`补充角色规则：\n${draft.customRules}`] : []),
      draft.savedAt ? '已存入角色库；未指定应用的聊天保持原样。' : '尚未应用，需主人明确保存或应用。'].join('\n\n');
  }

  #planDraftCommand(draft, command, auth, config = this.getConfig()) {
    this.#require(auth);
    const destination = command.action === 'apply' ? this.#target(auth, command.target) : null;
    if (draft.kind === 'style') {
      if (!destination || destination !== `group:${draft.targetGroupId}` || typeof this.applyStyle !== 'function') throw new WorkshopError('语言风格草稿请应用到它指定的群号，不作为角色卡存入库');
      return { destination, style: true };
    }
    const name = command.name || draft.name;
    validContent({ ...draft, name });
    const cards = clone(Array.isArray(config.customPersonas) ? config.customPersonas : []);
    const existing = cards.find((card) => card.id === draft.cardId);
    if (existing && (existing.text !== draft.text || (existing.customRules || '') !== draft.customRules || existing.name !== name || (existing.systemPromptOverride || '') !== '')) throw new WorkshopError('这份草稿已保存且库中内容发生变化，请重新起草后另存');
    const card = existing || { id: draft.cardId, name, aliases: [], text: draft.text, customRules: draft.customRules, systemPromptOverride: '', participation: 'medium', source: `主人私聊草稿 ${draft.id}`, license: '本机主人自定义' };
    if (!existing) cards.push(card);
    return { destination, style: false, config, name, cards, existing, card };
  }

  async #saveOrApply(draft, command, auth) {
    const plan = this.#planDraftCommand(draft, command, auth);
    const { destination, config, name, cards, existing, card } = plan;
    if (plan.style) {
      this.#require(auth);
      const result = await this.applyStyle(draft.targetGroupId, draft.text, { ...auth, canCommit: () => this.#authorized(auth) && allowed(this.getConfig(), 'group', draft.targetGroupId) });
      if (result === false || result?.ok === false) throw new WorkshopError('语言风格未保存成功');
      return `已将草稿 ${draft.id} 的语言风格应用到群 ${draft.targetGroupId}。`;
    }
    const patch = { ...(!existing ? { customPersonas: cards } : {}) };
    if (destination) {
      Object.assign(patch, roleCardPatch({ ...config, customPersonas: cards }, destination, card.id));
      patch.personaByChat.__replace__[destination].systemPromptOverride = '';
    }
    this.#require(auth);
    if (destination?.startsWith('group:')) this.#target(auth, destination.slice(6));
    if (Object.keys(patch).length) {
      const result = await this.updateConfig(patch);
      if (result === false || result?.ok === false) throw new WorkshopError('角色卡配置尚未保存成功');
    }
    if (destination) this.preparePersonaSwitch(destination);
    // The cardId is assigned when the draft is created, so a failed metadata write
    // cannot create duplicate library cards on retry.
    const state = this.#load();
    const current = this.#draft(state, draft.id, auth);
    current.savedAt ||= this.now();
    current.name = name;
    if (destination) {
      current.appliedTargets = [...new Set([...(Array.isArray(current.appliedTargets) ? current.appliedTargets : []), current.appliedTo, destination]
        .filter((target) => /^(?:private|group):[1-9]\d{0,14}$/u.test(String(target || ''))))];
      current.appliedTo = destination;
    }
    try { this.#persist(state, auth); } catch { /* The atomic config save already succeeded. */ }
    return destination ? `已保存角色卡“${name}”并应用到${destination.startsWith('group:') ? `群 ${destination.slice(6)}` : '当前私聊'}。` : `已保存角色卡“${name}”，ID：${card.id}。当前使用的角色没有改变。`;
  }

  async #run(command, auth) {
    this.#require(auth);
    const config = this.getConfig();
    if (command.action === 'help') return this.#reply(auth, command.error || USAGE);
    if (command.action === 'list') {
      const cards = listRoleCards(config);
      return this.#reply(auth, '角色库：\n' + cards.map((card, index) => `${index + 1}. ${card.name}\nID：${card.id}`).join('\n') + '\n\n查看原文：/角色卡 查看 卡ID\n私聊切群角色：/角色卡 使用 卡ID 群号');
    }
    if (command.action === 'current') {
      const target = this.#target(auth, command.target);
      const persona = personaForChat(target, config);
      const card = activeRoleCard(config, target);
      return this.#reply(auth, [`${target.startsWith('group:') ? `群 ${target.slice(6)}` : '当前私聊'}的角色：${card?.name || '自定义人设'}`, String(persona.roleText || ''), ...(persona.customRules ? [`补充角色规则：\n${persona.customRules}`] : [])].join('\n\n'));
    }
    if (command.action === 'view') {
      const card = this.#card(config, command.target);
      return this.#reply(auth, [`${card.name}｜${card.id}`, card.text, ...(card.customRules ? [`补充角色规则：\n${card.customRules}`] : [])].join('\n\n'));
    }
    if (['new', 'edit', 'style'].includes(command.action)) {
      const base = command.action === 'edit' ? this.#card(config, command.target) : null;
      const result = this.#makeDraft({ name: command.action === 'style' ? `群 ${command.target} 的语言风格` : base ? `${base.name}·修订` : command.target,
        text: command.text, customRules: base?.customRules || '', baseCardId: base?.id || '',
        ...(command.action === 'style' ? { kind: 'style', targetGroupId: command.target } : {}) }, auth, false);
      return this.#reply(auth, this.#formatDraft(result.draft));
    }
    if (command.action === 'drafts') {
      const state = this.#load();
      if (command.id) return this.#reply(auth, this.#formatDraft(this.#draft(state, command.id, auth)));
      const drafts = state.drafts.filter((draft) => draft.ownerId === String(auth.senderId));
      return this.#reply(auth, drafts.length ? '角色草稿：\n' + drafts.map((draft) => `${draft.id}｜${draft.name}${draft.savedAt ? '（已保存）' : '（未应用）'}`).join('\n') : '暂无角色草稿。');
    }
    if (command.action === 'cancel') {
      const state = this.#load();
      this.#draft(state, command.id, auth);
      state.drafts = state.drafts.filter((draft) => draft.id !== command.id);
      this.#persist(state, auth);
      return this.#reply(auth, `已取消草稿 ${command.id}；已保存的库中角色或已应用的角色保持原样。`);
    }
    if (command.action === 'use') {
      const card = this.#card(config, command.target);
      const destination = this.#target(auth, command.destination);
      const patch = roleCardPatch(config, destination, card.id);
      patch.personaByChat.__replace__[destination].systemPromptOverride = '';
      this.#require(auth);
      if (destination.startsWith('group:')) this.#target(auth, destination.slice(6));
      const result = await this.updateConfig(patch);
      if (result === false || result?.ok === false) throw new WorkshopError('角色切换未保存成功');
      this.preparePersonaSwitch(destination);
      return this.#reply(auth, `已为${destination.startsWith('group:') ? `群 ${destination.slice(6)}` : '当前私聊'}切换角色：${card.name}。`);
    }
    const draft = this.#draft(this.#load(), command.id, auth);
    return this.#reply(auth, await this.#saveOrApply(draft, command, auth));
  }

  #preflightBatch(commands, auth) {
    // Simulate library saves in order, so missing targets, conflicting names or
    // a later invalid command cannot cause an earlier command to be committed.
    const config = clone(this.getConfig());
    let state;
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      try {
        this.#require(auth);
        if (!FIXED_ACTIONS.has(command.action)) throw new WorkshopError('该指令需要单独发送');
        if (command.action === 'current') this.#target(auth, command.target);
        if (command.action === 'view') this.#card(config, command.target);
        if (command.action === 'use') {
          const card = this.#card(config, command.target);
          roleCardPatch(config, this.#target(auth, command.destination), card.id);
        }
        if (command.action === 'drafts') {
          state ||= this.#load();
          if (command.id) this.#draft(state, command.id, auth);
        }
        if (command.action === 'save' || command.action === 'apply') {
          const draft = this.#draft(state ||= this.#load(), command.id, auth);
          const plan = this.#planDraftCommand(draft, command, auth, config);
          if (!plan.style) {
            if (plan.destination) roleCardPatch({ ...config, customPersonas: plan.cards }, plan.destination, plan.card.id);
            config.customPersonas = plan.cards;
            draft.name = plan.name;
          }
        }
      } catch (error) {
        const reason = error instanceof WorkshopError ? error.message : '目标或草稿无法读取';
        throw new WorkshopError(`第 ${index + 1}/${commands.length} 项无效：${reason}；整批未执行。`);
      }
    }
  }

  async #runBatch(commands, auth) {
    this.#preflightBatch(commands, auth);
    const results = [];
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      const itemAuth = { ...auth, batchIndex: index + 1, batchTotal: commands.length };
      try {
        // Authorization and target checks also run inside each command against
        // live configuration, including after an awaited previous command.
        await this.#run(command, itemAuth);
        results.push({ index: index + 1, action: command.action, ok: true, changed: CHANGING_ACTIONS.has(command.action) });
      } catch (error) {
        const reason = error instanceof WorkshopError ? error.message : '保存或读取失败，请稍后再试';
        const remaining = commands.length - index - 1;
        await this.#reply(itemAuth, `角色卡操作未完成：${reason}${remaining ? `；后续 ${remaining} 项未执行` : ''}。`);
        results.push({ index: index + 1, action: command.action, ok: false, changed: false });
        for (let skipped = index + 1; skipped < commands.length; skipped++) results.push({ index: skipped + 1, action: commands[skipped].action, ok: false, changed: false, skipped: true });
        break;
      }
    }
    return { handled: true, changed: results.some((result) => result.changed), results };
  }

  handle({ chatKey, senderId, segments, messageId = '' } = {}) {
    const command = parsePersonaWorkshopCommand(segments);
    if (!command) return Promise.resolve({ handled: false });
    const auth = { chatKey, senderId: String(senderId || ''), messageId, rawText: segments.map((segment) => segment.data.text).join('') };
    return this.#queue(async () => {
      if (!this.#authorized(auth)) return { handled: true, changed: false };
      try {
        if (command.action === 'batch') return await this.#runBatch(command.commands, auth);
        await this.#run(command, auth);
        return { handled: true, changed: CHANGING_ACTIONS.has(command.action) };
      }
      catch (error) { await this.#reply(auth, `角色卡操作未完成：${error instanceof WorkshopError ? error.message : '保存或读取失败，请稍后再试'}`); return { handled: true, changed: false }; }
    });
  }
}
