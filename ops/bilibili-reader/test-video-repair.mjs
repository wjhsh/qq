// Contract tests for the exact public vendor functions being patched.
// No real cookie, HTTP requests or production modules are loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const plan=JSON.parse(fs.readFileSync(new URL('./upstream-video-repair.json',import.meta.url),'utf8'));
const fixture=JSON.parse(fs.readFileSync(new URL('./video-repair-contract.json',import.meta.url),'utf8'));
function patched(name){let code=fixture[name];for(const {before,after}of plan.files[name].replacements){assert.equal(code.split(before).length-1,1);code=code.replace(before,after);}return code;}
class NetworkError extends Error{constructor(status){super('fixture');this.statusCode=status;}}
function video({fail=null,anonymous=false}={}){
 const calls=[],logs=[],headers=anonymous?{}:{Cookie:'TEST_ONLY_DO_NOT_LOG'};
 const fn=new Function('fetchWithWBI','fetchWithoutWBI','credentialManager','parseVideoInfoResponse','NetworkError','logger',patched('video-api.js').replace('export ','')+'\nreturn getVideoInfo;')(
  async(...args)=>{calls.push(['wbi',...args]);if(fail)throw fail;return{title:'fixture'};},
  async(...args)=>{calls.push(['plain',...args]);return{title:'fallback'};},
  {getAuthHeaders:()=>headers},value=>value,NetworkError,{warn:(...args)=>logs.push(args)});
 return{fn,calls,logs,headers};
}
test('video metadata carries existing auth on the primary path without logging it',async()=>{
 const f=video();assert.equal((await f.fn('BV1SdhgzCEXs')).title,'fixture');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0][3],f.headers);assert.equal(JSON.stringify(f.logs).includes(f.headers.Cookie),false);
});
test('HTTP412 gets one authenticated plain fallback, not an unbounded retry',async()=>{
 const f=video({fail:new NetworkError(412)});assert.equal((await f.fn('BV1SdhgzCEXs')).title,'fallback');
 assert.equal(f.calls.length,2);assert.equal(f.calls[1][3],f.headers);assert.equal(JSON.stringify(f.logs).includes(f.headers.Cookie),false);
});
test('other failures propagate and absent credentials are never fabricated',async()=>{
 const error=new NetworkError(500),f=video({fail:error});await assert.rejects(f.fn('BV1SdhgzCEXs'),e=>e===error);assert.equal(f.calls.length,1);
 const g=video({anonymous:true});await g.fn('BV1SdhgzCEXs');assert.deepEqual(g.calls[0][3],{});
});
test('WBI mix key is exactly32 and canonical signature matches independent Python urlencode/MD5 fixture',()=>{
 const fn=new Function('md5Hash',patched('wbi.js').replaceAll('export ','')+'\nreturn{getMixKey,generateWBISign};')(s=>createHash('md5').update(s).digest('hex'));
 assert.equal(fn.getMixKey('abcdefghijklmnopqrstuvwxyz012345','6789ABCDEFGHIJKLMNOPQRSTUVWXYZab').length,32);
 const original=structuredClone(plan.signature_test.params);
 assert.equal(fn.generateWBISign(original,plan.signature_test.mix_key),plan.signature_test.expected_md5);assert.deepEqual(original,plan.signature_test.params);
});
test('HTTP patch uses wts and emits only header names in debug diagnostics',()=>{
 const s=patched('http.js');assert.ok(s.includes('wts: Math.floor(Date.now() / 1000)'));assert.ok(!s.includes('timestamp:'));
 assert.ok(s.includes('headerNames: Object.keys(finalHeaders).sort()'));assert.ok(!s.includes('headers: finalHeaders'));
 const value=new Function('finalHeaders','return Object.keys(finalHeaders).sort()')({Cookie:'TEST_SECRET',Authorization:'TEST_AUTH'});
 assert.deepEqual(value,['Authorization','Cookie']);assert.equal(JSON.stringify(value).includes('TEST_SECRET'),false);
});
