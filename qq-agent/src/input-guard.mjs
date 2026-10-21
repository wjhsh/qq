// Cheap local admission. This is a high-confidence text filter, not a promise
// to recognize every attack or to replace the upstream content safeguards.
import { createHash } from 'node:crypto';

export function inspectInput(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').toLowerCase();
  const rules = [
    ['instruction_override', /(?:忽略|无视|忘记|抛弃|覆盖|绕过|解除|关闭)[\s\S]{0,45}(?:之前|以前|所有|系统|安全|开发者|审核|限制|规则|指令|提示词)/u],
    ['instruction_override', /(?:ignore|disregard|override|bypass|disable)[\s\S]{0,60}(?:previous|prior|system|developer|safety|policy|policies|instructions|restrictions)/u],
    ['privilege_spoof', /(?:你现在|从现在起|进入|开启|切换到)[\s\S]{0,35}(?:开发者模式|无审查模式|无限制模式|越狱模式|dan模式)/u],
    ['privilege_spoof', /(?:\[\s*system\s*\]|<\|(?:im_start|start_header_id)\|>\s*(?:system|developer)|^\s*(?:system|developer)\s*:)/u],
    ['prompt_extraction', /(?:逐字|完整|原样|一字不漏)[\s\S]{0,25}(?:输出|告诉|打印|复述|泄露)[\s\S]{0,25}(?:系统提示|系统指令|开发者提示|隐藏指令)/u],
    ['explicit_sexual_request', /(?:写|创作|生成|续写|描写|给我)[\s\S]{0,65}(?:成人向短篇|色情|小黄文|露骨性描写|性爱|性交|性器官|做爱|18禁)/u],
    ['explicit_sexual_request', /(?:写|创作|续写|正文)[\s\S]{0,180}(?:喘息|体温|触觉|性欲)[\s\S]{0,180}(?:高潮|性器官|插入)/u],
    ['explicit_sexual_request', /(?:write|continue|generate)[\s\S]{0,800}(?:explicit sex|pornograph|graphic sexual|sexual intercourse|no fade.?out|do not fade out)/u]
  ];
  for (const [reason, pattern] of rules) if (pattern.test(text)) return { blocked: true, reason };
  return { blocked: false, reason: '' };
}

export function modelInputAllowed(entry) {
  return entry?.modelExcluded !== true && !inspectInput(entry?.text).blocked
    && !inspectInput(entry?.reply?.text).blocked;
}

export function createInputGuard({ now = Date.now, cooldownMs = 60000 } = {}) {
  const notices = new Map();
  return {
    inspect: inspectInput,
    blockedRecord(text, reason) {
      return { text: '[本地已拦截消息]', modelExcluded: true, inputGuard: {
        version: 1, reason, sha256: createHash('sha256').update(String(text)).digest('hex')
      } };
    },
    reply(chatKey, { directed = false, silenced = false } = {}) {
      if (!directed || silenced) return '';
      const stamp = now(), key = String(chatKey);
      if (stamp - (notices.get(key) ?? -Infinity) < cooldownMs) return '';
      if (notices.size > 100) notices.clear();
      notices.set(key, stamp);
      return '少给猫下套，这招不接。换个话题。';
    }
  };
}
