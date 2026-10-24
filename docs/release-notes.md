本次更新完善云端 Bot、手机接入与模型自动配置，并统一本地和 Bot 的执行机制。

- 会话独立运行：Bot 复用本地执行核心，不同会话可以同时执行；只有冲突资源的操作需要等待。同一会话保持消息顺序，停止只影响所属会话。
- 模型自动配置：初始化和后续变更自动更新本机 API Key 模型、主模型、角色模型与备用模型。来源图标区分本机与云端配置，本机配置在本机修改，云端配置仍可独立新增和编辑。
- 手机接入：支持安全配对、实时回复、模型切换、会话管理、附件上传与资源预览；修复模型选项可见却无法点击的问题。
- 界面一致：桌面与手机共用输入、选择、授权和会话列表组件，精简 Bot 模型设置与自动路由展示，并补充资源等待状态和上下文容量指示。

下载：macOS（Apple 芯片）用 `.dmg`，Windows（64 位）用 `-setup.exe`。macOS 安装包未签名、未公证，首次打开需在「系统设置 → 隐私与安全性」中允许。

---

This update improves the cloud Bot, mobile access and automatic model configuration, and shares the desktop execution core with the Bot.

- Independent conversations: Bot conversations run concurrently, with conflicting operations waiting for their resources. Inputs within a conversation stay ordered, and stopping a run affects only its conversation.
- Automatic model configuration: local API-key models and primary, role and fallback selections update automatically. Source icons distinguish local settings from editable cloud settings.
- Mobile access: secure pairing, live replies, model switching, conversation management, uploads and resource previews. Model-picker options are clickable again.
- Consistent interface: desktop and mobile share composer, selection, permission and conversation-list components. Bot model settings and routing details are more compact, with resource-wait status and a context-capacity indicator.

Downloads: `.dmg` for macOS (Apple silicon), `-setup.exe` for Windows (64-bit). The macOS build is unsigned and unnotarized; allow it on first launch under System Settings → Privacy & Security.
