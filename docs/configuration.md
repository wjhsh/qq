# 配置与部署说明

QQ Agent 用 `QQ_AGENT_DATA_DIR` 指定私有数据目录，默认配置字段及合并规则以 `qq-agent/src/config.js` 为准。示例见 `qq-agent/config.example.json`；必须按自己的环境配置合法账号、白名单与模型渠道，示例值不能直接用于生产。

账号授权、API Key、QQ 接线令牌、控制台令牌分别保存在部署环境中。harness 使用本机令牌验证调用，图片任务读取独立保存的 Chat 授权；这些文件不属于源码仓库。不要提交实际 `config.json`、环境变量文件或授权文件。

入库版本已将旧源码里的 Google OAuth 客户端常量改为读取 `QQ_GOOGLE_OAUTH_CLIENT_ID`、`QQ_GOOGLE_OAUTH_CLIENT_SECRET`。需要刷新 Google 额度查询令牌时，应由部署环境提供这两个值；未提供时返回配置缺失，不提交空参数的刷新请求。示例见 `.env.example`。这项发布脱敏没有修改现有服务器文件，日后部署仓库版本前须先配置。

已有生产部署把源码放在 `/opt/codex-qq/`，数据放在 `/var/lib/qq-agent` 和 `/var/lib/qq-harness`。仓库布局与这些路径的对应关系是 `qq-agent/` → `QQ-agent/`、`harness/` → `harness/`，配套服务见 `ops/`。现有代码还有部署路径约定，迁移前须逐项核对；本版本没有声称可在任意目录直接重建整机。

更新流程：检查源码版本和服务空闲状态 → 备份待改文件 → 运行离线回归 → 分阶段验证 → 应用已审差异 → 检查 QQ、模型任务与发送回执。只更新 Chat 图片工作进程时，下一项图片任务会读取新源码；无需为此重启 QQ 客户端。

生产配置、账号和记忆另做独立的加密备份。Git 记录源码与脱敏报告，不能替代凭证恢复或数据备份。

