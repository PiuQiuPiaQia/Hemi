# Security and privacy / 安全与隐私

Report a suspected vulnerability to **329988300@qq.com**. Include the affected version, reproduction steps and impact; send a minimal example with secrets and personal data removed. Please avoid posting exploitable details in a public issue before a fix is available.

Hemi stores configuration, conversations, memory and task records in the local application-data directory. Model requests send the conversation context, relevant attachments and tool results to the provider you configure. Speech and search use their configured services. Screenshots and browser content can enter model requests during tasks that use them; review your provider's data policy before sending sensitive material.

API keys, account tokens and remembered passwords use app-owned AES-256-GCM encryption. The encryption key lives in `secrets/` under the application-data directory, with private file permissions where supported. This relies on the OS user's file access, not application isolation. Back up the entire application-data directory together. The system credential store is not used. Credentials saved in the former OS-encrypted format must be configured again; model names and endpoints remain available.

File operations and commands run with the current user's access, subject to Hemi's tool checks and dangerous-command confirmations. Desktop control requires application-level authorization. These checks do not provide OS isolation for arbitrary shell commands. Skills and external tools can execute code; review their source before enabling them.

Before sharing logs or screenshots, remove keys, personal conversations and other private content. Hemi's own code is [MIT](LICENSE); distributed dependencies retain the licenses listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

发现疑似漏洞请联系 **329988300@qq.com**，附受影响版本、复现步骤和影响，使用已去除凭据及私人数据的最小示例。修复可用前，请避免在公开 issue 中披露可利用细节。

Hemi 将配置、会话、记忆和任务记录保存在本机应用数据目录。模型请求会把对话上下文、相关附件和工具结果发给你配置的提供方；语音和搜索使用各自配置的服务。使用截图或浏览器内容的任务可能将这些内容传给模型，发送敏感资料前请核对提供方的数据政策。

API Key、账号 token 和记住的密码由应用使用 AES-256-GCM 本地加密。加密钥匙位于应用数据目录的 `secrets/` 中，支持的平台会设置私有文件权限；保护范围是系统用户的文件访问权限，不提供应用之间的隔离。备份时需保留完整应用数据目录。应用不使用系统钥匙串，旧系统密文不再兼容，需要重新填写 Key 或登录账号；模型名称与接口地址仍会保留。

文件操作和命令按当前用户的权限运行，并经过 Hemi 的工具检查及危险命令确认；桌面操控按应用授权。这些检查不构成任意 shell 命令的操作系统隔离。Skill 和外部工具可能执行代码，启用前请检查来源。

分享日志或截图前请去除 Key、个人会话和其他私人内容。Hemi 自有代码采用 [MIT](LICENSE)，分发依赖保留[第三方清单](THIRD-PARTY-NOTICES.md)中的原许可。
