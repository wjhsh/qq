# Google双账号手动选择

第二账号已按主人后续要求启用。账号1使用原始模型ID，账号2通过 `account2/` 前缀固定选择。现有网关启用 `routing.force-model-prefix`，不增加服务、端口或自动轮换。当时 QQ 保持账号1的3.5 Flash Lite；主人可随时自行切换。

## 使用

- `/账号 列表`、`/账号 当前`。
- `/账号 切换 2`、`/账号 切换 1`：保留基础模型，目标目录没有则拒绝。
- `/模型 列表`：列出两个账号的模型。
- `/模型 切换 账号2 Flash`：明确选择账号2的3.8 Flash High。

切换对全部QQ聊天生效，角色记忆保留。后台Lite任务及额度查询随QQ选中账号；独立Pi任务配置不改写。原始文字、真实QQ主人、白名单和屏蔽检查沿用既有入口。

## 目录与验证

两个账号当前各列出7个聊天模型：Gemini 3.8 Flash High、3.5 Flash Lite、3.1 Flash Lite、3 Flash；Claude Sonnet 4.6、Opus 4.6 Thinking；GPT-OSS 120B Medium（纯文本）。另列Gemini 3.1 Flash Image，未放入普通聊天菜单。目录可见不等于每个模型都已实测。

2026-10-20 17:57北京时间，生产8317网关按 `account2/gemini-3.8-flash-high` 完成真实文本及合成工具请求，分别3.587秒和3.022秒；返回 `gemini-3.8-flash-n` 是上游既有别名。每项仅一个HTTP请求，未实际执行QQ发送或任何模型工具动作。账号命令使用生产模块及实时目录、模拟配置提交器验证往返切换，没有改写生产聊天设置。

163项离线回归通过；独立审查修复了外部模型不能切账号却可能确认成功的边界。单并发与冷却仍按同一网关/密钥合并，切换账号不能清空保护。后台恢复与自动重试保持关闭。凭证文件权限0600，既有持久刷新机制保留；不记录邮箱、令牌、项目编号或群聊正文。

部署备份：`/var/backups/qq-harness/manual-accounts-20261020T175538`。证据位于服务器 `incident-20261020/manual-account-deployment.json`、`manual-account-live-verification.json`、`manual-account-final-health.json`。该轮改动当时未推送，随 2026-10-21 发布一起入库；最新运行选择见当日报告。
