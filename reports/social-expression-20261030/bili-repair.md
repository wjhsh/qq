# B站现有入口恢复

此项获用户单独授权并已应用生产；表达/表情候选没有部署。未改QQ主进程、角色卡、B站登录凭证或任何模型线路。

故障范围：只读服务在线、登录有效、搜索成功，但视频详情返回NETWORK_ERROR。受控诊断看到HTTP412，WBI和普通view接口有间歇性拒绝。不能将它说成“登录过期”，也不能以一轮成功保证永不风控。

核查服务器现有`@xzxzzx/bilibili-mcp` 1.14.3副本，发现：

- getVideoInfo主路径及原有412 fallback未携带CredentialManager已有的Cookie；只读status登录并不意味着这两个请求带了登录信息。
- WBI请求用了timestamp，缺少wts；混合密钥保留64字符；签名字符串没有URL编码。核对公开bilibili-api-python 17.4.2的network.py，修为wts、前32字符与标准查询编码。
- 增加Cookie后原有debug的完整请求头会带来泄漏风险，改为只记录头名称，不记录值。

保留原响应大小/超时/限流、安全边界及原有HTTP412单次fallback，不换账号/IP、不关闭TLS验证、不增加无限重试。这是对现有服务器副本的修复，副本含先前修改，不能将每一处都归责于未修改的上游包。

## 验证与备份

5项纯离线契约测试验证主/备请求都携带哑凭证、412只降级一次、其他失败传播、匿名不伪造凭证、32字符与独立Python urlencode/MD5向量、debug不含头值。备份/源哈希/语法检查通过后只重启qq-bili-reader；实际验证登录true、搜索5条、视频平台AI字幕615字、评论10条。再运行修复脚本确认幂等，不二次修改或覆盖备份。

真实记录：bili-apply-result.json、bili-final-verification.jsonl。公开版本无Cookie或用户标识。

备份：`/var/lib/qq-deploy/backups/bili-video-e56c1e698a`（仅三个源文件，私有目录）。服务器已保留计划和脚本：

```sh
python3 /var/lib/qq-deploy/staging/bili-video-e56c1e698a/apply-video-repair.py rollback
```

回滚会短暂停B站读取，遇源哈希冲突拒绝覆盖，保留登录配置；本轮未在线执行回滚，避免撤销已恢复的服务。重新安装npm包可能覆盖这份修改；未来应先对照ops/bilibili-reader/video-repair-lock.json验证，不盲目重复打补丁。

参考wheel：bilibili-api-python17.4.2，SHA256 `91e002b2e0bcd3eb50239e35ceb849133b574f407a92a06636e1de1031b6d09d`；只读提取代码用于核对，未将该SDK安装到生产或替换架构。DeepSeek本项独立审阅1次7218 token、0.17 WorkBuddy credit，非美元。

后续重做优先处理客户端版本与补丁管理、错误分类/有限冷却、字幕与简介的明确降级，以及候选素材→审核→运行时知识的闭环。恢复读取不代表已经有自动后台浏览或学习任务；现有learn仍由命令/模型工具触发。
