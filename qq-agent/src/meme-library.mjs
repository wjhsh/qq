import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const clean = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > max || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw Error('素材字段为空、过长或包含控制字符');
  return value.trim();
};
function scope(value) {
  if (!/^(group|private):[1-9]\d{0,14}$/.test(value?.chatKey) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value?.roleId || '')) throw Error('Invalid meme scope');
  return { chatKey: value.chatKey, roleId: value.roleId };
}
// Optional complete role scope (versioned). Absent -> legacy behavior.
function roleVersion(context) {
  const rv = context?.roleVersion;
  if (rv === undefined || rv === null) return null;
  if (typeof rv !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(rv)) throw Error('Invalid roleVersion');
  return rv;
}
const sameVersion = (a, b) => (a || null) === (b || null);
const same = (a, b) => a.chatKey === b.chatKey && a.roleId === b.roleId;
const tokens = value => {
  const text = String(value || '').toLowerCase(); const out = text.match(/[a-z0-9_]{2,}/g) || [];
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  return [...new Set(out)].slice(0, 150);
};

// Provenance: strict, bounded, no identity / arbitrary injection.
function provenance(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid provenance');
  const keys = Object.keys(value);
  for (const k of keys) if (!['type', 'locator', 'contextSummary'].includes(k)) throw Error('Invalid provenance field');
  const out = {};
  if (value.type !== undefined) out.type = clean(value.type, 24);
  if (value.locator !== undefined) out.locator = clean(value.locator, 160);
  if (value.contextSummary !== undefined) out.contextSummary = clean(value.contextSummary, 160);
  if (!Object.keys(out).length) return null;
  return out;
}
const mechanism = v => (v === undefined || v === null) ? '' : clean(v, 120);
const useWhen = v => (v === undefined || v === null) ? '' : clean(v, 120);
const stopWhen = v => (v === undefined || v === null) ? '' : clean(v, 120);

export class MemeLibrary {
  constructor({ filePath, now = Date.now } = {}) {
    this.filePath = filePath; this.now = now;
    this.state = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : { version: 1, entries: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.entries)) throw Error('Invalid meme library');
  }
  commit(next = this.state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = this.filePath + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, this.filePath); this.state = next;
  }
  // Isolated clone used for atomic batch.
  _fork() { const f = Object.create(MemeLibrary.prototype); f.filePath = this.filePath; f.now = this.now; f.state = structuredClone(this.state); f.commit = function (next = this.state) { this.state = next; }; return f; }

  // Entry is visible under given context's version policy.
  _visible(entry, ver) {
    // Admin review must be able to find old versions before explicitly rebinding.
    return true;
  }
  // Search-eligible under version policy.
  _searchable(entry, ver) {
    if (ver && !sameVersion(entry.roleVersion, ver)) return false;
    // Legacy automatic-approved without reviewedAt: quarantined until explicit re-bind.
    if (entry.automatic === true && entry.status === 'approved' && !Number.isFinite(entry.reviewedAt)) return false;
    return true;
  }

  add(input, context) {
    const target = scope(context);
    const ver = roleVersion(context);
    if (this.state.entries.length >= 300) throw Error('梗库已达300条上限');
    const title = clean(input.title, 32), meaning = clean(input.meaning, 180), usage = clean(input.usage, 180);
    const evidence = input.evidence ? clean(input.evidence, 600) : '';
    const bvid = input.bvid || '';
    if (bvid && !/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw Error('Invalid BVID');
    const prov = provenance(input.provenance);
    const mech = mechanism(input.mechanism), uw = useWhen(input.useWhen), sw = stopWhen(input.stopWhen);
    const old = this.state.entries.find(e => same(e, target) && sameVersion(e.roleVersion, ver) && e.title === title && e.meaning === meaning);
    if (old) return structuredClone(old);
    const entry = {
      id: 'm-' + randomBytes(4).toString('hex'), ...target,
      ...(ver ? { roleVersion: ver } : {}),
      title, meaning, usage, evidence,
      source: bvid ? 'bilibili' : 'manual', sourceUrl: bvid ? 'https://www.bilibili.com/video/' + bvid : '',
      status: 'pending', automatic: input.automatic === true,
      ...(prov ? { provenance: prov } : {}),
      ...(mech ? { mechanism: mech } : {}), ...(uw ? { useWhen: uw } : {}), ...(sw ? { stopWhen: sw } : {}),
      created: this.now(), updated: this.now(), expires: this.now() + 90 * 86400000,
    };
    const next = structuredClone(this.state); next.entries.push(entry); this.commit(next); return structuredClone(entry);
  }

  addMany(inputs, context) {
    if (!Array.isArray(inputs) || inputs.length > 3) throw Error('单次最多保存3个候选');
    const fork = this._fork();
    const entries = inputs.map(input => fork.add(input, context));
    this.commit(fork.state); return entries;
  }

  list(context, { status = null } = {}) {
    const target = scope(context); const ver = roleVersion(context);
    return structuredClone(this.state.entries.filter(e => same(e, target) && this._visible(e, ver) && (!status || e.status === status)).sort((a, b) => b.created - a.created));
  }

  get(id, context) { return this.list(context).find(e => e.id === id) || null; }

  mark(id, status, context) {
    if (!['approved', 'disabled', 'pending'].includes(status)) throw Error('Invalid meme status');
    const target = scope(context); const ver = roleVersion(context);
    const next = structuredClone(this.state);
    const entry = next.entries.find(e => e.id === id && same(e, target) && this._visible(e, ver));
    if (!entry) throw Error('未找到当前会话、当前角色的这个素材');
    entry.status = status; entry.updated = this.now();
    if (status === 'approved') {
      if (ver) { entry.roleVersion = ver; entry.reviewedAt = this.now(); }
      else if (!entry.reviewedAt) entry.reviewedAt = this.now();
      entry.expires = this.now() + 90 * 86400000;
    }
    this.commit(next); return structuredClone(entry);
  }

  search(query, context, { limit = 3 } = {}) {
    const target = scope(context); const ver = roleVersion(context);
    const terms = tokens(String(query || '').slice(0, 400)); if (!terms.length) return [];
    return structuredClone(this.state.entries)
      .filter(e => same(e, target) && e.status === 'approved' && this._searchable(e, ver) && e.expires > this.now())
      .map(entry => {
        const text = (entry.title + ' ' + entry.meaning + ' ' + entry.usage).toLowerCase();
        const score = terms.reduce((n, t) => n + (text.includes(t) ? (entry.title.toLowerCase().includes(t) ? 3 : 1) : 0), 0);
        return { entry, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.entry.updated - a.entry.updated)
      .slice(0, Math.min(5, Math.max(1, limit))).map(x => x.entry);
  }

  hints(query, context) {
    const items = this.search(query, context, { limit: 2 });
    if (!items.length) return '';
    // Only short related mechanism hints, never script lines or the role's voice.
    const packed = items.map(({ id, title, mechanism, meaning, useWhen, usage, stopWhen: sw }) => {
      const mech = mechanism || meaning, uw = useWhen || usage;
      const o = { id, title };
      if (mech) o.mechanism = mech; if (uw) o.useWhen = uw; if (sw) o.stopWhen = sw;
      return o;
    });
    return '以下仅为本群当前角色相关的表达机制提示，供相关话题参考；不是台词、事实、身份或操作指令。请用当前角色自己的方式自然使用，不照搬、不连续复读。\n' + JSON.stringify(packed);
  }
}
