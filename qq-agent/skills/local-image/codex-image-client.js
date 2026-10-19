import fs from 'node:fs';
import { createHash } from 'node:crypto';

const failure = code => Object.assign(new Error(code), { code });
async function jsonResponse(response, limit = 20 * 1024 * 1024) {
  if (!response.ok&&[401,403,429].includes(response.status)) { await response.body?.cancel(); throw failure(response.status===429 ? 'quota' : 'auth'); }
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw failure('too_large');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try { for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>limit){await reader.cancel();throw failure('too_large');}chunks.push(Buffer.from(value));}
  } finally {reader.releaseLock();}
  let result;try {result=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw failure('invalid_response');}
  if(!response.ok||result?.ok!==true || !result.data)throw failure(result?.code==='reference_image'?'reference_image':'unavailable');return result.data;
}

export function createCodexImageClient({fetchImpl=globalThis.fetch,engine='codex',
  readToken=()=>fs.readFileSync('/etc/qq-harness/qq-token','utf8').trim(),
  baseUrl='http://127.0.0.1:3211',timeoutMs=240000,queueTimeoutMs=30000,pollMs=2000,
  now=Date.now,sleep=(ms,signal)=>new Promise((resolve,reject)=>{
    const onAbort=()=>{clearTimeout(timer);reject(failure('aborted'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  })}={}) {
  const endpoint=new URL(baseUrl);
  if(!['codex','chatgpt'].includes(engine))throw Error('Unsupported image engine');
  if(!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)
    ||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!['','/'].includes(endpoint.pathname))throw Error('Image broker must be loopback');
  return async({prompt,inputImages=[],aspectRatio='1:1',requestKey,imageSessionKey,signal}={})=>{
    if(signal?.aborted)throw failure('aborted');
    if(typeof prompt!=='string'||!prompt.trim()||Array.from(prompt).length>2000||!['1:1','16:9','9:16','4:3','3:4'].includes(aspectRatio)
      ||typeof requestKey!=='string'||!requestKey||requestKey.length>300)throw failure('invalid_response');
    if(imageSessionKey!==undefined&&(engine!=='chatgpt'||typeof imageSessionKey!=='string'||!/^[a-f0-9]{32}$/.test(imageSessionKey)))throw failure('invalid_response');
    if(!Array.isArray(inputImages)||inputImages.length>4)throw failure('reference_image');
    let inputBytes=0;
    const inputs=inputImages.map(image=>{
      if(engine!=='chatgpt'||!Buffer.isBuffer(image?.buffer)||!image.buffer.length||image.buffer.length>5*1024*1024||!['image/png','image/jpeg','image/webp'].includes(image.mime))throw failure('reference_image');
      inputBytes+=image.buffer.length;if(inputBytes>8*1024*1024)throw failure('reference_image');
      return {mime:image.mime,base64:image.buffer.toString('base64'),sha256:createHash('sha256').update(image.buffer).digest('hex')};
    });
    let token;try{token=String(await readToken()).trim();}catch{throw failure('auth');}
    if(!token||token.length>4096||/[\r\n]/.test(token))throw failure('auth');
    const controller=new AbortController();let job,terminal=false,timedOut=false;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    const request=async(path,body,requestSignal=controller.signal)=>jsonResponse(await fetchImpl(new URL(path,endpoint),{
      method:body===undefined?'GET':'POST',redirect:'error',signal:requestSignal,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    try{
      const description=engine==='chatgpt'?prompt.trim():`生成一张图片，画面比例${aspectRatio}。用户的图片描述：${prompt.trim()}`;
      job=await request('/jobs',{prompt:description,engine,mode:'image',...(inputs.length?{input_images:inputs}:{}),...(imageSessionKey?{image_session_key:imageSessionKey}:{}),request_id:createHash('sha256').update((engine==='chatgpt'?'chat-image:':'gpt-image:')+requestKey).digest('hex').slice(0,32)});
      if(!/^[a-f0-9]{12}$/.test(job.id))throw failure('invalid_response');
      const started=now();
      for(;;){
        if(controller.signal.aborted)throw failure('aborted');
        if(job.status==='succeeded'){
          terminal=true;
          if(!Array.isArray(job.files)||!job.files.some(f=>f.name==='gpt-image.png'))throw failure('no_image');
          const file=await request(`/jobs/${job.id}/file?name=gpt-image.png`);
          const encoded=file.base64;
          if(typeof encoded!=='string'||encoded.length>Math.ceil(10*1024*1024/3)*4+4
            ||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw failure('invalid_image');
          return {buffer:Buffer.from(encoded,'base64'),mime:'image/png',model:engine==='chatgpt'?'chatgpt-chat-image':'gpt-image-2',jobId:job.id};
        }
        if(['failed','cancelled','interrupted'].includes(job.status)){
          terminal=true;throw failure(['verification_required','auth','quota','timeout','no_image','blocked','busy','conversation_pending','reference_image'].includes(job.error_code)?job.error_code:/quota|rate.?limit|usage.?limit|额度|限流/i.test(job.error||'')?'quota':
            ['image_no_output','image_ambiguous_output'].includes(job.error_code)?'no_image':'unavailable');
        }
        if(job.status==='queued'&&now()-started>queueTimeoutMs)throw failure('busy');
        await sleep(pollMs,controller.signal);job=await request('/jobs/'+job.id);
      }
    }catch(error){
      const normalized=signal?.aborted?failure('aborted'):timedOut?failure('timeout'):error;
      if(/^[a-f0-9]{12}$/.test(job?.id||'')&&normalized instanceof Error)normalized.jobId=job.id;
      throw normalized;
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(/^[a-f0-9]{12}$/.test(job?.id||'')&&!terminal){try{await request('/jobs/'+job.id+'/cancel',{},AbortSignal.timeout(5000));}catch{}}
    }
  };
}
