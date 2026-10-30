import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';

test('offline host keeps development and holdout execution disjoint at the same round',{timeout:10000},async()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/social-multiturn-host.mjs',import.meta.url)),fileURLToPath(new URL('../qq-agent/src/social-runtime.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  const stream=readline.createInterface({input:child.stdout,crlfDelay:Infinity})[Symbol.asyncIterator]();
  const command=async payload=>{child.stdin.write(JSON.stringify(payload)+'\n');const result=await stream.next();assert.equal(result.done,false);const value=JSON.parse(result.value);assert.equal(value.error,undefined);return value;};
  try{
    await command({action:'prepare',provider:'test',arm:'phase2',split:'development',step:0});
    const held=await command({action:'prepare',provider:'test',arm:'phase2',split:'holdout',step:0});
    const out=await command({action:'apply',provider:'test',arm:'phase2',split:'holdout',step:0,items:held.cases.map(c=>({id:c.id,tool:'finish',args:{summary:'offline'}}))});
    assert.equal(out.items.length,12);assert.ok(out.items.every(i=>i.id.startsWith('H')));assert.ok(out.items.every(i=>!i.error&&!i.tool_error));
  }finally{
    child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
  }
});

test('expression replay preserves real reply parents, uses released phase2 control and isolates splits',async()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/social-multiturn-host.mjs',import.meta.url)),fileURLToPath(new URL('../qq-agent/src/social-runtime.mjs',import.meta.url)),'expression-v1'],{stdio:['pipe','pipe','pipe']});
  const stream=readline.createInterface({input:child.stdout,crlfDelay:Infinity})[Symbol.asyncIterator]();
  const command=async payload=>{child.stdin.write(JSON.stringify(payload)+'\n');const result=await stream.next();assert.equal(result.done,false);const value=JSON.parse(result.value);assert.equal(value.error,undefined);return value;};
  try{
    const base=await command({action:'prepare',provider:'test',arm:'base',split:'development',step:0});
    const tuned=await command({action:'prepare',provider:'test',arm:'phase2',split:'development',step:0});
    assert.ok(!base.base_system.includes('【群聊相处与自然表达】'));assert.ok(tuned.base_system.includes('【群聊相处与自然表达】'));
    assert.ok(base.cases[0].social_hint.includes('本批明确互动对象'));
    assert.equal(base.cases[0].knowledge_hint,'');assert.ok(tuned.cases[0].knowledge_hint.includes('M03-bureaucratic-wrap'));
    const held=await command({action:'prepare',provider:'test',arm:'phase2',split:'holdout',step:0});
    assert.equal(held.cases.length,4);assert.ok(held.cases.every(c=>c.id.startsWith('EH')));
    const out=await command({action:'apply',provider:'test',arm:'phase2',split:'holdout',step:0,items:held.cases.map(c=>({id:c.id,tool:'finish',args:{summary:'offline'}}))});
    assert.equal(out.items.length,4);assert.ok(out.items.every(i=>!i.error&&!i.tool_error));
  }finally{
    child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
  }
});
