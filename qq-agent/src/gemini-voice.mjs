import {createHash} from 'node:crypto';
import {ProxyAgent} from 'undici';

const ENDPOINT='https://generativelanguage.googleapis.com/v1beta/interactions';
const STYLES={normal:'Natural conversational Mandarin.',warm:'Warm and gentle, conversational Mandarin.',playful:'Playful and lightly teasing, natural Mandarin; no exaggerated performance.',soft:'Soft and slightly shy, natural Mandarin.',proud:'A little proud but affectionate, natural Mandarin.'};
const MODEL=/^gemini-3\.8-flash(?:-lite)?-tts$/;
const error=code=>Object.assign(new Error(code),{code});
const MAX_RESPONSE=4*1024*1024,MAX_AUDIO=2*1024*1024;
async function boundedJson(response){
  if(!response.body?.getReader)throw error('VOICE_INVALID_RESPONSE');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{while(true){const{done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_RESPONSE)throw error('VOICE_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('VOICE_INVALID_RESPONSE');}
}
export function audioFromInteraction(data){
  if(data?.status&&data.status!=='completed')throw error('VOICE_NOT_COMPLETED');
  const blocks=(data?.steps||[]).filter(s=>s.type==='model_output').flatMap(s=>s.content||[]).filter(c=>c.type==='audio');
  if(blocks.length!==1)throw error('VOICE_EXPECTED_ONE_AUDIO');
  const block=blocks[0],mime=block.mime_type||'audio/wav',text=block.data;
  if(mime!=='audio/wav'||typeof text!=='string'||text.length>Math.ceil(MAX_AUDIO/3)*4||!text.length
    ||text.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw error('VOICE_INVALID_AUDIO');
  const bytes=Buffer.from(text,'base64');
  if(bytes.length<44||bytes.length>MAX_AUDIO||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw error('VOICE_INVALID_WAV');
  return{bytes,mime};
}
export class GeminiVoice{
  constructor({getConfig,fetchImpl=globalThis.fetch,env=process.env,now=Date.now}){
    Object.assign(this,{getConfig,fetchImpl,env,now});this.busy=false;this.attempts=[];this.lastByChat=new Map();
  }
  available(){const c=this.getConfig().voice||{},name=c.apiKeyEnv||'GEMINI_TTS_API_KEY';return c.enabled===true&&/^[A-Z][A-Z0-9_]{0,80}$/.test(name)&&Boolean(this.env[name])&&MODEL.test(c.model||'');}
  async synthesize({chatKey,text,style='normal',signal}){
    const c=this.getConfig().voice||{};
    if(!this.available())throw error('VOICE_NOT_CONFIGURED');
    if(!/^(group|private):[1-9]\d{0,14}$/.test(String(chatKey))||typeof text!=='string'||!text.trim()||Array.from(text).length>300||/[\u0000-\u0008\u000b-\u001f]/u.test(text))throw error('VOICE_INVALID_TEXT');
    if(!Object.hasOwn(STYLES,style)||!/^([A-Za-z]{2,32}|voice_[A-Za-z0-9_-]{1,100})$/.test(c.voice||''))throw error('VOICE_INVALID_STYLE');
    const now=this.now(),last=this.lastByChat.get(chatKey);
    this.attempts=this.attempts.filter(t=>now-t<86400000);
    if(this.busy||this.attempts.length>=20||(last!=null&&now-last<60000))throw error('VOICE_BUSY_OR_LIMITED');
    signal?.throwIfAborted();
    this.busy=true;this.attempts.push(now);this.lastByChat.set(chatKey,now);
    for(const[k,t]of this.lastByChat)if(now-t>=86400000)this.lastByChat.delete(k);
    const abort=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
    try{
      const proxy=this.env.QQ_AGENT_SPEECH_PROXY||this.env.HTTPS_PROXY||this.env.https_proxy;
      if(proxy&&!this.dispatcher){const url=new URL(proxy);if(!['http:','https:'].includes(url.protocol))throw error('VOICE_INVALID_PROXY');this.dispatcher=new ProxyAgent(proxy);}
      const response=await this.fetchImpl(ENDPOINT,{method:'POST',redirect:'error',signal:abort,...(this.dispatcher?{dispatcher:this.dispatcher}:{}),headers:{'Content-Type':'application/json','x-goog-api-key':this.env[c.apiKeyEnv||'GEMINI_TTS_API_KEY']},
        body:JSON.stringify({model:c.model,input:[{type:'user_input',content:[{type:'text',text,annotations:[{type:'speech_metadata',style:STYLES[style]}]}]}],
          response_format:{type:'audio',mime_type:'audio/wav'},generation_config:{speech_config:[{voice:c.voice}]}})});
      if(!response.ok)throw error('VOICE_HTTP_'+response.status);
      const data=await boundedJson(response),audio=audioFromInteraction(data);abort.throwIfAborted();
      return{...audio,usage:data.usage_metadata||null,dedupeKey:createHash('sha256').update(c.model+'\n'+c.voice+'\n'+text).digest('hex')};
    }catch(e){if(e?.name==='AbortError'||e?.name==='TimeoutError'||signal?.aborted)throw error('VOICE_CANCELLED_OR_TIMEOUT');if(e?.code?.startsWith('VOICE_'))throw e;throw error('VOICE_TRANSPORT_FAILED');}
    finally{this.busy=false;}
  }
  async close(){await this.dispatcher?.close();this.dispatcher=null;}
}

export function registerVoiceTool(registerTool,{getConfig}){
  registerTool({id:'send_voice',name:'生成并发送语音',category:'messaging',voiceProvider:'gemini',
    description:'用已配置的Gemini TTS把text原文念成一条QQ语音，可用normal/warm/playful/soft/proud语气。默认仅在当前发言者明确要求语音时使用；不改写原文，不另用聊天模型扩写。仅当前会话，失败不自动重试。',
    parameters:{type:'object',additionalProperties:false,properties:{text:{type:'string',maxLength:300},style:{type:'string',enum:Object.keys(STYLES)},finishAfterSend:{type:'boolean'}},required:['text']},
    async execute(ctx,args){
      try{
        if(!ctx.voice?.available())throw error('VOICE_NOT_CONFIGURED');
        const requested=ctx.triggerEntries.some(e=>(ctx.kind==='private'||e.atMe===true)&&typeof e.directText==='string'
          &&/语音|朗读|念出来|读出来|说出来|说一句|喵一声/u.test(e.directText)&&!/(?:不要|别).{0,4}(?:语音|朗读|念|读|说)/u.test(e.directText));
        if(getConfig().voice?.allowSpontaneous!==true&&!requested)throw error('VOICE_NOT_REQUESTED');
        if(ctx.voiceAttempted)throw error('VOICE_ALREADY_ATTEMPTED');
        ctx.voiceAttempted=true;
        const capability=await ctx.onebot.call('can_send_record',{});
        if(capability?.yes!==true)throw error('VOICE_TRANSPORT_UNSUPPORTED');
        const audio=await ctx.voice.synthesize({chatKey:ctx.chatKey,text:args.text,style:args.style||'normal',signal:ctx.signal});
        ctx.signal?.throwIfAborted();
        const receipt=await ctx.sender.sendMedia(ctx.chatKey,[{type:'record',data:{file:'base64://'+audio.bytes.toString('base64')}}],{label:'[语音]',dedupeKey:audio.dedupeKey});
        if(!/^-?[1-9]\d*$/.test(String(receipt?.message_id??'')))throw error('VOICE_DELIVERY_UNCONFIRMED');
        ctx.session.sent.push({type:'voice',text:'[语音]',messageId:receipt.message_id});
        return{content:[{type:'text',text:JSON.stringify({sent:true,messageId:receipt.message_id})}],isError:false};
      }catch(e){return{content:[{type:'text',text:JSON.stringify({sent:false,error:e?.code?.startsWith('VOICE_')?e.code:'VOICE_FAILED',retry:false})}],isError:true};}
    }
  });
}
