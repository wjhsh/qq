import {parseBvid} from './bili-reader.mjs';
const short=(value,max)=>String(value??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').slice(0,max);
export function biliView(value,part='info'){
  if(part==='search')return{query:short(value.query,100),results:(value.results||[]).slice(0,5).map(r=>({bvid:parseBvid(r.bvid),title:short(r.title,160),author:short(r.author,80),description:short(r.description,500),source_url:'https://www.bilibili.com/video/'+parseBvid(r.bvid)}))};
  if(part==='status')return{configured:value.configured===true,logged_in:value.logged_in===true};
  if(part==='comments')return{comments:(value.comments||[]).slice(0,10).map(c=>({content:short(c.content??c.message??c.text,600),
    ...Object.fromEntries(['id','parent','root'].flatMap(k=>{const v=String(c[k]??(k==='id'?(c.rpid_str??c.rpid):'')??'');return /^\d{1,24}$/.test(v)?[[k,v]]:[];}))}))};
  const video=value.video_info||value;
  return{data_source:short(value.data_source||'metadata',32),title:short(video.title,160),description:short(video.description??video.desc,2000),subtitle_text:short(video.subtitle_text,12000)};
}
export function sourceText(info,comments){
  // Collection uses the exact same bounded evidence passed to the extractor.
  return [info.title,info.description,info.subtitle_text,...(comments?.comments||[]).map(c=>c.content)].filter(Boolean).join('\n').slice(0,18000);
}
export function sourceRecords(info,comments){
  return [{type:'title',locator:'title',text:info.title},{type:'description',locator:'description',text:info.description},
    {type:info.data_source||'subtitle',locator:'subtitle-no-timestamps',text:info.subtitle_text},
    ...(comments?.comments||[]).map((c,i)=>({type:'comment',locator:'comment:'+(c.id||'index-'+i)+(c.parent?':parent:'+c.parent:''),text:c.content}))]
    .filter(r=>typeof r.text==='string'&&r.text.trim()).map(r=>({...r,text:r.text.slice(0,12000)})).slice(0,13);
}
export function validateCandidates(value,evidence){
  if(!value||!Array.isArray(value.candidates)||value.candidates.length>3)throw Error('素材提取结果格式无效，未保存');
  return value.candidates.map(c=>{
      if(!c||Object.keys(c).some(k=>!['title','meaning','usage','evidence','provenance','mechanism','useWhen','stopWhen'].includes(k)))throw Error('素材提取字段无效，未保存');
    for(const[k,max]of [['title',32],['meaning',180],['usage',180],['evidence',600]]){
      if(typeof c[k]!=='string'||!c[k].trim()||Array.from(c[k]).length>max||/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(c[k]))throw Error('素材字段无效，未保存');
    }
    const texts=Array.isArray(evidence)?evidence.map(r=>r.text):[evidence];
    if(c.evidence.trim().length<2||!texts.some(t=>typeof t==='string'&&t.includes(c.evidence)))throw Error('素材缺少对应原文，未保存');
    return{...c,title:c.title.trim(),meaning:c.meaning.trim(),usage:c.usage.trim(),evidence:c.evidence};
  });
}
export function formatBili(value,part,bvid=''){
  if(part==='status')return`B站凭证：${value.configured?'已保存':'未配置'}\n登录：${value.logged_in?'有效':'未登录或已过期'}\n只读搜索、字幕/简介、评论；未启用本地转写。`;
  if(part==='search')return value.results.map(r=>`${r.title}\nUP：${r.author}\n${r.source_url}`).join('\n\n')||'没有找到候选视频。';
  if(part==='comments')return`视频 ${bvid} 的公开评论（网友言论，不代表事实）：\n`+(value.comments.map((c,i)=>`${i+1}. ${c.content}`).join('\n')||'暂无可读取的评论。');
  const label={subtitle:'已有字幕',ai_subtitle:'平台AI字幕',description:'仅视频简介',metadata:'视频元数据'}[value.data_source]||value.data_source;
  return`${value.title}\n来源：${label}\nhttps://www.bilibili.com/video/${bvid}\n${value.subtitle_text||value.description||'未提供可读取文本。'}`.slice(0,3500);
}
