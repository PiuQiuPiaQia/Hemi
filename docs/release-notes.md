本次修复 Bot 发送展示与多端会话控制，并改善后台任务和用量记录。

- Bot 桌面页和手机端按 Host 的实际消息、队列与历史显示，避免消息先上屏再退回队列；受理前保留草稿。
- 重连草稿同步遵守会话占用及代次，被另一端抢占后保留本机内容，不再把占用冲突显示为 Bot 离线。
- 完善后台任务的状态、停止与交接，统一桌面和 Bot 的任务收口。
- 修复用量记录、模型统计和相关页面的显示。

本次桌面发行提供 macOS（Apple 芯片）DMG 和 ZIP 更新包。Windows 桌面安装包按平台另行发布；Bot 组件通过桌面维护更新，iOS 本轮采用开发签名包覆盖安装。

---

This patch fixes Bot message presentation and session ownership, and improves background task handling and usage records.

- Show Bot messages, queues, and history from Host facts on desktop and mobile. Preserve drafts until acceptance and avoid messages flashing into history before moving to the queue.
- Respect session ownership and its epoch when synchronizing drafts after reconnecting. Preserve local work after a takeover without marking the Bot offline.
- Improve background task state, stopping, handoff, and completion across desktop and Bot.
- Correct usage records, model statistics, and their presentation.

The desktop release includes macOS Apple Silicon DMG and ZIP packages. Windows desktop packages are released separately. Bot components update through desktop maintenance; this iOS update uses an over-the-top development-signed build.
