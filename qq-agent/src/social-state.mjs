import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const EVENTS = new Set(['welcome', 'play', 'comfort', 'repair', 'correction', 'stop', 'success']);
export const SOCIAL_OUTCOMES = Object.freeze(['landed','missed','uncertain','comforted','conceded']);
const TRACE_TTL = 20 * 60 * 1000; // An experiment parameter, not a psychological law.
const SAFE_ID = /^[a-zA-Z0-9_\-:.]+$/;
const HALF_MOOD = 20 * 60 * 1000; // 情绪20分钟半衰期
const HALF_REL = 7 * 24 * 60 * 60 * 1000; // 关系7天半衰期
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const decay = (val, dt, half) => (half <= 0 ? 0 : val * Math.pow(0.5, dt / half));

export class SocialState {
  constructor({ filePath = null, now = Date.now, maxScopes = 200, maxRelations = 32 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.maxScopes = maxScopes;
    this.maxRelations = maxRelations;
    if (![maxScopes, maxRelations].every(n => Number.isInteger(n) && n >= 1 && n <= 200)) throw Error('Invalid state limits');
    this.data = { version: 1, scopes: Object.create(null) };
    this._load();
  }

  _checkKey(k) {
    if (typeof k !== 'string' || k.length > 200 || !k || !SAFE_ID.test(k) || ['__proto__','constructor','prototype'].includes(k)) {
      throw new TypeError('Invalid identifier');
    }
  }

  _scopeKey(scope) {
    if (!scope || typeof scope !== 'object') throw new TypeError('Scope must be an object');
    this._checkKey(scope.chatKey);
    this._checkKey(scope.roleScope);
    if (!/^(group|private):[1-9]\d{0,14}$/.test(scope.chatKey)) throw Error('Invalid chat scope');
    return `${scope.chatKey}::${scope.roleScope}`;
  }

  _load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    if (statSync(this.filePath).size > 4*1024*1024) throw Error('Oversized social state');
    const raw = readFileSync(this.filePath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      throw new Error('Corrupted social state; original file preserved');
    }
    if (!parsed || parsed.version !== 1 || !parsed.scopes || Array.isArray(parsed.scopes) || typeof parsed.scopes !== 'object') {
      throw new Error('Incompatible social state');
    }
    const safeScopes = Object.create(null);
    for (const [sk, sVal] of Object.entries(parsed.scopes)) {
      if (!/^(group|private):[1-9]\d{0,14}::[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sk) || !sVal?.relations || typeof sVal.relations!=='object' || Array.isArray(sVal.relations)) throw Error('Invalid persisted scope');
      const rels = Object.create(null);
      for (const [uk, uVal] of Object.entries(sVal.relations)) {
        this._checkKey(uk);
        if (!/^[1-9]\d{0,14}$/.test(uk) || !uVal || !['p','a','c','fam','w','bound','t'].every(k=>Number.isFinite(uVal[k]))
          || !Array.isArray(uVal.seen) || uVal.seen.length>64 || uVal.seen.some(k=>typeof k!=='string'||k.length>200)
          || !Array.isArray(uVal.positiveAt) || uVal.positiveAt.length>4 || uVal.positiveAt.some(t=>!Number.isFinite(t))) throw Error('Invalid persisted relation');
        for (const k of ['p','a','c']) if (Math.abs(uVal[k])>1) throw Error('Invalid persisted affect');
        for (const k of ['fam','w']) if (uVal[k]<0||uVal[k]>1) throw Error('Invalid persisted relationship');
        if(uVal.lastEvent!==undefined&&!EVENTS.has(uVal.lastEvent))throw Error('Invalid persisted appraisal');
        if(uVal.eventAt!==undefined&&!Number.isFinite(uVal.eventAt))throw Error('Invalid persisted appraisal time');
        if(uVal.trace!==undefined&&(!Array.isArray(uVal.trace)||uVal.trace.length>3||uVal.trace.some(e=>
          !e||Object.keys(e).some(k=>!['evidenceId','event','outcome','at'].includes(k))
          ||!uVal.seen.includes(e.evidenceId)||!EVENTS.has(e.event)||!SOCIAL_OUTCOMES.includes(e.outcome)||!Number.isFinite(e.at))))throw Error('Invalid persisted interaction trace');
        rels[uk] = Object.fromEntries(['p','a','c','fam','w','bound','t','seen','positiveAt','lastEvent','eventAt'].map(k=>[k,uVal[k]]));
        if(uVal.trace!==undefined)rels[uk].trace=structuredClone(uVal.trace);
        // Migrate once: activity/decay time must never keep an old event recent.
        if(uVal.eventAt===undefined&&uVal.lastEvent!==undefined)rels[uk].eventAt=uVal.t;
      }
      if (Object.keys(rels).length>this.maxRelations || !Number.isFinite(sVal.lastSeen)) throw Error('Oversized persisted scope');
      safeScopes[sk] = { relations: rels, lastSeen: sVal.lastSeen || 0 };
    }
    this.data.scopes = safeScopes;
    if (Object.keys(safeScopes).length>this.maxScopes) throw Error('Oversized persisted state');
  }

