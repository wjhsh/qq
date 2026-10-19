import {BiliHttpReader} from './bili-reader.mjs';
const reader=new BiliHttpReader();
try{
  const status=await reader.status();
  console.log(JSON.stringify({phase:'status',configured:status.configured,logged_in:status.logged_in}));
  const search=await reader.search('凑企鹅 高松灯');
  const first=search.results?.[0];
  console.log(JSON.stringify({phase:'search',count:search.results?.length||0,first:first?{bvid:first.bvid,title:first.title}:null}));
  if(first){
    const info=await reader.read(first.bvid);
    const comments=await reader.read(first.bvid,'comments');
    console.log(JSON.stringify({phase:'read',data_source:info.data_source,info_keys:Object.keys(info.video_info||info),comments_count:comments.comments?.length,comment_keys:Object.keys(comments.comments?.[0]||{})}));
  }
}catch(e){console.log(JSON.stringify({phase:'error',error:e.message}));process.exitCode=1;}finally{reader.close();}
