// Local ranking evaluation. No model/network calls; negative queries count too.
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {HumorKnowledge} from '../qq-agent/src/humor-knowledge.mjs';
const args=process.argv.slice(2),option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const split=option('--split','development');if(!['development','holdout'].includes(split))throw Error('Invalid split');
const file=new URL('../tests/fixtures/retrieval-bench/'+split+'.json',import.meta.url),bytes=fs.readFileSync(file),queries=JSON.parse(bytes);
const knowledge=new HumorKnowledge({now:()=>1793336400000});const result={split,fixture_sha256:createHash('sha256').update(bytes).digest('hex'),conditions:'Same reviewed pool, top-k=2, fixed time, no fitting on holdout',methods:{}};
for(const method of ['lexical','hybrid']){
  let positives=0,hits=0,negatives=0,falseRecall=0,totalRelevant=0,totalFound=0,matchedRelevant=0;const failures=[];
  for(const q of queries){
    const found=knowledge.search(q.query,{method,limit:2,roleKind:'cat'}).map(x=>x.id),matches=found.filter(id=>q.relevant.includes(id));
    totalFound+=found.length;matchedRelevant+=matches.length;totalRelevant+=q.relevant.length;
    if(q.relevant.length){positives++;if(matches.length)hits++;if(!matches.length)failures.push({id:q.id,type:'miss',found,expected:q.relevant});}
    else{negatives++;if(found.length){falseRecall++;failures.push({id:q.id,type:'false_recall',found,expected:[]});}}
  }
  const before=process.memoryUsage().heapUsed,timings=[];
  for(let i=0;i<1000;i++){const t=performance.now();knowledge.search(queries[i%queries.length].query,{method,roleKind:'cat'});timings.push(performance.now()-t);}
  timings.sort((a,b)=>a-b);
  result.methods[method]={positive_queries:positives,negative_queries:negatives,hit_at_2:positives?hits/positives:0,recall_at_2:totalRelevant?matchedRelevant/totalRelevant:0,precision_at_2:totalFound?matchedRelevant/totalFound:0,false_recall_rate:negatives?falseRecall/negatives:0,hit_count:hits,false_recall_count:falseRecall,
    balanced_utility:hits-2*falseRecall,latency_ms:{median:timings[500],p95:timings[950]},heap_delta_bytes:process.memoryUsage().heapUsed-before,failures};
}
const out=option('--output',null);if(out)fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
