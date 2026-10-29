// Offline export only. This script never opens a network connection or sends QQ messages.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DEFAULT_CONFIG,setRuntimeConfig,getConfig,deepMerge} from '../qq-agent/src/config.js';
import {NORMAL_ROLE_CARD} from '../qq-agent/src/natural-chat.mjs';
import {buildSystemPrompt} from '../qq-agent/src/prompt.js';
import {SocialRuntime} from '../qq-agent/src/social-runtime.mjs';
import {roleIdentity} from '../qq-agent/src/role-isolation.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FIX=path.join(ROOT,'tests/fixtures/social-replay');
const read=name=>JSON.parse(fs.readFileSync(path.join(FIX,name),'utf8'));
const manifest=read('manifest.json');
for(const[name,hash]of Object.entries(manifest.files)){
  const text=fs.readFileSync(path.join(FIX,name),'utf8').replace(/\r\n/g,'\n');
  if(createHash('sha256').update(text).digest('hex')!==hash)throw Error('Replay fixture changed: '+name);
}
const args=process.argv.slice(2),value=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const output=value('--output',null);
if(!output){console.log(JSON.stringify({ok:true,development:read('development.json').length,holdout:read('holdout.json').length,network:false}));}
else{
  const split=value('--split','development');if(!['development','holdout'].includes(split))throw Error('Invalid split');
  const cases=read(split+'.json').slice(0,6).map(c=>({id:c.id,metadata_limits:c.metadata_limits,
    context:c.context.filter(r=>!r.self).map(({id,speaker,text,current_snapshot_ai_flag})=>({id,speaker,text,current_snapshot_ai_flag})),
    note:'图片只是占位/描述，未提供真实图像；快照AI标记不证明历史身份；原始@和引用目标未知。'}));
  setRuntimeConfig(deepMerge(structuredClone(DEFAULT_CONFIG),{persona:{roleText:NORMAL_ROLE_CARD.text},socialBehavior:{enabled:true,allowDirectPeers:true}}));
  const runtime=new SocialRuntime({getConfig,roleIdentity});
  const baseline=buildSystemPrompt({persona:getConfig().persona,skillContext:{kind:'group'}});
  const social=buildSystemPrompt({persona:getConfig().persona,skillContext:{kind:'group'},extraSections:[{
    id:'social-continuity',title:'当前互动节奏',priority:45,content:runtime.hint('group:12345',[{senderId:'23456'}])} ]});
  const offline='这是离线文字语义回放。每个case独立：只根据其context决定猫猫会怎么接，不能执行任何工具。本任务允许以JSON计划代替线上发送工具；仅返回 {"items":[{"id":"案例id","action":"text|sticker|poke|finish|tool","text":"会发出的原话或空字符串","reason":"简短内部原因"}]}。任务需要工具时标tool并在reason说明；不假装已完成。可以沉默，不要求逢话必串。不输出评分，不宣布自己更好。';
  const data={split,condition_note:'Ablation: identical current base prompt; social arm adds only the social-continuity section. Not a full reconstruction of historical production.',
    cases:cases.map(c=>c.id),arms:{base:{system:baseline,task:offline+'\n'+JSON.stringify({cases})},social:{system:social,task:offline+'\n'+JSON.stringify({cases})}}};
  fs.writeFileSync(path.resolve(output),JSON.stringify(data,null,2));
  console.log(JSON.stringify({written:true,split,cases:cases.length,base_chars:baseline.length,social_chars:social.length,network:false}));
}
