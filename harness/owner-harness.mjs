import fs from 'node:fs';
import path from 'node:path';
import { parseSilenceCommand, silenceState } from './chat-silence.mjs';
import { guardianSummary } from './guardian-status.mjs';

const HELP = '实用任务（仅主人私聊）：\n/任务 做一份……（提交任务，最多10分钟）\n/任务 列表\n/任务 状态 编号\n/任务 结果 编号\n/任务 取消 编号\n/任务 文件 编号 文件名（最多2MiB）\n/维护 状态\n/维护 重启 qq-agent（或 qq-cloud-transport、qq-onebot-bridge、codex-gateway、codex-mihomo）\nRP仍用原来的 /角色卡 指令。新任务可回执到提交位置；回执未登记时主动查询结果。';
const ID = /^[a-f0-9]{12}$/;
const LABEL = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '中断待检查' };
const GROUP_HELP = '群内查询：\n/B站 帮助、/梗库 帮助\n/状态 或 /维护 状态\n/额度（Google模型配额和代理流量）\n/流量\n/线路 状态、/线路 列表\n/指令\n仅主人可修改：\n/闭嘴、/闭嘴 30分钟、/开口\n/线路 自动、/线路 切换 A（或C、V）\n/模型 列表、/模型 当前、/模型 切换 编号或名称\n/角色 列表、/角色 当前、/角色 切换 名称\n@我 切换成凑企鹅（咕咕嘎嘎／高松灯为同一角色）\n@我 记住：内容（仅本群）\n@我 共享给所有群：内容\n@我 接话概率调到30%\n@我 任务：明确的独立任务\n/群任务 列表、/群任务 结果 编号、/群任务 取消 编号\n/共享记忆 列表、/共享记忆 本群 内容、/共享记忆 全部群 内容\n/开发者 状态、/开发者 审计\n/开发者 自然管理 开或关、/开发者 判定 开或关、/开发者 RP 开或关\n/维护 重启 qq-agent（或qq-cloud-transport、qq-onebot-bridge、codex-gateway、codex-mihomo）\n自然管理只接受原始文字与真实@；角色切换仅影响本群。模型切换影响QQ全部聊天；线路切换影响共用API。';
const listed = (values, id) => Array.isArray(values) && values.map(String).includes(String(id));
export function controlGroup(config, id) {
  const allow = config.allow?.group ?? config.allow?.groups ?? [];
  const deny = config.deny?.group ?? config.deny?.groups ?? [];
  return config.harnessControl?.enabled === true && listed(allow, id) && !listed(deny, id)
    && (config.harnessControl.groupMode === 'allowlist' || listed(config.harnessControl.groupIds, id));
}
const readOnly = (name, body) => ['额度', '流量', '指令', '帮助', '状态'].includes(name)
  || name === '维护' && ['', '状态', '额度', '帮助'].includes(body)
  || name === '线路' && ['', '状态', '列表', '帮助'].includes(body);
