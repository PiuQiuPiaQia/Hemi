本次更新带来原生共享记忆、Windows Bot 支持和独立的 Bot 模型配置，并改进浏览器后台执行与多端对话体验。

- 桌面与 Bot 主会话直接使用原版 pi-memory，共享所属实例的长期记忆、日志和待办；支持原生遗忘与恢复，并可在桌面和手机查看原始文件。旧记忆文件保留，不自动迁移；当前不提供语义搜索，自动整理摘要的用量暂未计入对话统计。
- 支持通过 SSH 连接 Windows x64 主机作为 Bot，包含部署、计划任务常驻、命名管道控制、组件升级回滚与断线恢复。
- Bot 可独立登录订阅账号、导入 New API 或配置 API Key；从本机同步前先对比并选择模型差异，路由在 Bot 中独立配置。
- 云端组件维护改为每 6 小时后台检查，有任务时等待空闲；状态与重试入口集中在 Bot 通用设置。
- 浏览器任务使用独立后台窗口和标签分组，显示虚拟鼠标，并在任务结束后回收页面；开发版与安装版可同时连接扩展。
- 排队消息可取回输入框继续编辑，保留已有草稿和附件；改进发送回执核对、编辑重发与模型恢复提示的顺序，并为手机加入用量统计。

此版本仅提供 macOS（Apple 芯片）`.dmg` 和 ZIP 更新包。macOS 与 Windows 按平台分别发版；已有用户可在“设置 → 通用 → 关于与更新”检查更新。

---

This update adds native shared memory, Windows Bot hosts and independent Bot model settings, and improves background browsing and conversations across devices.

- Desktop and Bot main sessions load the original pi-memory extension, sharing memory, daily logs and scratchpads within each instance. Native forgetting and restoration are available, with file viewing on desktop and mobile. Legacy memory files are retained without automatic migration. Semantic search is not included, and automatic summary usage is not yet included in conversation totals.
- Connect Windows x64 Bot hosts over SSH, including deployment, persistent scheduled tasks, authenticated named pipes, component rollback and reconnection.
- Authorize subscription accounts, import New API configurations or add API keys directly for a Bot. Review and select desktop model differences before syncing; configure Bot routing independently.
- Check cloud components quietly every six hours and wait for idle periods before updating. View status and retry in Bot general settings.
- Run browser tasks in separate background windows with tab groups and a visible virtual cursor, then reclaim their pages when finished. Development and installed instances can connect to the extension simultaneously.
- Return queued messages to the composer while preserving existing drafts and attachments. Improve delivery reconciliation, edit-and-resend and recovery notice ordering, and add mobile usage statistics.

This release includes macOS Apple Silicon DMG and ZIP packages only. macOS and Windows are released separately. Existing users can check for updates in Settings → General → About and Updates.
