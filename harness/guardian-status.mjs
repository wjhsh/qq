import fs from 'node:fs';
const labels={online:'在线',risk_device_blocked:'QQ判定风险设备，已暂停自动登录',forced_offline_review_required:'QQ被强制下线，自动重登已暂停等待排查',credentials_required:'登录态失效，等待密码凭证',captcha_required:'等待QQ验证码',device_confirmation_required:'等待手机确认设备',password_rejected:'密码登录被拒绝，等待更新凭证',password_login_pending:'正在尝试密码登录',quick_login_pending:'正在尝试快速登录',login_in_progress:'正在登录',onebot_disconnected:'QQ已登录，机器人连接待恢复',native_unreachable:'QQ登录服务待恢复',native_checking:'正在检查QQ登录服务',maintenance_paused:'维护暂停'};
Object.assign(labels,{official_qq_trial:'官方QQ对照测试中，机器人暂未接入',transport_maintenance:'接入层维护中，QQ恢复暂停',protocol_attach_pending:'QQ接入层正在恢复'});
export function guardianSummary(file='/var/lib/qq-guardian/status.json',now=Date.now()){
  try{
    const status=JSON.parse(fs.readFileSync(file,'utf8')),at=Date.parse(status.checked_at);
    if(!Number.isFinite(at)||now-at>180000)return'\n自动恢复：巡检记录已过期，需要检查服务。';
    const observation=status.qq_observation;
    const history=observation?`\n连续巡检在线：${Math.floor(observation.continuous_online_seconds/60)}分钟；记录断开${observation.interruptions}次`:'';
    return`\nQQ实际登录：${labels[status.qq]||'待检查'}${history}\n自动恢复：服务器每轮结束30秒后巡检${status.auth_recovery_paused?'；QQ自动重登暂停观察':''}\n密码凭证：${status.credential_configured?'已配置':'未配置'}\n代理检查：${{healthy:'正常',checking:'检查中',repair_scheduled:'已安排自动切线',outbound_unavailable:'出口不可用',local_proxy_unavailable:'本地代理待恢复',maintenance_paused:'维护暂停'}[status.proxy]||'待检查'}`;
  }catch{return'\n自动恢复：暂未读取到巡检结果。';}
}
