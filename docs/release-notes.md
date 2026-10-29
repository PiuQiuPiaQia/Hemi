本次发版修复在途回合中编辑重发的两处卡死，补齐长任务的受理、复盘与收口闭环，并整理压缩恢复与桌面排版。

- 在途回合编辑重发不再卡住：回卷先等旧回合收口、渲染层等本地副本代数追平后再派发，不再出现新消息停在「待发送」或误报「本轮没有受理」；空闲时编辑重发同样直接生效。
- 长任务生命周期补全：任务受理统一回执、请求触达软段边界时回合末自动复盘续跑、根任务等待后台与子任务后代工作收口、模型报错后仍在执行的进程保持受管，后台任务异常反馈更完整。
- 修复长会话压缩恢复时上下文窗口计算归零导致的恢复失败。
- 桌面对话流间距对齐设计 token，不同窗口尺寸下排版一致。
- Bot 组件版本随源码更新。

本次桌面发行提供 macOS（Apple 芯片）DMG 和 ZIP 更新包，不包含 Windows 安装包；移动端改动随源码同步。

---

This patch fixes two deadlocks when editing and resending a message while a turn is in flight, completes the admission / review / settle loop for long-running tasks, and cleans up compaction recovery and desktop layout.

- Editing and resending during an in-flight turn no longer stalls: rewind waits for the old run to settle and the renderer waits for the local snapshot generation to catch up before dispatching. New messages no longer pile up as pending, the misleading "turn was not accepted" error is gone, and resending while idle works immediately.
- Long-running task lifecycle is completed: unified admission receipts, soft per-round budget boundaries reviewed at end of round, root tasks waiting for descendant work to settle, and processes still managed after model errors. Background task failure feedback is more complete.
- Fixes compaction recovery failing when the context-window computation collapsed to zero on long sessions.
- Desktop conversation flow spacing now follows design tokens for consistent layout across window sizes.
- The Bot component version follows the source update.

The desktop release includes macOS Apple Silicon DMG and ZIP packages; no Windows installer this time. Mobile changes are included in source.
