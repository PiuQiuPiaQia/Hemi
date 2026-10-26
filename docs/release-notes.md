本次修复 Bot 中断、编辑重发与多设备同步，并加入云端组件自动更新。

- 修复停止尚未结束时立即编辑重发可能卡住、重复执行或显示旧回复的问题；迟到的停止指令不会影响新回复。
- Bot 共用消息提交、回执和队列流程；断线或提交结果待核对时保留草稿，避免重复发送。
- 在 PC 打开 Bot 时自动比对云端组件的版本号与内容指纹，有任务运行时等待空闲后更新；旧版 PC 不会自动降级较新的云端版本。
- 设置中显示云端组件版本；自动更新失败时可直接重试。

提供 macOS（Apple 芯片）`.dmg` 和 Windows x64 安装包。已有用户可在“设置 → 通用 → 关于与更新”检查更新。

---

This patch fixes Bot interruption, edit-and-resend and multi-device synchronization, and adds automatic cloud component updates.

- Wait for the previous run to close before resending an edited message, prevent duplicate execution and stale replies, and keep delayed stop commands from cancelling a newer reply.
- Share message submission, receipts and queue handling; preserve drafts during disconnection or uncertain delivery without automatically resending them.
- Compare cloud component versions and content fingerprints when opening Bot on a PC. Wait for active work to finish before updating, and keep newer cloud releases when an older PC connects.
- Show the cloud component version in settings and offer retry after an automatic update fails.

Available for macOS Apple Silicon and Windows x64. Existing users can check for updates in Settings → General → About and Updates.
