修复任务恢复与模型切换体验，完善模型请求恢复提示。

- 停止后的任务可通过「恢复」按钮继续；文字或语音输入「继续」等明确指令时，沿用原目标、已有成果和下一步，不再把「继续」当成一个空的新任务。没有可恢复目标时仍按普通消息处理，不自动重放已停止的工作。
- 统一桌面与 Bot 会话的目标恢复入口，修复恢复时用户原话与助手回应的显示顺序。
- 精简模型选择提示：切换后直接更新当前模型名，不再显示重复的成功提示；保留读屏播报、环境覆盖警示与不可选原因，统一下拉菜单和 /model 面板的搜索与禁用说明。
- 已知模型按服务商目录使用输出上限，不再一律压到 32K；只有目录未收录的自定义型号继续使用 32K 兜底。
- 精简模型请求恢复状态行，保留「立即重试」操作和回合中的完整错误信息；重试被拒时说明冷却、连接中或恢复周期已变更等原因，并修复按钮状态卡滞。

注意：macOS 继续使用固定自签名身份，不等于 Apple Developer ID 签名或苹果公证，首次打开仍可能出现 Gatekeeper 提示。

---

Fixes for task resumption, model switching, and model-request recovery feedback.

- Resume stopped tasks with the Resume button. Explicit text or voice requests such as “继续” retain the original objective, existing results, and next action instead of creating an empty new task. Without a resumable objective, input remains a normal message; stopped work is never replayed automatically.
- Unified task-resume controls in desktop and Bot conversations, with corrected ordering of the user's request and the resumed response.
- Reduced redundant model-switching feedback. The selected model name updates directly, while screen-reader announcements, environment-override warnings, and unavailable-model explanations remain. Search and disabled-state wording now match between the dropdown and /model panel.
- Known models use their provider-catalog output limits instead of a universal 32K cap. Unlisted custom models retain the 32K fallback.
- Simplified model-request recovery status while retaining Retry now and full error details in the conversation. Rejected retries explain cooldown, an active connection, or a changed recovery cycle; retry controls no longer remain stuck.

Note: macOS continues to use a pinned self-signed identity, not Apple Developer ID signing or Apple notarization. Gatekeeper warnings may still appear on first launch.
