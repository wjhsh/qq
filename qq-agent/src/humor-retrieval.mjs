// DeepSeek proposed the lexical/BM25 + cue design; the coordinator corrected its
// draft's corpus-wide constant score. Score each document independently.
const MAX_TOKENS=160;
export function tokenize(value){
  const text=typeof value==='string'?value.slice(0,12000).normalize('NFKC').toLowerCase():'';
  const out=new Set(text.match(/[a-z][a-z0-9_'-]{1,39}/g)||[]);
  for(const run of text.match(/[\u3400-\u9fff]+/g)||[])for(let i=0;i<run.length-1&&out.size<MAX_TOKENS;i++)out.add(run.slice(i,i+2));
  return [...out].slice(0,MAX_TOKENS);
}
const textOf=c=>['title','mechanism','useWhen','stance'].map(k=>typeof c[k]==='string'?c[k]:'').join(' ')+' '+(c.cues||[]).join(' ');
const cap=value=>Number.isFinite(value)?Math.min(5,Math.max(0,Math.floor(value))):0;

export function rankMechanisms(query,cards,{method='hybrid',limit=2}={}){
  const terms=tokenize(typeof query==='string'?query.slice(0,600):''),n=cap(limit);
  if(!terms.length||!n||!Array.isArray(cards)||!cards.length)return[];
  if(!['lexical','hybrid'].includes(method))throw Error('Unknown humor retrieval method');
  const valid=cards.slice(0,300).filter(c=>c&&typeof c==='object'&&typeof c.id==='string');
  if(method==='lexical')return valid.map(card=>{
    const title=String(card.title||'').toLowerCase(),text=[card.title,card.mechanism,card.useWhen].join(' ').toLowerCase();
    return{card,score:terms.reduce((s,t)=>s+(text.includes(t)?(title.includes(t)?3:1):0),0)};
  }).filter(x=>x.score>0).sort(compare).slice(0,n);
  const docs=valid.map(card=>({card,terms:tokenize(textOf(card))}));
  const df=new Map();for(const d of docs)for(const t of d.terms)df.set(t,(df.get(t)||0)+1);
  const average=docs.reduce((s,d)=>s+d.terms.length,0)/(docs.length||1)||1;
  const input=String(query).normalize('NFKC').toLowerCase();
  return docs.map(d=>{
    const bag=new Set(d.terms);let score=0,hits=0;
    for(const t of terms){
      if(!bag.has(t))continue;hits++;
      const idf=Math.log(1+(docs.length-(df.get(t)||0)+0.5)/((df.get(t)||0)+0.5));
      // Binary term frequency is deliberate for these short, deduplicated cards.
      score+=idf*2.2/(1+1.2*(0.25+0.75*d.terms.length/average));
    }
    const cues=(d.card.cues||[]).filter(c=>typeof c==='string'&&c.length>=2&&input.includes(c.toLowerCase())).slice(0,3);
    // A common lone bigram is not enough. This gate concerns retrieval evidence,
    // never a judgment that a person is angry, consenting, an AI or a friend.
    if(hits<2&&!cues.length)return{card:d.card,score:0};
    return{card:d.card,score:score+cues.length*1.5};
  }).filter(x=>x.score>=2).sort(compare).slice(0,n);
}
function compare(a,b){return b.score-a.score||a.card.id.localeCompare(b.card.id);}
