# WorkBuddy → 服务器 Pi

此渠道已部署并通过真实文本、流式函数调用以及 Pi 写入/读取文件的验证。手机工作台选择“Pi · DeepSeek V4.1 Flash · WorkBuddy 积分”即可提交任务；任务、反代和授权均在服务器上运行。

## 实际部署

| 项目 | 配置 |
|---|---|
| 服务 | `qq-workbuddy.service`，开机自启 |
| API | `http://127.0.0.1:8788/v1`，要求独立密钥 |
| Harness 引擎 | `pi-workbuddy` |
| 模型 | `deepseek-v4.1-flash` |
| 网关代码 | `/opt/codex-qq/workbuddy/` |
| 账号与刷新状态 | `/var/lib/qq-workbuddy/accounts/`，独立用户、文件权限 0600 |
| 网关前端密钥 | `/etc/qq-workbuddy/service.env` 的 `WB_PROXY_KEY` |
| Pi 前端密钥 | `/etc/qq-harness/workbuddy.env` 的 `WORKBUDDY_API_KEY`，与上项配套 |
| 网关上限 | 192 MiB 内存、64 MiB 交换、30% CPU、单请求并发 |
| Pi 任务上限 | 保留原来的 512 MiB、单任务队列及 10 分钟时限 |

上游本次返回 18 个模型目录条目，当前只启用了经过验证的 DeepSeek Pi 选项。目录可见不证明全部模型可调用。用量由 WorkBuddy 的积分或配额规则决定，Pi 模型元数据中的零价格不是“腾讯免费”或实际计费结果。

## 固定源码与本地变更

上游固定为 `ardeyouxipianyi/workbuddy2api-hub@59e9ee21cd2819ee044cad65adc34df148d3c6de`。`ops/workbuddy/upstream-lock.json` 保存部署后 28 个文件的 SHA-256；包含 API 包装器和上游许可证。`hardening.patch` 记录了对上游 403 内容拒绝的处理：直接传回拒绝，删除改写系统提示词后重试的分支。

`guarded_gateway.py` 仅开放健康、模型目录、余额摘要和 Chat Completions 路由，关闭管理面板、桌面凭证扫描、产品身份切换、本地网页工具、签到/奖励/活跃上报、额度探针及后台价格/更新查询。令牌按实际请求需要刷新；没有后台生成测试对话。

可以将固定运行源码准备到一个新目录：

```sh
python tools/prepare-workbuddy.py --destination /tmp/workbuddy-runtime-check
```

若已有上游检出，可离线使用：

```sh
python tools/prepare-workbuddy.py --upstream /path/to/workbuddy2api-hub --destination /tmp/workbuddy-runtime-check
WORKBUDDY_RUNTIME=/tmp/workbuddy-runtime-check python tests/test-workbuddy-policy.py
```

准备脚本仅下载/读取固定源码、应用本地补丁并验证哈希，不导入账号、不安装服务、不修改现有目录。完整账号授权过程留在部署环境中；本仓库不保存登录状态、回调链接、访问令牌或刷新令牌。

`ops/workbuddy/qq-workbuddy.service` 是当前服务边界的源码记录，依赖既有目录、独立 `qq-workbuddy` 用户、私有环境文件及授权文件，不能只复制单元文件就视为部署完成。

## 维护

日常可只读检查服务状态、`/health` 和 Harness 返回的任务结果。异常时区分账号授权、模型限流、网络和 Pi 工具失败，不通过自动切账号或改写被拒绝内容重试。

源码维护仍走副本与差异审核。回滚本次接入需先确认任务队列空闲，再恢复部署前的 `harness/harness.py` 和手机工作台页面，并重新载入 Harness；普通 QQ 客户端登录独立于此渠道。凭证恢复使用私有备份，不能从公开 Git 仓库恢复令牌。