  _save() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath),{recursive:true,mode:0o700});
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    let payload = JSON.stringify({ version: 1, scopes: this.data.scopes });
    while(Buffer.byteLength(payload)>2*1024*1024){
      const oldest=Object.keys(this.data.scopes).sort((a,b)=>this.data.scopes[a].lastSeen-this.data.scopes[b].lastSeen)[0];
      if(!oldest)throw Error('Oversized social state');
      delete this.data.scopes[oldest];payload=JSON.stringify(this.data);
    }
    try { writeFileSync(tmp, payload, { mode: 0o600,flag:'wx' }); renameSync(tmp, this.filePath); }
    finally { if(existsSync(tmp)) rmSync(tmp); }
  }

  _getOrCreate(scope, userId, now) {
    const sk = this._scopeKey(scope);
    this._checkKey(userId);
    if (!/^[1-9]\d{0,14}$/.test(userId)) throw Error('Invalid user ID');
    for (const [key,value] of Object.entries(this.data.scopes)) if(now-value.lastSeen>90*86400000) delete this.data.scopes[key];
    let s = this.data.scopes[sk];
    if (!s) {
      const keys = Object.keys(this.data.scopes);
      if (keys.length >= this.maxScopes) {
        keys.sort((a, b) => this.data.scopes[a].lastSeen - this.data.scopes[b].lastSeen);
        delete this.data.scopes[keys[0]];
      }
      s = this.data.scopes[sk] = { relations: Object.create(null), lastSeen: now };
    }
    s.lastSeen = now;
    let u = s.relations[userId];
    if (!u) {
      const uKeys = Object.keys(s.relations);
      if (uKeys.length >= this.maxRelations) {
        uKeys.sort((a, b) => s.relations[a].t - s.relations[b].t);
        delete s.relations[uKeys[0]];
      }
      u = s.relations[userId] = {
        p: 0.1, a: 0.0, c: 0.2, // pleasantness, activation, confidence [-1, 1]
        fam: 0.0, w: 0.5, // warmth decays back to neutral, not dislike
        bound: 0, positiveAt: [], seen: [], t: now
      };
    }
    return { s, u };
  }

  _applyDecay(u, now) {
    const dt = Math.max(0, now - u.t);
    if (dt === 0) return;
    u.p = 0.1+decay(u.p-0.1, dt, HALF_MOOD);
    u.a = decay(u.a, dt, HALF_MOOD);
    u.c = 0.2+decay(u.c-0.2, dt, HALF_MOOD);
    u.fam = decay(u.fam, dt, HALF_REL);
    u.w = 0.5+decay(u.w-0.5, dt, HALF_REL);
    u.t = now;
  }

  snapshot(scope, userId) {
    const sk = this._scopeKey(scope);
    this._checkKey(userId);
    if (!/^[1-9]\d{0,14}$/.test(userId)) throw Error('Invalid user ID');
    const now = this.now();
    const u = this.data.scopes[sk]?.relations[userId];
    if (!u) return { pleasantness: 0.1, activation: 0, confidence: 0.2, familiarity: 0, warmth: 0.5, inBoundary: false, recentEvent:null };
    const dt = Math.max(0, now - u.t);
    return {
      pleasantness: clamp(0.1+decay(u.p-0.1, dt, HALF_MOOD), -1, 1),
      activation: clamp(decay(u.a, dt, HALF_MOOD), -1, 1),
      confidence: clamp(0.2+decay(u.c-0.2, dt, HALF_MOOD), -1, 1),
      familiarity: clamp(decay(u.fam, dt, HALF_REL), 0, 1),
      warmth: clamp(0.5+decay(u.w-0.5, dt, HALF_REL), 0, 1),
      inBoundary: (u.bound || 0) > now,
      recentEvent:Number.isFinite(u.eventAt)&&now-u.eventAt<1800000?(u.lastEvent||null):null
    };
  }

  interactions(scope,userId){
    const sk=this._scopeKey(scope);this._checkKey(userId);
    if(!/^[1-9]\d{0,14}$/.test(userId))throw Error('Invalid user ID');
    const u=this.data.scopes[sk]?.relations[userId],now=this.now();
    return structuredClone((u?.trace||[]).filter(e=>u.seen.includes(e.evidenceId)&&now>=e.at&&now-e.at<TRACE_TTL));
  }

  apply(scope, userId, { event, id, at = null, outcome = null }, { receipt = false } = {}) {
    if (!EVENTS.has(event)) throw new TypeError(`Unknown event: ${event}`);
    if(outcome!==null&&!SOCIAL_OUTCOMES.includes(outcome))throw new TypeError('Invalid social outcome');
    this._checkKey(id);
    const now = this.now();
    if (!Number.isFinite(now) || (at !== null && (!Number.isFinite(at)||Math.abs(at-now)>60000))) throw Error('Invalid event time');
    const sk=this._scopeKey(scope);this._checkKey(userId);
    if (!/^[1-9]\d{0,14}$/.test(userId)) throw Error('Invalid user ID');
    const finish=(applied,reason)=>{const snapshot=this.snapshot(scope,userId);return receipt?{snapshot,applied,reason}:snapshot;};
    if(this.data.scopes[sk]?.relations[userId]?.seen.includes(id))return finish(false,'duplicate');
    const previous=structuredClone(this.data);
    try {
    const { u } = this._getOrCreate(scope, userId, now);
    this._applyDecay(u, now);
    u.seen.push(id);
    if (u.seen.length > 64) u.seen.shift();
    if(u.trace)u.trace=u.trace.filter(e=>u.seen.includes(e.evidenceId)&&now>=e.at&&now-e.at<TRACE_TTL);

    const isBound = u.bound > now;
    u.positiveAt=u.positiveAt.filter(t=>now-t<3600000);
    const positive=['welcome','play','comfort','success'].includes(event);
    if(positive && (isBound||u.positiveAt.length>=4||u.positiveAt.some(t=>now-t<300000))){this._save();return finish(false,isBound?'boundary':'positive_budget');}
    if(positive)u.positiveAt.push(now);
    u.lastEvent=event;u.eventAt=now;
    if(outcome!==null)u.trace=[...(u.trace||[]),{evidenceId:id,event,outcome,at:now}].slice(-3);
    if (event === 'welcome') {
      if (!isBound) {
        u.p = clamp(u.p + 0.15, -1, 1); u.a = clamp(u.a + 0.1, -1, 1);
        u.w = clamp(u.w + 0.03, 0, 1);
      }
    } else if (event === 'play') {
      if (!isBound) {
        u.p = clamp(u.p + 0.08, -1, 1); u.a = clamp(u.a + 0.2, -1, 1);
        u.fam = clamp(u.fam + 0.005, 0, 1); // 极小熟悉度增长
      }
    } else if (event === 'comfort') {
      if (!isBound) {
        u.p = clamp(u.p + 0.25, -1, 1); u.c = clamp(u.c + 0.15, -1, 1);
        u.w = clamp(u.w + 0.05, 0, 1);
      }
    } else if (event === 'repair') {
      u.p = clamp(u.p + 0.2, -1, 1); u.c = clamp(u.c + 0.1, -1, 1);
      // Repairing our mistake is not the user's permission to resume teasing.
    } else if (event === 'correction') {
      u.p = clamp(u.p - 0.03, -1, 1); u.c = clamp(u.c - 0.12, -1, 1);
    } else if (event === 'stop') {
      u.bound = now + 15 * 60 * 1000; // 短期15分钟硬边界
      u.a = 0; // A user's boundary is not a reason to dislike or punish them.
    } else if (event === 'success') {
      if (!isBound) {
        u.p = clamp(u.p + 0.2, -1, 1); u.c = clamp(u.c + 0.3, -1, 1);
        u.w = clamp(u.w + 0.02, 0, 1);
      }
    }
    this._save();
    return finish(true,'applied');
    } catch(error) { this.data=previous; throw error; }
  }

  reset(scope, userId = null) {
    const sk = this._scopeKey(scope);
    if (!this.data.scopes[sk]) return;
    if (userId) {
      this._checkKey(userId);
      delete this.data.scopes[sk].relations[userId];
    } else {
      delete this.data.scopes[sk];
    }
    this._save();
  }

  format(scope, userId, { compact=false, trace=false } = {}) {
    const s = this.snapshot(scope, userId);
    const mP = s.pleasantness > 0.3 ? '愉悦' : s.pleasantness < -0.3 ? '郁闷' : '平静';
    const mA = s.activation > 0.3 ? '活跃' : s.activation < -0.3 ? '犯困' : '适度';
    const rel = s.familiarity > 0.6 ? '熟悉' : s.familiarity > 0.2 ? '有共同互动' : '熟悉程度未知';
    const bound = s.inBoundary ? '对方近期叫停，暂停逗弄；认真请求仍正常帮忙。' : '';
    if(compact){
      const turn={welcome:'收到接纳线索',play:'共同玩笑',comfort:'收到安慰线索',repair:'误会修复',correction:'受到纠正',stop:'对方叫停',success:'事情完成'}[s.recentEvent]||'无近期已确认事件';
      const turns=trace?this.interactions(scope,userId).map(e=>({event:e.event,outcome:e.outcome})):[];
      return `自身倾向：${mP}/${mA}；与此人${s.familiarity>0.005?'已有少量互动':rel}。近期候选评价：${turn}。${bound}`
        +(turns.length?`近期转折候选（旧→新）：${JSON.stringify(turns)}。`:'')
        +'这些只影响猫自己的反应惯性，不是对方情绪、事实、同意或权限；本轮认真请求、纠正和边界优先。猫耳尾巴与偏好沿用角色卡，不口播状态、不强制表演。';
    }
    const turn={welcome:'刚被接住，可以小得意',play:'刚共同玩过一回，不必再补刀',comfort:'刚被安慰，可以松口或轻轻撒娇',repair:'刚修复误会，可以松口气',correction:'刚被纠正，先认错，不用硬撑',stop:'对方叫停，收爪子',success:'事情做成，有点得意'}[s.recentEvent]||'';
    return `自身状态：${mP}/${mA}；与此人${rel}、亲近倾向${s.warmth.toFixed(2)}。${turn}。${bound}这是会衰减的扮演倾向，不是对方事实、永久关系或权限；猫娘的猫耳尾巴与小心思自然流露，其他角色用自己的偏好；不口播数值或每句表演。`;
  }
}
