# 第三轮：实验反证后再讨论

**支持与反对**：支持拆分。GPT根因成立但需限定：`socialRunOwner`的“单人兜底”服务于取消/归属，不等于互动对象；而“单人ambient=非互动”也过强——猫可对唯一环境发言自然接话，只是不该生成关系/状态暗示。故应拆“状态归属”与“表达焦点”。

**最强反例**：群里仅A说“今天好累”，无@猫。若把A定为互动对象，hint会暗示关系解读，模型易当情绪裁判；若一律判无焦点并禁言，又丢失自然插话。因此：归属=None，表达焦点=可空，环境闲聊仍允许常规回答。

此前我也赞成复用`socialRunOwner`，其不足在“batch owner”被直接借作“social focus”；不为附和认错，仍认为取消路径复用它是合理的。

**最小代码（≤20行，草案）**
```js
export function socialFocusOwner(runtime,chatKey,entries,store){
  if(!Array.isArray(entries))return null;
  const d=new Set(),cfg=runtime?.getConfig?.();
  for(const e of entries){
    if(!e||e.self||!uid(e.senderId)||!modelInputAllowed(e)
      ||e.automatedPeer===true||isAutomatedPeer(cfg,chatKey,e.senderId))continue;
    if(runtime?.directed(chatKey,e,store))d.add(String(e.senderId));
  }
  return d.size===1?[...d][0]:null;
}
// hint: const focus=socialFocusOwner(...); owner=socialRunOwner(...)仅作归属/feedback对照
// focus?`本批明确互动对象：QQ:${focus}。`: '本批无明确互动对象；可自然参与环境闲聊，但不推定关系或情绪。'
```
不应把`directed`内的`reply.mid→store.self`当“本次direct”；它是历史回复，无本轮@或原话证据时应只算弱线索，feedback仍须`directText`原文。这一点请另测。

**验收**：1）A独言无@→focus=null，ambient允许，hint无“唯一互动对象”；2）A@猫→focus=A，反馈可验证；3）A@B→非focus；4）两个direct→null；5）取消流程仍得A；6）D07不因环境发言自称互动对象。修复后须新盲测自然度，禁用已曝光留出与风格词重调。