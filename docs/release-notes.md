本次更新修复后台任务与重启恢复的状态一致性，并加入 Bot 主机能力设置、子任务对话和用量历史。

- 后台命令受理后保持运行状态，真实进程结束才收口；完成结果按命令身份送回原任务，支持增量输出与无新输出时长提示。
- 重启后统一关闭已中断的主任务、子任务、工具和思考状态，保留排队输入并暂停队列，避免界面一直显示运行或自动重放。
- Bot 增加浏览器、联网检索与技能库设置；Windows 主机提供独立桌面助手和窗口资料选择，使用 Bot 自己的配置与授权。
- 子任务可查看独立的只读对话流、工具结果和最终状态。需要用户澄清时显示等待答复，答复后延续目标及其预算。
- 新增跨会话“使用记录”：逐请求历史、筛选分页、每日热力图、缓存用量、首输出耗时和生成速度；未知用量保留为空，URL 与错误内容脱敏。

此版本仅提供 macOS（Apple 芯片）DMG 和 ZIP 更新包。Windows 桌面安装包按平台另行发布；Bot 主机组件通过 Bot 设置独立更新。已有用户可在“设置 → 通用 → 关于与更新”检查更新。

---

This update fixes background task and restart recovery state, and adds Bot host capability settings, subtask conversations and usage history.

- Keep background commands running until their processes actually finish. Deliver terminal results to the original task by command identity, with incremental output and time since the last output.
- Reconcile interrupted runs, subtasks, tools and thinking after restart. Preserve queued inputs and pause the queue without replaying work.
- Configure Bot-owned browsing, web search and skills. Windows hosts use a separate desktop helper and can attach selected window context.
- Inspect read-only subtask conversations, tool results and final status. Necessary clarification waits for the user and resumes within the existing goal budget.
- Browse cross-conversation request history with filters, pagination, daily activity, cache usage, time to first output and generation speed. Unknown values remain empty; URLs and error text are redacted.

This release includes macOS Apple Silicon DMG and ZIP packages only. Windows desktop packages are released separately; Bot host components update independently through Bot settings. Existing users can check for updates in Settings → General → About and Updates.
