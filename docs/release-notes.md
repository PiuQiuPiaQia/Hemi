本次更新改善多设备对话、模型配置与消息交互，仅提供 macOS（Apple 芯片）安装包。

- 支持会话占用与明确接管，避免 PC 和手机同时修改同一对话；查看历史不会打断云端任务。
- 优化发送后的即时反馈、断线恢复和队列显示，修复编辑回卷可能重复执行，以及键盘、长列表下的滚动问题。
- 正式版和开发版连接同一个 Bot 时，以正式版的模型与路由为准，避免相互覆盖；失效模型显示明确提示。
- 模型目录自动从供应商获取，支持手动补充型号；新增 GLM Coding Plan（BigModel）账号登录。
- 模型和思考强度点选后立即更新显示，后台同步；改善消息间距与移动端复制、编辑按钮。
- 普通命令不再占用整个工作区的协作锁，独立会话可并行执行；明确文件目标继续参与资源协调。
- 上下文入口改为静态图标和实际用量明细，避免容量进度造成误解。

下载 `.dmg` 安装；已有 macOS 用户可在“设置 → 通用 → 关于与更新”检查更新。

---

This update improves multi-device conversations, model configuration and message interaction. This release ships macOS Apple Silicon artifacts only.

- Coordinate conversation ownership and explicit takeover across desktop and mobile without interrupting cloud work when viewing history.
- Improve immediate send feedback, reconnection, queue presentation, editing and scroll anchoring.
- Keep the production model catalog authoritative when development and production connect to the same Bot.
- Fetch model catalogs from providers and add GLM Coding Plan account sign-in.
- Apply model/thinking selections immediately while syncing in the background; refine message spacing and mobile inline actions.
- Allow ordinary commands in independent conversations to run concurrently while retaining explicit file coordination.
- Show actual context usage through a static entry instead of a capacity progress ring.
