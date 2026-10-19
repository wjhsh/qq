export function silenceState(config, chatKey, now = Date.now()) {
  const match = /^group:([1-9]\d{0,14})$/u.exec(String(chatKey));
  const until = match ? config.harnessControl?.silencedGroups?.[match[1]] : undefined;
  const active = typeof until === 'number' && Number.isFinite(until) && (until === 0 || until > now);
  return { active, until: active ? until : null };
}

export const isGroupSilenced = (config, chatKey, now) => silenceState(config, chatKey, now).active;

export function parseSilenceCommand(chatKey, name, body, now = Date.now()) {
  const parts = body.trim().split(/\s+/u).filter(Boolean);
  const group = /^group:([1-9]\d{0,14})$/u.exec(chatKey);
  const groupId = group ? group[1] : parts.shift();
  if (!/^[1-9]\d{0,14}$/u.test(groupId || '')) throw new Error('请在群内使用，或私聊填写群号：/闭嘴 群号 [分钟]、/开口 群号');
  if (name === '开口') {
    if (parts.length) throw new Error('格式：群内 /开口，私聊 /开口 群号');
    return { groupId, until: null };
  }
  if (name !== '闭嘴' || parts.length > 1) throw new Error('格式：/闭嘴 或 /闭嘴 30分钟');
  if (!parts.length) return { groupId, until: 0 };
  const duration = /^([1-9]\d{0,3})(?:分钟|分)?$/u.exec(parts[0]);
  const minutes = duration ? Number(duration[1]) : 0;
  if (minutes < 1 || minutes > 1440) throw new Error('静默时长为1至1440分钟；不填时长则持续到 /开口');
  return { groupId, until: now + minutes * 60000 };
}
