本次修复浏览器任务在等待用户确认或手动验证时被提前关闭的问题，并统一任务续接和完成状态。

- 等待账号确认、登录或手动完成人机验证时保留任务页面；回复后读取原页面继续操作，任务完成或取消后再回收窗口。
- 自动续跑与等待答复沿用原目标、已有成果和累计预算，桌面与 Bot 使用相同的完成判断。
- 任务受阻时保留原因并正常结束当前执行，不再把明确的受阻结果作为运行异常显示。
- 兼容 Bot 的“应用版本 + 组件修订号”四段版本号，避免独立更新组件后桌面维护检查失败。

此版本仅提供 macOS（Apple 芯片）DMG 和 ZIP 更新包。Windows 桌面安装包按平台另行发布；云端 Bot 不会随本次桌面发布自动替换。已有用户可在“设置 → 通用 → 关于与更新”检查更新。

---

This patch keeps browser task pages open while waiting for user confirmation or manual verification, and aligns task continuation and completion states.

- Preserve the original page during account confirmation, login, or manual verification. Resume from that page after the user replies, and reclaim the task window when the task completes or is cancelled.
- Keep the original goal, existing results, and cumulative budget across continuations and clarification replies. Desktop and Bot share the same completion checks.
- Preserve the reason for blocked tasks and close the execution normally instead of presenting a blocked result as a runtime exception.
- Recognize four-part Bot component versions consisting of an application version and component revision.

This release includes macOS Apple Silicon DMG and ZIP packages only. Windows desktop packages are released separately, and this desktop release does not automatically replace cloud Bot components. Existing users can check for updates in Settings → General → About and Updates.
