本次发版修复旧命令异常导致所有会话无法发送消息的问题。

- 启动时，旧命令的清理状态无法确认也不会阻塞其他会话或新建会话。旧命令保留记录，不会自动重跑。
- 命令清理失败时结束当前任务；用户明确发起下一任务后可以继续，已排队的输入保持暂停。
- 修复取消命令时登记延迟，将已经确认退出的命令误记为“清理未确认”的问题。

本次提供 macOS（Apple 芯片）DMG 和 ZIP 更新包。共享运行时修复随源码发布；不包含 Windows 安装包，也未部署生产 Bot。

---

This patch fixes old command errors preventing every conversation from sending messages.

- Unconfirmed cleanup of an old command no longer blocks other or newly created conversations during startup. The record is retained and the command is never replayed automatically.
- A command cleanup failure ends the current task. A new task explicitly started by the user can proceed, while queued inputs remain paused.
- Fixes delayed registration incorrectly marking a cancelled command with confirmed cleanup as unconfirmed.

This release includes macOS Apple Silicon DMG and ZIP packages. The shared runtime fix is included in source; no Windows installer or production Bot deployment is included.
