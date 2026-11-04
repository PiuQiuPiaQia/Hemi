修复旧任务恢复条残留和 Chrome 任务分组收尾，更新模型运行时。

- 修复新问题运行中、完成后、切换会话或重启应用时，旧任务的恢复条再次出现的问题。只有当前会话最近符合条件的目标可以恢复，最新停止目标仍可在重启后继续。
- 保留浏览器任务的原生标签分组、任务摘要和颜色；任务完成或取消后先解除分组再关闭页面，避免在 Chrome 的「已保存的标签组」里继续累积任务分组。并行任务和普通浏览器窗口不受影响。
- Pi 模型运行时从 1.3.0 更新到 1.5.0，同步依赖、供应商模型目录测试与第三方许可材料。

浏览器扩展需更新到 0.3.7，并在 `chrome://extensions` 重新加载。此前已经保存的历史分组不会由本次更新自动清理。

注意：macOS 继续使用固定自签名身份，不等于 Apple Developer ID 签名或苹果公证，首次打开仍可能出现 Gatekeeper 提示。

---

Fixes for stale task-resume controls and Chrome task-group cleanup, plus an updated model runtime.

- Fixed old task-resume controls reappearing during or after a new question, across conversations, or after restarting the app. Only the latest eligible objective in the current conversation can be resumed; the latest stopped objective remains resumable after a restart.
- Kept native Chrome task groups, their task titles, and colors. Task completion or cancellation now ungroups tabs before closing pages, preventing new task groups from accumulating in Chrome's saved-group list. Concurrent tasks and ordinary browser windows are preserved.
- Updated the Pi model runtime from 1.3.0 to 1.5.0, including dependencies, provider model-catalog tests, and third-party license materials.

Update the browser extension to 0.3.7 and reload it at `chrome://extensions`. Previously saved historical groups are not automatically removed by this update.

Note: macOS continues to use a pinned self-signed identity, not Apple Developer ID signing or Apple notarization. Gatekeeper warnings may still appear on first launch.
