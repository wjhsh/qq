# 部署交付报告：20261030-d8785e5-r2

## 结论与范围
本轮在用户明确批准后，将生产发布由 `20261030-ded8f08` 更新为 `20261030-d8785e5-r2`（源码提交 `d8785e5ba5406f36e804819dd6ff25126c45e0bb`）。机器验收 JSON 显示：发布、修订号与 12 个文件哈希全部一致，配置仅包含请求的补丁，API 配置与角色配置未变，备份目录及配置文件均为私有权限。本文由DeepSeek起草，GPT按真实验收记录复核并修正。

## 已发布能力与实际开关
依据 verification 阶段结果，当前实际生效项如下：

- `socialBehavior.enabled=true`；`allowDirectPeers=false`，保持已确认机器人的直接互聊例外关闭；既有机器人识别设置不变。
- `phase2.enabled=true`，含 `interactionTrace=true`、`humorKnowledge=true`、`retrieval=hybrid`。phase2 为 profile 全局配置，不是按群灰度。
- 语音：`voice_provider=edge`，语音技能 `local-voice` 处于 enabled/loaded/available，工具列表仅 `local-voice__send_voice`（`single_existing_voice_tool=true`）。Gemini TTS 本轮未实播。
- 服务：QQ 已连接，未暂停，活动运行数 0，启动致命错误 0，状态目录可写；服务 `ActiveState=active`、`SubState=running`、`NRestarts=0`。`MemoryCurrent=402464768` 字节为启动瞬时值，不能据此断言稳态内存无回归。
- 模型探针：`gemini-3.8-flash-n` 返回预期 pong，延迟 2546 ms，无响应错误。

## 测试与验证
- 本机 232 项离线回归与旧回放通过。
- 服务器 60 项预发布测试、19 项非 root 隔离事务测试通过。
- 首次预发布因漏打包 `cases.jsonl` 导致一项测试失败；补齐研究 fixture 后重跑全部通过。失败期间未改动生产。
- 12 文件哈希无冲突，API/角色配置未变，未覆盖私人记忆。

## 回滚方案
备份路径：`/var/lib/qq-deploy/backups/20261030-d8785e5-r2`。

回滚命令：
`python3 /var/lib/qq-deploy/staging/20261030-d8785e5-r2/deploy-transaction.py rollback /var/lib/qq-deploy/backups/20261030-d8785e5-r2`

执行回滚会短暂停服，须先暂停并排空。遇源码或受管配置冲突应停止，不覆盖私人记忆。旧备份不可覆盖是刻意保护；重试应使用新发布号，而非复用备份路径。

## 未完成项与后续观察
未覆盖角色卡、私人记忆、API 配置、机器人互聊设置。phase2 为全局 profile，未做按群灰度。`allowDirectPeers=false`、Edge 语音、Gemini TTS 未实播。尚无真人盲评结果；长期自然度、群聊反馈与内存表现需后续观察。

## 协作者审阅与分歧
- DeepSeek 指出 phase2 段可能覆盖未来自定义键；GPT 采纳，增加停服前拒绝未知键，以及缺失/null/已知旧开关的往返恢复。
- DeepSeek 称“配置写失败仍保留新源码”；GPT 依源码与测试否定：异常分支先逐文件还原旧源码，再还原配置。
- DeepSeek 建议覆盖旧备份以重试；未采纳，理由如上。
- Gemini 独立审阅返回 500，耗时 131.547 秒，费用未知，不计为通过，也不自动重试。
- 两者均通过本机 API 调用，无 QQ/Pi/云端中转。

## token 口径
前一开发阶段：Gemini 23 次 348896 token，DeepSeek 26 次 295675 token，合计 49 次 644571 token；DeepSeek 为 6.52 WorkBuddy credit（非美元）。
此次审阅：DeepSeek 1 次 10487 token、0.49 credit；Gemini 1 次失败、用量未知。
本次文档生成：DeepSeek 1次2149 token、0.15 credit。本次部署共2次DeepSeek成功调用，12636 token、0.64 credit；Gemini另有1次500失败，用量未知。加上此前开发，已知用量657207 token、DeepSeek合计7.16 credit，失败未知用量未按零计算。GPT/Codex 无同口径可靠 token 计数，不能比较，token 数也不代表质量。

## 额外验收与观察边界

实际生产源码配合现行social配置的隔离smoke：12张机制卡均可加载，示例召回2张已审卡；phase2提示和outcome工具schema可生成。无外部模型调用、未发QQ消息。这是线上文件/配置的合成加载测试，不等于群友真实反馈。

随后服务内存约329MiB，低于512MiB服务上限；NRestarts=0、开机自启。发布前单次约234MiB，启动后单次约384MiB，再观察约329MiB，采样负载/缓存不同，不能以这些点认定无回归或都是新机制导致。新增模块没有常驻服务、没有每消息新增模型调用。

首次发布后窗口尚无新真实聊天样本；旧state仍为7份关系、合法v1 JSON。群内已审梗库仍未生成，通用12卡与群梗不是同一个库。部署成功不能替代真人盲评。

关phase2可暂停轨迹/知识/混合检索，保留私人记忆；如需连焦点基础修复一起撤回，使用完整事务回滚。回滚前先暂停并排空，不调用备份中的旧配置覆盖整份现行配置。
