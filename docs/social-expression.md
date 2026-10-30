# 表达与引用上下文实验

本轮为默认关闭的开发候选，未部署、未修改生产角色卡或私人记忆。它延续已上线的phase2，解决“开关生效”和“实际更好聊”不是一回事的问题。实验数据与反例见reports/social-expression-20261030/。

## 两个独立开关

|选项|默认|实验值|行为|
|---|---|---|---|
|socialBehavior.phase2.expressionProfile|legacy|playful-v1|仅在明确group、social及phase2均启用、无管理员systemPromptOverride时，将六段重复风格规则替换为一段统一表达；安全、工具、角色、记忆和自然表达约定保留|
|socialBehavior.phase2.knowledgeContext|current|linked-v1|保留当前明确对象的正文优先；可补本次真实引用的同群、同完整角色版本、self父消息，最多2条/400字符，总查询≤600字符|

私聊、显式覆盖、开关关闭及未知profile对系统提示的四个发布版SHA256基准均保持一致。猫娘身份与原卡正文不改；其他角色也不能被强套猫身份。“草”不作为口癖的既有要求保留，允许自然互损并不等于强制粗口或永远赢。没有“逢骂必反击”的情绪关键词分类器。

表情包默认作为弱社交信号：文字和同轮交互比单张表情更能支持意图判断，不把生气脸当真实愤怒或同意的证据。可以回表情、短接或沉默；明确问画面或回答依赖细节时仍可读取真实图片。占位符、文件名、编号与没拿到的图片不是视觉事实。这个策略是表达引导，不是已经证明消灭所有视觉幻觉的过滤器；模拟中的海獭失败例保留。

## 链接与证据边界

DeepSeek起草查询模块，GPT修正并验证了原草案的输入过滤、撤回/媒体排除、mid去重、计数等问题。链接必须经store.findByMid(chatKey,mid)找到真实父消息，self=true、senderId=self、personaScope完整相等。缺scope、旧角色、撤回、模型排除、拍一拍或含媒体的父消息均不补充；不读取“[引用…]”字符串来伪造引用，不带任意环境历史或其他人的引用。

当前用户自己的typed正文优先完整保留到600字符，只有剩余空间够容纳父消息时才追加。无当前明确对象或无正文不检索。不降BM25门槛，不迁移事实记忆，不把检索父消息当socialFeedback quote或情绪事实。

session.socialKnowledge只记录有限的模式、原因、字符数、链接数、检索方法和offeredIds；offered表示提供给模型，不等于模型采用，更不等于对方觉得好笑。不保存原文或QQ号。关闭知识功能、无对象、空查询、无命中与读取失败可以区分。一次纯统计的mode修正发生在生成后，不改模型输入或输出。

## 评测与运维

复用原多轮工具宿主，expression模式使用发布版8829a7b的SocialRuntime作base，phase2保持开启，使用legacy/current；候选使用playful-v1/linked-v1。两臂同角色、同模型、同工具与温度，每轮下一次输入接前轮真实生成并执行后的模拟回执。不是全生产Orchestrator/真实QQ/真实视觉测试，也不是让模型一次写完双方对话。人类下一轮是预先固定脚本，不是活人的自适应反馈。

开发与留出各4个场景、每个3轮；场景在代码和生成前冻结。格式失败保留原响应和位置，向上传播失败，整段不参与自然度胜负；不会当沉默或自动重试。保存响应可以replay-only校验上下文哈希，补充只读观测时零新增模型请求。

```powershell
python tools/check.py
node tools/social-replay.mjs
python tools/evaluate-social-phase2.py --expression --endpoints <仓库外配置> --out <新的私有目录> --splits development,holdout
python tools/render-social-expression.py --run <私有评测目录> --out <报告目录>
```

examples/social-expression-development.json只供开发合并，不能整份覆盖生产config。当前生产事务的phase2固定profile只有原四键，并会拒绝未知自定义键；未来若批准上线本实验，须先扩展并测试受管新键、备份/冲突与精确回滚，不能绕过保护直接写开关。当前无按群灰度实现；不能把profile全局开关说成已有按群灰度。

Pi/Harness继续承担隔离操作任务；改换聊天框架不会自动修复提示、召回或幽默品味。现有Harness源码设有qq-harness用户、只读系统、工作区写权限、512MiB/75%CPU/48任务/600秒上限，但源码配置不等于本轮已启动任务验证。代理变量和RestrictAddressFamilies也不等于网络目标白名单。进一步限制应由宿主和操作系统实施，普通聊天无需重复建设一套Agent运行时。
