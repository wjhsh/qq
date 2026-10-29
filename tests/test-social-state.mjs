import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SocialState} from '../qq-agent/src/social-state.mjs';
const S={chatKey:'group:12345',roleScope:'cat:version1'},U='23456';
function fixture(t,options={}){let clock=0;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hajimi-social-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filePath=path.join(dir,'nested','state.json');return{filePath,now:()=>clock,advance:n=>clock+=n,state:new SocialState({filePath,now:()=>clock,...options})};}
test('causal play, comfort, correction and repair preserve mood continuity without punishing corrections',t=>{
  const f=fixture(t),a=f.state.apply(S,U,{event:'play',id:'a'});assert.ok(a.activation>0&&a.familiarity>0);
  f.advance(300001);const b=f.state.apply(S,U,{event:'comfort',id:'b'});assert.ok(b.warmth>a.warmth);
  const c=f.state.apply(S,U,{event:'correction',id:'c'});assert.equal(c.warmth,b.warmth);assert.ok(c.confidence<b.confidence);
  const d=f.state.apply(S,U,{event:'repair',id:'d'});assert.ok(d.confidence>c.confidence);assert.match(f.state.format(S,U),/猫耳尾巴/);
});
test('same evidence is idempotent and snapshots do not create relationships or write',t=>{
  const f=fixture(t);f.state.snapshot(S,U);assert.equal(fs.existsSync(f.filePath),false);
  const first=f.state.apply(S,U,{event:'welcome',id:'msg1'}),bytes=fs.readFileSync(f.filePath,'utf8');
  assert.deepEqual(f.state.apply(S,U,{event:'welcome',id:'msg1'}),first);
  assert.equal(fs.readFileSync(f.filePath,'utf8'),bytes);assert.equal(Object.keys(f.state.data.scopes).length,1);
});
test('emotion relaxes toward character home base and relationship decays toward neutral',t=>{
  const f=fixture(t),a=f.state.apply(S,U,{event:'comfort',id:'a'});f.advance(1200000);const b=f.state.snapshot(S,U);
  assert.ok(Math.abs(b.pleasantness-(0.1+(a.pleasantness-0.1)/2))<1e-9);
  f.advance(30*86400000);const c=f.state.snapshot(S,U);assert.ok(c.warmth>=0.5&&c.warmth<a.warmth);assert.equal(c.recentEvent,null);
});
test('stop is temporary, does not mean dislike, and repair cannot grant consent',t=>{
  const f=fixture(t),a=f.state.apply(S,U,{event:'stop',id:'stop'});assert.equal(a.warmth,0.5);assert.equal(a.inBoundary,true);
  f.state.apply(S,U,{event:'repair',id:'repair'});assert.equal(f.state.snapshot(S,U).inBoundary,true);
  f.state.apply(S,U,{event:'comfort',id:'push'});assert.equal(f.state.snapshot(S,U).warmth,0.5);
  f.advance(900001);assert.equal(f.state.snapshot(S,U).inBoundary,false);
});
test('groups, private chats, role revisions and people stay isolated, including reload',t=>{
  const f=fixture(t);f.state.apply(S,U,{event:'play',id:'x'});
  for(const [scope,user]of [[{...S,chatKey:'group:99999'},U],[{...S,chatKey:'private:12345'},U],[{...S,roleScope:'cat:version2'},U],[S,'99999']])assert.equal(f.state.snapshot(scope,user).familiarity,0);
  assert.deepEqual(new SocialState({filePath:f.filePath,now:f.now}).snapshot(S,U),f.state.snapshot(S,U));
  assert.equal(fs.readFileSync(f.filePath,'utf8').includes('quote'),false);
});
test('message flooding cannot farm warm relationships; budgets also work at time zero',t=>{
  const f=fixture(t);for(let i=0;i<100;i++)f.state.apply(S,U,{event:'comfort',id:'m'+i});
  assert.equal(f.state.snapshot(S,U).warmth,0.55);
  for(let i=0;i<8;i++){f.advance(300001);f.state.apply(S,U,{event:'comfort',id:'later'+i});}
  assert.ok(f.state.snapshot(S,U).warmth<0.71);
});
test('invalid times, scopes and prototype keys never persist; state size is bounded',t=>{
  const f=fixture(t,{maxScopes:2,maxRelations:2});
  for(const s of [{chatKey:'garbage',roleScope:'cat'}, {...S,roleScope:'__proto__'}])assert.throws(()=>f.state.apply(s,U,{event:'play',id:'x'}));
  for(const at of [NaN,Infinity,60001])assert.throws(()=>f.state.apply(S,U,{event:'play',id:'x',at}));
  for(let i=0;i<5;i++){f.advance(1);f.state.apply({...S,chatKey:'group:'+(12345+i)},U,{event:'play',id:'x'});}
  assert.equal(Object.keys(f.state.data.scopes).length,2);assert.ok(fs.statSync(f.filePath).size<10000);
});
test('corrupt persisted values fail closed without overwriting original file',t=>{
  const f=fixture(t);f.state.apply(S,U,{event:'play',id:'x'});const corrupt=JSON.parse(fs.readFileSync(f.filePath));
  Object.values(corrupt.scopes)[0].relations[U].p='not-a-number';const text=JSON.stringify(corrupt);fs.writeFileSync(f.filePath,text);
  assert.throws(()=>new SocialState({filePath:f.filePath}),/Invalid persisted/);assert.equal(fs.readFileSync(f.filePath,'utf8'),text);
});
