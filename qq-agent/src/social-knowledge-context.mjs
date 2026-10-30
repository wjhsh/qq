// qq-agent/src/social-knowledge-context.mjs
// 默认关闭的 linked-v1 上下文补全实验。只决定“喂给检索的 query 从哪来”，
// 不改检索算法、不改 BM25 门槛、不加 feedback 证据。
//
// 边界：
// - current 模式完全等价于原 knowledgeHint 的 owner directText 查询。
// - linked-v1 额外只取本次 owner 的 reply.mid 指向的、本群 store 查到、
//   self===true、personaScope 严格等于当前完整 scope、非 modelExcluded、
//   文本有上限的猫父消息，最多 2 条、总 400 字。
// - 不读消息内伪造引用字符串；不用任意环境历史；不跨群；不读其他 AI 发言；
//   不用图片/拍一拍合成描述当父消息正文（父消息只有 text）。
// - 引用原文不进替代反馈证据；调用方不得把 linked 文本交给 feedback。

import {modelInputAllowed} from './input-guard.mjs';
const DEFAULT_MAX_LINKED = 2;
const DEFAULT_MAX_LINKED_CHARS = 400;
const DEFAULT_MAX_TOTAL_CHARS = 600;
const HARD_TEXT_CAP = 200; // 单条父消息文本硬上限，超出截断

export function knowledgeContextModeOf(config) {
  try {
    const m = config?.socialBehavior?.phase2?.knowledgeContext;
    return m === 'linked-v1' ? 'linked-v1' : 'current';
  } catch {
    return 'current';
  }
}

/**
 * @param {object} args
 * @param {object} args.runtime        需有 getConfig / roleIdentity(scope) 提供方
 * @param {string} args.chatKey
 * @param {object[]} args.entries      本批触发消息
 * @param {object} args.store          需有 findByMid(chatKey, mid)
 * @param {string|null} args.roleScope 当前完整 roleScope（由调用方算）
 * @param {string|null} [args.owner]   由调用方算的 owner（socialFocusOwner 结果）
 */
export function buildKnowledgeQuery({
  runtime,
  chatKey,
  entries,
  store,
  roleScope,
  owner,
}) {
  const cfg = runtime?.getConfig?.() ?? {};
  const mode = knowledgeContextModeOf(cfg);
  const list = Array.isArray(entries) ? entries : [];

  const ownEntries = owner
    ? list.filter(
        (e) =>
          String(e?.senderId) === String(owner) &&
          !e.self && !e.isPoke && modelInputAllowed(e)
      )
    : [];

  const rawOwn = ownEntries
    .map((e) => (typeof e?.directText === 'string' ? e.directText : ''))
    .filter(Boolean)
    .join('\n');

  // 正文先不截：调用方当前行为是 slice(0,600)，这里保持一致语义，
  // 只在下方统一裁到 MAX_TOTAL。
  const ownText = rawOwn;

  if (!owner) {
    return {
      query: '',
      mode,
      ownTextChars: 0,
      linkedCount: 0,
      linkedChars: 0,
      reason: 'no_owner',
    };
  }
  if (!ownText.trim()) {
    return {
      query: '',
      mode,
      ownTextChars: 0,
      linkedCount: 0,
      linkedChars: 0,
      reason: 'no_own_text',
    };
  }

  if (mode !== 'linked-v1') {
    const query = ownText.slice(0, DEFAULT_MAX_TOTAL_CHARS);
    return {
      query,
      mode,
      ownTextChars: query.length,
      linkedCount: 0,
      linkedChars: 0,
      reason: 'current',
    };
  }

  // ── linked-v1 ──
  const linked = [];
  let linkedChars = 0;
  const dropped = { no_store: 0, not_parent: 0, not_self: 0, scope: 0, excluded: 0, empty: 0, cap: 0 };

  const mids = [];
  const seenMids = new Set();
  for (const e of ownEntries) {
    const mid = e?.reply?.mid;
    if (mid != null && String(mid) && !seenMids.has(String(mid))) {
      mids.push(mid);seenMids.add(String(mid));
    }
  }

  if (!store || typeof store.findByMid !== 'function') {
    dropped.no_store = mids.length;
  } else {
    for (const mid of mids) {
      if (linked.length >= DEFAULT_MAX_LINKED) break;
      let parent = null;
      try {
        parent = store.findByMid(chatKey, mid);
      } catch {
        parent = null;
      }
      if (!parent) { dropped.not_parent++; continue; }
      if (parent.self !== true || parent.senderId !== 'self' || String(parent.mid)!==String(mid)) { dropped.not_self++; continue; }
      // 严格完整 scope 相等；任何缺省/空值都拒绝
      if (
        typeof roleScope !== 'string' ||
        !roleScope ||
        parent.personaScope !== roleScope
      ) {
        dropped.scope++;
        continue;
      }
      if (!modelInputAllowed(parent) || parent.recalled === true || parent.isPoke === true || parent.media?.length) { dropped.excluded++; continue; }
      const text = typeof parent.text === 'string' ? parent.text : '';
      if (!text.trim()) { dropped.empty++; continue; }
      const clipped = text.slice(0, HARD_TEXT_CAP);
      if (linkedChars + clipped.length > DEFAULT_MAX_LINKED_CHARS) {
        // 放不下就跳过，不半截塞进去
        dropped.cap++;
        continue;
      }
      linked.push(clipped);
      linkedChars += clipped.length;
    }
  }

  // 正文保留优先：ownText 先占满，再拼 linked；总不超 600。
  let query = ownText.slice(0, DEFAULT_MAX_TOTAL_CHARS);
  let appended = 0;
  let appendedChars = 0;
  for (const t of linked) {
    if (query.length + 1 + t.length > DEFAULT_MAX_TOTAL_CHARS) break;
    query += '\n' + t;
    appended++;appendedChars+=t.length;
  }

  return {
    query,
    mode,
    ownTextChars: Math.min(ownText.length,DEFAULT_MAX_TOTAL_CHARS),
    linkedCount: appended,
    linkedChars: appendedChars,
    reason:
      mode === 'linked-v1' && appended === 0
        ? `linked_empty:${Object.entries(dropped)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}=${v}`)
            .join(',') || 'no_reply_mid'}`
        : 'linked-v1',
  };
}
