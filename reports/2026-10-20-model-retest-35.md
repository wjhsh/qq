# 2026-10-20 15:04 模型重测与备用调整

管理员要求再次测试 3.8，并取消 3 Flash 兜底。生产配置已热更新，QQ 客户端及 QQ Agent 均未重启，角色、记忆和所有非 API 配置逐项保持。

## 实际响应

| 路由 | 模型 | 实际结果 |
| --- | --- | --- |
| 当前网关 | 3.8 Flash High | 等待 65.09 秒仍未收到 HTTP 状态码或响应正文，本地 TimeoutError |
| Google 原生 daily 生成接口 | 3.8 Flash Tiered（账号列表实际 ID） | 等待 25.23 秒未收到 HTTP 响应，本地 TimeoutError |
| 当前网关 | 3.6 Flash Medium | HTTP 400，model_not_found，unknown provider for model gemini-3.6-flash-medium |
| Google 原生 daily 生成接口 | 3.6 Flash Medium | HTTP 404 NOT_FOUND，Requested entity was not found. |
| 当前网关 | 3.5 Flash Lite | HTTP 200，0.999 秒，正确返回 health_ready 工具参数 |

3.6 Medium 在账号可见列表中出现，不代表当前生成接口可用。本轮没有拿到 3.8 的 Google 错误正文，不能把本地超时解释成确定的配额不足或容量错误。同一网关的 3.5 Lite 正常返回，表明代理与授权链没有整体失效；不能据此保证 3.8 自身链路正常。

## 已应用配置

- 当前主模型：gemini-3.5-flash-lite；请求思考模式 off，兼容层对该通道的 off 按 low 发送。
- 恢复首选：gemini-3.8-flash-high；每 120 秒探测，连续两次有效工具调用才切回。
- 恢复后的备用：gemini-3.5-flash-lite。主备配置均取消 gemini-3-flash；未接入新账号或付费提供商。
- 通过现有服务 API 保存并回读运行时配置，未直接修改文件绕过内存态。

配置应用后按正式客户端调用路径验证两次，分别为 1.620 秒、1.094 秒，均由 3.5 Flash Lite 正确返回工具参数，没有执行发送工具。最终 QQ 在线、运行和排队均为 0。没有向群或联系人发送测试消息；本轮没有推送 GitHub。
