# DeepSeek最终代码复核（待GPT核对的模型意见）

核查结论（未运行代码，仅静态证据；默认phase2关闭）：

**未见阻碍离线合并的正确性问题。** 逐块核对：

1. **BM25草案修正已落实**：`rankMechanisms` 对每篇文档独立算分，`df` 仅用于idf，`d.terms.length` 为单文档长度，不存在“语料总分给每卡”。`hits<2&&!cues` 门槛+`score>=2` 合理；`method==='lexical'` 与 hybrid 分路正确。`tokens`/`tokenize` 各自截断，无越界。

2. **MemeLibrary 可见性**：`_visible` 恒 true 只影响 admin/list/mark 的找回旧版本；`search` 先按 `same+status==='approved'+_searchable+未过期` 过滤，`_searchable` 执行 roleVersion 与 legacy 自动批准隔离——符合你的更正，非泄漏。`mark` 用 `_visible` 找旧版再显式 rebind（`roleVersion=ver, reviewedAt=now`）是预期重审路径。

3. **search 版本陷阱（真反例，但不阻碍合并）**：`roleVersion(context)` 若返回字符串 `''` 或 `'0'` 等非法值会抛错（正则首字符要求），这是防御正确；但 `add` 在无ver时 `sameVersion(e.roleVersion, ver)` 用于去重是 `null===null`，一致。反例：先无ver add（entry无roleVersion），后有ver search —— `_searchable` 因 `ver&&!sameVersion` 排除，符合隔离。

4. **SocialState 持久化**：
   - `_save` 超2MB循环用 `JSON.stringify(this.data)` 而首轮用 `{version,scopes}` —— `this.data` 本就形如 `{version,scopes}`，字节量等价，无bug。
   - `apply` 的 `previous=structuredClone(this.data)` 回滚覆盖 `_save` 的修剪副作用，正确。
   - `seen` 先 push 后可能 shift 丢掉当前id？`seen.length>64` 时 `shift()` 移除最旧。若同一批高频事件，`apply` 入口已查 `seen.includes(id)` 去重；shift 可能把仍被 trace 引用的证据 id 移出 `seen`，随后 `u.trace=u.trace.filter(e=>u.seen.includes(...))` 会同步剔除——**trace 与 seen 保持一致，不泄漏**。
   - **正向预算拒绝也去重**：`seen.push(id)` 在预算判定**之前**执行，`return finish(false,'positive_budget')` 时 id 已入 seen 并已 `_save`。下次同 id 命中 `duplicate`。✅ 与要求一致。
   - **反馈验证一次包括拒绝**：`ctx.socialFeedbackUsed=true` 在 `state.apply` 前设置，仅在 quote/event/scope/sender/directText/outcome 全部校验通过后。预算拒绝路径走 `state.apply` 内部，`record(r.reason,true,r.applied===false)`，`socialFeedbackUsed` 已置真 → 后续 `already_used`。✅ 符合“含拒绝只验一次”。注意：校验失败路径（invalid_quote等）**不**置 `socialFeedbackUsed`，可重试——合理。

5. **trace 上限**：`slice(-3)`、`TRACE_TTL=20min`、`interactions` 双条件过滤（`seen.includes && now-e.at<TRACE_TTL`），符合三项/20分钟/seen绑定。

6. **最小反例（观察级，不阻碍）**：
   - `apply` 中 `positiveAt` 预算检查 `u.positiveAt.some(t=>now-t<300000)` 的5分钟窗与“4次/小时”并存；若连续4次后第5次被拒，`seen` 仍记录、`positiveAt` 未增长，正确。
   - `_load` 对 `sVal.lastSeen` 用 `sVal.lastSeen||0`，若持久化为负/NaN会被 `!Number.isFinite` 拦（NaN）但负数能过；`_getOrCreate` 删除条件 `now-value.lastSeen>90天` 对负数恒真会误删——**低风险**，正常写入路径 `now` 恒正。
   - `humor-knowledge` 的 `digest` 排序 `Object.entries` 后 `sort` 与 `JSON.stringify`，字段顺序稳定，OK；`reviewDigest!==digest(c)` 校验在 `validateKnowledge` 内，篡改即拒。

**判断：可离线合并。** 唯一值得记录的低风险：`_load` 未拒负 `lastSeen`，会在下次 `_getOrCreate` 立即剔除该 scope（等价于既有90天清理逻辑，无数据正确性损失）。phase2默认关闭下 `outcome`/`interactionTrace`/`humorKnowledge` 均不激活，不影响。