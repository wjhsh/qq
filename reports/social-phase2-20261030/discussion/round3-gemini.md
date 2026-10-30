# 第三轮：实验反证后再讨论

### 一、支持与反思

**明确支持拆分**。此前赞成复用 `socialRunOwner` 存在定势缺陷：混淆了**任务批归属**（单人连发是否算同一任务流以决定中止/防抖）与**语用对话焦点**（当前是否在与该人进行1对1对齐）。群聊中单人单条 ambient 仅仅是“无竞争发言”，绝非“在与你对话”。复用导致单条自言自语被误标为 `唯一互动对象`，直接迫使模型带入“被呼叫的答复者/居委会裁判”姿态，是 H07/H11 出现“主持人腔”和自任裁判的关键诱因。

### 二、独立质疑与最强反例

*GPT根因判断方向正确，但仍需提防边界特例*：
**最强反例（上下文隐式交互）**：用户被猫咬/互动后紧接着单独发了一句“笨猫别跑”（未@、未引用），在纯结构判定中它属于 ambient。若强行赋予焦点，易引发过度反应；若无焦点，模型虽仍能作为群宠插嘴，但无法调用该用户的 `SocialState`（如傲娇/好感度记录）。
**结论**：该代价完全可接受。宁可在此类隐式模糊回合退回“无偏见普通闲聊”，也绝不能把群友日常自言自语（如“今天这破代码又崩了”）升格为与猫的定向会话。

### 三、最小修复代码（不超过20行）

在 `SocialRuntime` 的 `hint` 与 `knowledgeHint` 中改用仅限 direct 的 `socialFocusOwner`，原 `socialRunOwner` 留给任务流逻辑：

```javascript
export function socialFocusOwner(runtime, chatKey, entries, store) {
  if (!Array.isArray(entries)) return null;
  const direct = new Set(), cfg = runtime?.getConfig?.();
  for (const e of entries) {
    if (!e || e.self || !uid(e.senderId) || !modelInputAllowed(e)
      || e.automatedPeer === true || isAutomatedPeer(cfg, chatKey, e.senderId)) continue;
    if (runtime?.directed(chatKey, e, store)) direct.add(String(e.senderId));
  }
  return direct.size === 1 ? [...direct][0] : null;
}
// hint/knowledgeHint 内部替换：
// const owner = socialFocusOwner(this, chatKey, entries, store);
```

### 四、如何保持自然闲聊？

1. **准入不收缩**：`admit` 保持不变，单条 ambient 依旧放行（`reason: 'ambient'`），允许进模型。
2. **语境去中心化**：无 direct 时输出“本批无唯一互动对象”，不注入任何个人情绪状态卡与机制检索，避免模型产生“对方在找我/必须解决问题”的负担。
3. **保留群宠底色**：仅靠通用提示（猫耳/尾巴、接具体细节、可发表情/拍一拍/finish）驱动，让模型以“在场群友”而非“主控客服”身份自由决定是抓细节喵一声、丢表情还是保持沉默（finish）。

### 五、盲测验收方案

1. **单元断言**：单条群聊无@无引用的文本输入，`socialFocusOwner` 严格返回 `null`，而 `socialRunOwner` 仍返回原 speaker ID。
2. **冻结留出盲测**：不可对 H07/H11 打补丁式重调 prompt。提取全新的 30 组未见脱敏环境闲聊样本（单人碎碎念、双人互损），同模型新旧版本双盲评估，统计“居高临下评判/劝架”率与“作为群宠自然接话/沉默”率，以新盲测胜率作为交付基准。