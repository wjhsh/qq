import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';

const READ_TOOLS=new Set(['check_bilibili_credentials','search_bilibili_videos','get_video_info','get_video_comments','get_video_metadata']);
const BV=/^BV[0-9A-Za-z]{10}$/;
export function parseBvid(value){
  const text=String(value||'').trim();if(BV.test(text))return text;
  try{const url=new URL(text);if(url.protocol==='https:'&&['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(url.hostname)&&!url.username&&!url.password&&!url.port){const id=/^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname)?.[1];if(id)return id;}}catch{}
  throw Error('请提供 BV 号或标准 B站视频链接；暂不解析短链接。');
}
export function unpackMcp(result){
  let value=result?.structuredContent;
  if(!value){const text=(result?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');try{value=JSON.parse(text);}catch{value={text:text.slice(0,20000)};}}
  if(result?.isError||value?.error){
    const code=String(value?.code||'BILI_READ_ERROR').slice(0,64);
    const auth=value?.category==='credentials'||/COOKIE_EXPIRED|CREDENTIALS|NOT_LOGGED/.test(code);
    const error=Error(auth?'B站尚未登录或授权已过期，请由主人完成授权。':`B站读取暂未成功（${code}），设置未改变。`);
    error.code=code;throw error;
  }
  return value;
}

export class BiliReader{
  constructor({spawnImpl=spawn,command='/usr/sbin/runuser',args=['-u','qq-bili','--','/usr/local/bin/node','--max-old-space-size=128','/opt/codex-qq/bilibili/node_modules/@xzxzzx/bilibili-mcp/dist/index.js'],
    credentialFile='/var/lib/qq-bili/.bilibili-mcp/config.json',timeoutMs=40000}={}){
    Object.assign(this,{spawnImpl,command,args,credentialFile,timeoutMs});this.child=null;this.pending=new Map();this.sequence=0;this.tail=Promise.resolve();this.idle=null;this.stamp=null;this.queued=0;
  }
  close(){
    if(this.idle)clearTimeout(this.idle);this.idle=null;
    const child=this.child;this.child=null;if(child){try{child.kill('SIGTERM');}catch{}}
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('B站读取连接已结束'));}this.pending.clear();
  }
  async start(){
    const stamp=fs.existsSync(this.credentialFile)?fs.statSync(this.credentialFile).mtimeMs:0;
    if(this.child&&this.stamp===stamp)return;
    this.close();this.stamp=stamp;
    const child=this.spawnImpl(this.command,this.args,{cwd:'/opt/codex-qq/bilibili',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/var/lib/qq-bili',LANG:'C.UTF-8',
      BILIBILI_RATE_LIMIT_MS:'1200',BILIBILI_CACHE_SIZE:'20',BILIBILI_REQUEST_TIMEOUT_MS:'8000'},stdio:['pipe','pipe','pipe']});
    this.child=child;let buffer='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024*1024){this.close();return;}
      let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;
        let message;try{message=JSON.parse(line);}catch{this.close();return;}
        const entry=this.pending.get(message.id);if(!entry)continue;
        this.pending.delete(message.id);clearTimeout(entry.timer);
        if(message.error)entry.reject(Error('B站 MCP 协议请求失败'));else entry.resolve(message.result);
      }
    });
    // Upstream diagnostics can contain account metadata; do not relay stderr to QQ/model.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{if(this.child===child)this.close();});
    child.on('exit',()=>{if(this.child===child)this.close();});
    await this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'qq-readonly-bili',version:'1.0.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  }
  rpc(method,params){
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('B站读取超时，未自动重试'));this.close();},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');}catch{clearTimeout(timer);this.pending.delete(id);reject(Error('B站读取连接不可用'));}
    });
  }
  call(name,args={}){
    if(!READ_TOOLS.has(name))return Promise.reject(Error('B站工具不在只读白名单中'));
    if(this.queued>=4)return Promise.reject(Error('B站读取队列已满，请稍后再试'));
    this.queued++;
    const work=this.tail.then(async()=>{
      if(this.idle)clearTimeout(this.idle);
      await this.start();
      try{return unpackMcp(await this.rpc('tools/call',{name,arguments:args}));}
      finally{this.idle=setTimeout(()=>this.close(),60000);this.idle.unref?.();}
    });
    const result=work.finally(()=>{this.queued--;});
    this.tail=result.catch(()=>{});return result;
  }
  status(){return this.call('check_bilibili_credentials');}
  search(query){
    const clean=String(query||'').trim();if(!clean||clean.length>100)return Promise.reject(Error('B站关键词需为1至100字'));
    return this.call('search_bilibili_videos',{query:clean,limit:5});
  }
  read(input,part='info'){
    const bvid=parseBvid(input);
    if(part==='comments')return this.call('get_video_comments',{bvid_or_url:bvid,detail_level:'brief',limit:10,include_replies:false});
    if(part==='metadata')return this.call('get_video_metadata',{bvid_or_url:bvid});
    if(part!=='info')return Promise.reject(Error('未知的 B站读取类型'));
    return this.call('get_video_info',{bvid_or_url:bvid});
  }
}

// The QQ host is unprivileged. Only the separate qq-bili service owns cookies.
export class BiliHttpReader{
  constructor({requestImpl=http.request,readToken=()=>fs.readFileSync('/etc/qq-bili-reader/token','utf8').trim(),socketPath='/run/qq-bili-reader/bili.sock'}={}){
    Object.assign(this,{requestImpl,readToken,socketPath});this.active=new Set();
  }
  call(route,body={}){
    if(!['/status','/search','/read'].includes(route))return Promise.reject(Error('未知的B站只读请求'));
    if(this.active.size>=4)return Promise.reject(Error('B站读取队列已满，请稍后再试'));
    return new Promise((resolve,reject)=>{
      let token;try{token=this.readToken();}catch{return reject(Error('B站只读服务尚未配置'));}
      const payload=JSON.stringify(body);let size=0,done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);this.active.delete(request);if(error)reject(error);else resolve(value);};
      const request=this.requestImpl({socketPath:this.socketPath,path:route,method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},response=>{
        const chunks=[];
        response.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>256*1024){finish(Error('B站响应过大'));request.destroy();}else chunks.push(chunk);});
        response.on('error',()=>finish(Error('B站读取连接中断')));
        response.on('end',()=>{
          try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200||!value.ok)return finish(Error(typeof value.error==='string'?value.error.slice(0,250):'B站读取未完成'));finish(null,value.data);}
          catch{finish(Error('B站读取响应格式无效'));}
        });
      });
      const timer=setTimeout(()=>{finish(Error('B站读取超时，未自动重试'));request.destroy();},45000);
      this.active.add(request);request.on('error',()=>finish(Error('B站只读服务暂不可用')));request.end(payload);
    });
  }
  status(){return this.call('/status');}
  search(query){const clean=String(query||'').trim();if(!clean||clean.length>100)return Promise.reject(Error('B站关键词需为1至100字'));return this.call('/search',{query:clean});}
  read(value,part='info'){const bvid=parseBvid(value);if(!['info','comments','metadata'].includes(part))return Promise.reject(Error('未知的B站读取类型'));return this.call('/read',{bvid,part});}
  close(){for(const request of this.active)request.destroy();}
}
