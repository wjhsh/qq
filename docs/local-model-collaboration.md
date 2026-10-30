# Codex直接使用本机Gemini / DeepSeek协作者

本轮复用了已有的官方授权保存与代理实现：CLIProxyAPI 8.0.32、固定且加固的WorkBuddy API-only配置。新增的是可复用启动/调度入口，没有开发第三套反代。

Windows本机开发端口为 `127.0.0.1:18329/v1`（Gemini）和 `127.0.0.1:18788/v1`（DeepSeek V4.1 Flash）。它们是本机进程直连上游，与原云服务器网关/QQ/Pi分开；不开放到局域网。端口存在/授权文件存在都不等于调用成功，结果中须有真实model与usage。

在本项目工作根使用现有Python运行（路径通过参数指定，不把密钥写入命令）：

```powershell
work/workers-venv/Scripts/python.exe work/hajimi-evolution/tools/bootstrap-local-models.py --workspace .
work/workers-venv/Scripts/python.exe work/hajimi-evolution/tools/model-collaboration.py --endpoints work/social-phase2-private/local-endpoints.json --context reviewed-context.txt --task task.txt --out new-task-results
```

保存目录在仓库外的 `work/social-phase2-private/`。原授权继续以现有Windows DPAPI保存；本轮本机代理所需状态另做 `social-phase2-local.dpapi` 加密备份，文件夹已限定当前Windows用户和SYSTEM。OAuth代理工作文件是服务所需的私有明文，不能上传GitHub或传给辅助模型。运行进程与刷新状态保存后可供下一轮启动复用；失效时才需要重新授权，不能保证永不要求登录。

`model-collaboration.py` 对每个模型最多一个在途请求，两个模型可并行。只允许回环HTTP目标，禁止重定向/自动重试/失败切渠道/工具执行，结果固定写到协调者指定目录。原始用量与结果一并保存；源码上下文和任务有SHA256可追溯。工作者没有主工作区写权限；其补丁是待审文本。

这相当于Codex可直接调度的外部子代理工作流：Codex保留领队上下文，协作者独立给判断/实现，Codex合并、测试和验收。它们不是通过Codex原生spawn工具创建的进程型子代理，不应宣称拥有终端或自动改文件权限。仓库AGENTS.md给下次开发保留了路由与边界。

本机服务不是开机计划任务，本轮没有设置永久自启。电脑关机后这两个本机协作入口停止，云端QQ服务继续按原配置运行。再次开发先运行启动脚本，复用保存状态。

费用独立：Gemini用Google订阅渠道，DeepSeek用WorkBuddy回报的credit；都不从Codex Plus额度扣除。credit不是美元，未验证赠金/最终账单。发生超时但没有usage时用量未知，不按零消耗报告。
