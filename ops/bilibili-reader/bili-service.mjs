import fs from 'node:fs';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {BiliReader} from './bili-reader.mjs';
import {biliView} from './bili-view.mjs';
const token=fs.readFileSync('/etc/qq-bili-reader/token','utf8').trim();
if(token.length<32)throw Error('Missing Bili service token');
const socket='/run/qq-bili-reader/bili.sock';
const reader=new BiliReader({command:'/usr/local/bin/node',args:['--max-old-space-size=128','/opt/codex-qq/bilibili/node_modules/@xzxzzx/bilibili-mcp/dist/index.js']});
function authorized(value){const a=Buffer.from(String(value||'')),b=Buffer.from('Bearer '+token);return a.length===b.length&&timingSafeEqual(a,b);}
function respond(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
const server=http.createServer(async(req,res)=>{
  if(!authorized(req.headers.authorization))return respond(res,403,{ok:false,error:'B站只读服务未授权'});
  if(req.method!=='POST'||!['/status','/search','/read'].includes(req.url))return respond(res,404,{ok:false,error:'未知的B站只读请求'});
  let size=0;const chunks=[];
  try{
    for await(const chunk of req){size+=chunk.length;if(size>4096)return respond(res,413,{ok:false,error:'请求过长'});chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');let data;
    if(req.url==='/status')data=biliView(await reader.status(),'status');
    else if(req.url==='/search')data=biliView(await reader.search(body.query),'search');
    else {const part=body.part||'info';data=biliView(await reader.read(body.bvid,part),part);}
    respond(res,200,{ok:true,data});
  }catch(error){respond(res,400,{ok:false,error:String(error.message||'B站读取未完成').slice(0,250)});}
});
server.requestTimeout=10000;server.headersTimeout=10000;
if(fs.existsSync(socket))fs.unlinkSync(socket);
server.listen(socket,()=>{fs.chmodSync(socket,0o666);console.log('Bili read-only service ready');});
function stop(){reader.close();server.close(()=>process.exit(0));}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
