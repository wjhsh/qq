import { safeFetchBinary, validateImageUrl } from '../../src/safe-fetch.js';
import { detectImageType } from '../../src/image-type.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
export const MAX_INPUT_IMAGES=4;
export const MAX_INPUT_IMAGE_BYTES=5*1024*1024;
export const MAX_TOTAL_INPUT_BYTES=8*1024*1024;
const fail=()=>{throw Object.assign(Error('reference_image'),{code:'reference_image'});};
const images=entry=>(Array.isArray(entry?.directImageMedia)?entry.directImageMedia:Array.isArray(entry?.media)?entry.media:[]).filter(m=>m?.kind==='image');
const present=entry=>entry&&!entry.recalled&&!entry.withdrawn&&!entry.deleted;

function splitMessageImage(ctx,entry){
 // QQ may split one composer submission into image then @+text events.
 // Bind only the immediate preceding local message, same sender, within 5s.
 // Never search arbitrary history or substitute somebody else's image.
 if(!Number.isSafeInteger(entry?.id)||!Number.isFinite(entry?.ts)||typeof ctx?.store?.recent!=='function')return null;
 const recent=ctx.store.recent(ctx.chatKey,{limit:64});
 const index=recent.findIndex(row=>row.id===entry.id&&String(row.mid)===String(entry.mid));const previous=recent[index-1];
 if(index<1||!present(previous)||previous.self||previous.peerDirected||previous.id!==entry.id-1
  ||String(previous.senderId)!==String(entry.senderId)||!Number.isFinite(previous.ts)||entry.ts<previous.ts||entry.ts-previous.ts>5000
  ||typeof previous.directText!=='string'||previous.directText.trim()||previous.reply
  ||!Array.isArray(previous.directImageMedia)||!previous.directImageMedia.length
  ||previous.directImageMedia.some(image=>image?.kind!=='image'))return null;
 return previous;
}

export function referenceEntries(ctx,entry){
 const entries=images(entry).length?[entry]:[];
 const mid=typeof entry?.reply==='object'?entry.reply?.mid:entry?.reply;
 if(mid!==null&&mid!==undefined&&/^-?[1-9]\d{0,19}$/.test(String(mid))){
  const quoted=typeof ctx?.store?.findByMid==='function'?ctx.store.findByMid(ctx.chatKey,mid):null;
  if(!present(quoted)||quoted===entry)entries.push({missingReference:true,mid});
  else if(images(quoted).length)entries.push(quoted);
  else if(quoted.self===true&&generatedCachePath(ctx,quoted))entries.push({...quoted,directImageMedia:[{kind:'image',cachedGenerated:true}]});
 }
 if(!entries.length&&(mid===null||mid===undefined)){
  const split=splitMessageImage(ctx,entry);if(split)entries.push(split);
 }
 return entries;
}

export function referencesStillPresent(ctx,entries){
 return entries.every(entry=>present(entry)&&present(entry.mid!==null&&entry.mid!==undefined&&typeof ctx?.store?.findByMid==='function'?ctx.store.findByMid(ctx.chatKey,entry.mid):entry));
}

function generatedCachePath(ctx,entry){
 try{
  if(entry?.mid===null||entry?.mid===undefined)return null;
  const ledgerFile=path.join(DATA_DIR,'image-generation-state.json');if(fs.statSync(ledgerFile).size>1024*1024)return null;
  const records=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));if(!Array.isArray(records))return null;
  const record=records.find(([key,row])=>String(key).startsWith(ctx.chatKey+':')&&row?.status==='sent'&&String(row.messageId)===String(entry.mid))?.[1];
  if(!record?.file||!path.isAbsolute(record.file))return null;
  const directory=fs.realpathSync(path.join(DATA_DIR,'generated-images'));const actual=fs.realpathSync(record.file);const relative=path.relative(directory,actual);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||fs.lstatSync(record.file).isSymbolicLink())return null;
  const stat=fs.statSync(actual);if(!stat.isFile()||!stat.size||stat.size>MAX_INPUT_IMAGE_BYTES)return null;
  return actual;
 }catch{return null;}
}

export function cachedGeneratedReference(ctx,entry){
 const file=generatedCachePath(ctx,entry);return file?fs.readFileSync(file):null;
}

export async function loadReferenceImages(ctx,entries,{fetchImage=safeFetchBinary,validateUrl=validateImageUrl,readCached=cachedGeneratedReference}={}){
 if(entries.some(entry=>entry.missingReference))fail();
 const media=entries.flatMap(entry=>images(entry).map(image=>({entry,image})));if(media.length>MAX_INPUT_IMAGES)fail();
 const result=[];let total=0;
 for(const {entry,image} of media){
  if(ctx?.signal?.aborted)throw Object.assign(Error('aborted'),{code:'aborted'});
  try{
   let buffer=null;let url=image.url;
   if(images(entry).length===1&&(entry.self===true||String(entry.senderId||'')===String(ctx?.selfId||'-')))buffer=await readCached(ctx,entry);
   if(!buffer&&!url&&image.file&&typeof ctx?.onebot?.call==='function')url=(await ctx.onebot.call('get_image',{file:String(image.file)}))?.url;
   if(!buffer){if(!url)fail();const safe=await validateUrl(url);buffer=(await fetchImage(safe,MAX_INPUT_IMAGE_BYTES)).buffer;}
   const type=detectImageType(buffer);
   if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_INPUT_IMAGE_BYTES||!['image/png','image/jpeg','image/webp'].includes(type?.mime))fail();
   total+=buffer.length;if(total>MAX_TOTAL_INPUT_BYTES)fail();
   result.push({buffer,mime:type.mime,sha256:createHash('sha256').update(buffer).digest('hex')});
  }catch(error){if(error?.code==='aborted')throw error;fail();}
 }
 return result;
}