const date = (value) => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未提供'; };
const gib = (value) => (value / 1024 ** 3).toFixed(2);
export function formatQuotas(data, trafficOnly = false) {
  const rows = [];
  if (!trafficOnly) {
    const google = data.google;
    rows.push('Google Antigravity 配额：');
    if (google?.available) {
      for (const model of google.models) rows.push(`${model.model}：${model.remaining_percent == null ? '未知' : model.remaining_percent + '%'}${model.reset_time ? '，重置 ' + date(model.reset_time) : ''}`);
      rows.push('比例由Google返回，部分模型共享配额，不能换算为调用次数。');
    } else rows.push('暂时无法读取，不代表额度为零。');
  }
  const traffic = data.traffic;
  rows.push('代理流量：');
  if (traffic?.available) rows.push(`剩余 ${gib(traffic.remaining_bytes)} / ${gib(traffic.total_bytes)} GiB\n到期：${date(traffic.expires_unix * 1000)}\n查询：${date(traffic.checked_at)}`);
  else rows.push('暂时无法读取，不代表流量为零。');
  return rows.join('\n');
}
export function createHarnessClient({ fetchImpl = globalThis.fetch, readToken = () => fs.readFileSync('/etc/qq-harness/qq-token', 'utf8').trim() } = {}) {
  return async (route, body) => {
    const response = await fetchImpl(`http://127.0.0.1:3211${route}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${readToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(route.startsWith('/quotas') ? 40000 : 20000) });
    if (Number(response.headers.get('content-length')) > 3 * 1024 * 1024) throw new Error('响应过大');
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '维护服务暂时不可用');
    return result.data;
  };
}

export function createOwnerHarness({ ownerConsole, getConfig = () => ({}), setGroupSilence, sendReply, sendFile, dataDir, onTaskSubmitted = null, request = createHarnessClient() }) {
  let pending = Promise.resolve();
  async function run({ chatKey, senderId, raw, name, body }) {
    const ctx = { chatKey, triggerEntries: [{ senderId: String(senderId), text: raw, ownerConsoleText: raw }] };
    const isGroup = /^group:[1-9]\d{0,14}$/u.test(chatKey);
    const authorized = () => {
      if (!isGroup) return ownerConsole.authorized(ctx);
      if (name === '任务') return false;
      const config = getConfig();
      const groupId = chatKey.slice(6);
      if (!controlGroup(config, groupId) || !/^[1-9]\d{0,14}$/u.test(String(senderId))
          || listed(config.blocklist?.[groupId], senderId)
          || listed(config.globalBlocklist, senderId) && !listed(config.communityExemptions, senderId)) return false;
      if (config.harnessControl.readForMembers === true && readOnly(name, body)) return true;
      // The sender ID comes from the OneBot event, never from message text.
      return ownerConsole.authorized({ ...ctx, chatKey: `private:${senderId}` }, { groupId });
    };
    if (!authorized()) return { handled: true };
    const reply = async (text) => { if (authorized()) await sendReply(chatKey, text); };
    try {
      if (name === '闭嘴' || name === '开口') {
        const change = parseSilenceCommand(chatKey, name, body);
        const canCommit = () => authorized() && controlGroup(getConfig(), change.groupId)
          && ownerConsole.authorized({ ...ctx, chatKey: `private:${senderId}` }, { groupId: change.groupId });
        if (!canCommit()) throw new Error('目标群不在允许管理的范围内');
        if (typeof setGroupSilence !== 'function') throw new Error('静默功能尚未加载');
        const result = await setGroupSilence(change.groupId, change.until, { canCommit });
        if (result?.ok !== true) throw new Error('静默设置未保存');
        await reply(change.until === null ? '已解除静默，按原有聊天设置回复。'
          : `本群已静默，@也不回复；管理指令仍可用。${change.until ? '将于 ' + date(change.until) + ' 自动恢复。' : '发送 /开口 恢复。'}`);
        return { handled: true };
      }
      if (name === '指令' || name === '帮助') { await reply(isGroup ? GROUP_HELP : GROUP_HELP + '\n\n' + HELP); return { handled: true }; }
      if (name === '状态') { name = '维护'; body = '状态'; }
      if (name === '额度' || name === '流量' || (name === '维护' && body === '额度')) {
        const result = await request(name === '流量' ? '/quotas?source=traffic' : '/quotas');
        await reply(formatQuotas(result, name === '流量'));
        return { handled: true };
      }
      if (name === '线路') {
        let result;
        if (!body || ['状态', '列表'].includes(body)) result = await request('/network/route');
        else {
          const target = body === '自动' ? 'auto' : /^切换\s+([ACV])$/iu.exec(body)?.[1]?.toUpperCase();
          if (!target) throw new Error('格式：/线路 自动，或 /线路 切换 A（C、V）');
          result = await request('/network/route', { target });
        }
        await reply(`线路模式：${result.mode === 'auto' ? '自动故障切换' : '手动固定'}\n当前：${result.selected}\n`
          + result.choices.map((choice) => `${choice.id}：${choice.name}`).join('\n')
          + '\n/线路 自动 恢复自动模式；切线会影响共用API的在途请求。');
        return { handled: true };
      }
      if (!body || body === '帮助') { await reply(isGroup ? GROUP_HELP : HELP + '\n\n' + GROUP_HELP); return { handled: true }; }
      const [action, ...rest] = body.split(/\s+/u);
      if (name === '维护') {
        if (action === '状态' && !rest.length) {
          const result = await request('/status');
          await reply(Object.entries(result.services).map(([key, value]) => `${key}：${value.ActiveState}/${value.SubState}`).join('\n')
            + `\n可用内存：${result.memory_available}\n剩余磁盘：${result.disk_free_gib} GiB\n排队任务：${result.queue}`
            + (isGroup ? `\n本群聊天：${silenceState(getConfig(), chatKey).active ? '静默中' : '按原有设置回复'}` : '') + guardianSummary());
        } else if (action === '重启' && rest.length === 1) {
          if (!['qq-agent', 'napcat-qq', 'qq-cloud-transport', 'qq-onebot-bridge', 'codex-gateway', 'codex-mihomo'].includes(rest[0])) throw new Error('服务名不在维护清单内');
          const result = await request('/maintenance/restart', { service: rest[0] });
          await reply(`已安排 ${result.service} 在4秒后重启。稍后用 /维护 状态 检查。`);
        } else throw new Error('请使用 /维护 帮助');
        return { handled: true };
      }
      if (action === '列表' && !rest.length) {
        const jobs = await request('/jobs');
        await reply(jobs.map((job) => `${job.id} ${LABEL[job.status] || job.status}`).join('\n') || '暂无任务');
      } else if (['状态', '结果', '取消', '文件'].includes(action)) {
        const jobId = rest.shift();
        if (!ID.test(jobId || '') || (action !== '文件' && rest.length) || (action === '文件' && !rest.length)) throw new Error('请使用 /任务 帮助 核对格式');
        if (action === '文件') {
          const file = await request(`/jobs/${jobId}/file?name=${encodeURIComponent(rest.join(' '))}`);
          if (!authorized()) return { handled: true };
          const name = path.basename(file.name);
          if (!name || name === '.' || name === '..' || name.includes('\u0000')) throw new Error('文件名无效');
          const dir = path.join(dataDir, 'task-files', jobId);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const buffer = Buffer.from(file.base64, 'base64');
          if (buffer.length > 2 * 1024 * 1024) throw new Error('文件超过2MiB');
          const local = path.join(dir, name);
          fs.writeFileSync(local, buffer, { mode: 0o600 });
          // The protocol client may have a separate filesystem (Docker).
          await sendFile(chatKey, `base64://${buffer.toString('base64')}`, name, authorized);
        } else {
          const job = action === '取消' ? await request(`/jobs/${jobId}/cancel`, {}) : await request(`/jobs/${jobId}`);
          const files = (job.files || []).map((f) => `${f.name}（${f.bytes}字节）`).join('\n');
          await reply(`${job.id} ${LABEL[job.status] || job.status}`
            + (job.last_tool ? `\n最近工具：${job.last_tool}` : '')
            + (action === '结果' ? `\n${(job.result || job.error || '尚无结果').slice(0, 5500)}${files ? '\n文件：\n' + files : ''}` : ''));
        }
      } else {
        if (body.length > 6000) throw new Error('任务内容最多6000字');
        const job = await request('/jobs', { prompt: body });
        let receipt = false;
        try { receipt = onTaskSubmitted?.({ jobId: job.id, chatKey, senderId }) === true; } catch { /* Submission succeeded; never resubmit on receipt failure. */ }
        await reply(`已提交任务 ${job.id}，${LABEL[job.status]}。\n用 /任务 结果 ${job.id} 查询。${receipt ? '完成或失败会回执到当前私聊。' : '未登记自动回执，请主动查询；任务已提交，无需重复。'}任务只在独立工作区执行，最多10分钟。`);
      }
    } catch (error) {
      await reply(`操作未完成：${String(error?.message || '维护服务暂时不可用').slice(0, 250)}`);
    }
    return { handled: true };
  }
  return { handle({ chatKey, senderId, segments }) {
    if (!Array.isArray(segments) || !segments.length || !segments.every((s) => s?.type === 'text' && typeof s.data?.text === 'string')) return Promise.resolve({ handled: false });
    const raw = segments.map((s) => s.data.text).join('').trim();
    const match = /^\/(任务|维护|额度|流量|线路|指令|状态|帮助|闭嘴|开口)(?=$|\s)([\s\S]*)$/u.exec(raw);
    if (!match) return Promise.resolve({ handled: false });
    const isControlGroup = chatKey.startsWith('group:') && controlGroup(getConfig(), chatKey.slice(6));
    if (['状态', '帮助'].includes(match[1]) && !isControlGroup) return Promise.resolve({ handled: false });
    const task = pending.then(() => run({ chatKey, senderId, raw, name: match[1], body: match[2].trim() }));
    pending = task.catch(() => {});
    return task;
  } };
}
