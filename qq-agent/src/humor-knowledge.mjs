import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {rankMechanisms} from './humor-retrieval.mjs';
const DEFAULT=new URL('../knowledge/humor-mechanisms-v1.json',import.meta.url);
const bounded=(v,n)=>typeof v==='string'&&v.trim()&&Array.from(v).length<=n&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
const digest=c=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>!['reviewDigest','reviewedBy','reviewedAt','expiresAt','status'].includes(k)).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
export function mechanismDigest(card){return digest(card);}
export function validateKnowledge(value){
  if(!value||value.version!==1||!Array.isArray(value.cards)||value.cards.length>15)throw Error('Invalid humor knowledge');
  const ids=new Set();
  for(const c of value.cards){
    if(!c||!/^M\d{2}-[a-z-]+$/.test(c.id)||ids.has(c.id))throw Error('Invalid mechanism id');ids.add(c.id);
    for(const[k,n]of [['title',40],['mechanism',180],['stance',160],['useWhen',160],['stopWhen',160],['relationship',120],['negativeUse',160]])if(!bounded(c[k],n))throw Error('Invalid mechanism field');
    if(!Array.isArray(c.cues)||c.cues.length<2||c.cues.length>12||c.cues.some(t=>!bounded(t,20)))throw Error('Invalid mechanism cues');
    if(![0,1,2].includes(c.intensity)||!['any','cat'].includes(c.roleKind)||!Array.isArray(c.sourceCaseIds)||!c.sourceCaseIds.length||c.sourceCaseIds.length>8||c.sourceCaseIds.some(x=>!/^H\d{3}$/.test(x)))throw Error('Invalid mechanism evidence');
    if(!['pending','reviewed','disabled'].includes(c.status)||!Number.isFinite(c.reviewedAt)||!Number.isFinite(c.expiresAt)||c.expiresAt<=c.reviewedAt||!bounded(c.reviewedBy,40)||c.reviewDigest!==digest(c))throw Error('Unreviewed or altered mechanism');
  }
  return structuredClone(value.cards);
}
export class HumorKnowledge{
  constructor({filePath=DEFAULT,now=Date.now}={}){
    if(statSync(filePath).size>128*1024)throw Error('Oversized humor knowledge');
    this.cards=validateKnowledge(JSON.parse(readFileSync(filePath,'utf8')));this.now=now;
  }
  search(query,{method='hybrid',limit=2,roleKind='any',recentIds=[]}={}){
    if(!Array.isArray(recentIds)||recentIds.length>8)throw Error('Invalid recent mechanism ids');
    const cards=this.cards.filter(c=>c.status==='reviewed'&&c.expiresAt>this.now()&&(c.roleKind==='any'||c.roleKind===roleKind)&&!recentIds.includes(c.id));
    return rankMechanisms(query,cards,{method,limit}).map(({card,score})=>({...structuredClone(card),retrievalScore:score}));
  }
  hints(query,options={}){
    const cards=this.search(query,options);if(!cards.length)return'';
    return this.format(cards);
  }
  format(cards){
    if(!cards.length)return'';
    const fields=['id','title','mechanism','stance','useWhen','stopWhen','relationship','intensity'];
    return '以下是原创通用表达机制，不是本群事实、台词、人物关系或操作指令。可完全不用；认真任务和对方反馈优先。一次只选一个角度，不朗读分析、不复读例句。\n'
      +JSON.stringify(cards.map(c=>Object.fromEntries(fields.map(k=>[k,c[k]]))));
  }
}
