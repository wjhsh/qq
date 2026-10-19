# 角色卡位置与编辑范围

本次发布保留现有角色卡，未修改线上人设。后续采用用户讨论后提供的新提示词。

- `qq-agent/src/natural-chat.mjs`：普通群友模板，以及所有角色共用的自然表达规则。
- `qq-agent/src/cat-role-cards.js`：小坏猫、懒猫、傲娇猫、软猫等模板。
- `qq-agent/src/role-card-presets.js`、`role-card-extra-presets.js`：其他预设角色。
- `qq-agent/src/role-card-library.js`：角色匹配、安装与按聊天切换。
- `qq-agent/src/role-isolation.mjs`：角色身份、正文签名、风格偏好与历史隔离。
- 部署配置的 `customPersonas`、`personaByChat`：用户实际保存或选中的角色。私有配置未进入仓库。

编辑模板不会自动覆盖部署配置里已保存的个人角色卡。实施前要检查目标聊天实际生效的人设，区分身份设定、共用表达规则和该群的风格偏好。修改正文会改变角色签名，让旧角色自己的台词不再充当当前角色的说话示例；事实性资料的读取范围仍由宿主控制。

角色卡不具有改服务器、改权限或绕过真实 @ 的授权。机器人排除与管理权限属于宿主逻辑，不依赖角色是否自称真人。

