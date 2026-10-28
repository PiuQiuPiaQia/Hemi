本次修复 Bot 子任务详情白屏，并补齐连接、启动和抢占会话的操作反馈。

- fixer 等子任务缺少旧日志时仍能打开详情；任务进度实时更新，详情异常时可重试。
- 重新连接、启动 Bot、抢占会话显示加载状态，防止重复请求，并明确反馈结果。
- 移动端同步单个预览抽屉，文件、子任务详情和报告之间直接切换；复用 PC 的 PDF、Word、Excel、PPT 预览，支持图片和视频，扫描 PDF 仍可查看原文。
- 手机历史缓存与操作失败提示使用清晰文案并自动消失；编辑被拒绝时保留原有界面。旧 Bot 保留正文文件链接的文字和图片预览兼容。

本次桌面发行提供 macOS（Apple 芯片）DMG 和 ZIP 更新包。移动端改动随源码同步，iOS 测试包已单独覆盖安装；本次不包含 App Store 或 TestFlight 发布。Bot 组件通过桌面维护更新，正文文件完整原文预览取决于对应 Bot 的协议支持。

---

This patch fixes blank Bot task details and adds feedback for reconnecting, starting, and taking over sessions.

- Open fixer and other child task details without requiring legacy logs. Keep progress current and offer recovery when the detail view fails.
- Show loading and results for reconnect, start, and takeover operations while preventing duplicate requests.
- Use one mobile preview drawer for files, child tasks, and reports. Share PC document previews for PDF, Word, Excel, and PowerPoint, support images and video, and keep scanned PDF pages viewable.
- Make mobile history-cache and action-error notices clear and temporary. Keep the current view when editing is rejected, and retain text/image body-link previews on older Bots.

The desktop release includes macOS Apple Silicon DMG and ZIP packages. Mobile source changes are included, with the iOS test build installed separately; this is not an App Store or TestFlight release. Bot components update through desktop maintenance. Full original-document previews for body links require the corresponding Bot protocol support.
