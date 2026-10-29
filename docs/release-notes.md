本次发版修复历史中的图像让文本模型请求被提前终止的问题，并为共享会话同步与恢复加入检查点，同时重整会话历史与视口逻辑。

- 文本模型候选不再因历史含图而被跳过或拒发：候选计划按任务能力冻结筛选，历史图片由 SDK 按各候选实际能力处理，不删图、不发空请求；请求限额触顶时明确上报而不是静默截断。
- 共享会话同步加入检查点：快照持久化、桥接传输与会话控制更稳，运行中断后从检查点恢复，不重放已提交的工具结果。
- 会话历史与视口意图集中到一处：历史分页、间隙补读与滚动锚点行为统一，移除渲染层重复实现，长会话滚动与加载更稳。
- 移动端同步检查点、重连与大快照恢复一并落地；Bot 组件版本随源码更新。

本次桌面发行提供 macOS（Apple 芯片）DMG 和 ZIP 更新包。移动端改动随源码同步，iOS 测试包已单独覆盖安装；本次不包含 Windows 安装包或 App Store/TestFlight 发布。

---

This patch stops image-bearing history from terminating text-model requests early, adds checkpoints to shared conversation sync and recovery, and centralizes conversation history and viewport logic.

- Text-model candidates are no longer skipped or rejected because history contains images. Candidate plans are frozen by task capability, history images are handled per candidate capability by the SDK, and hitting the request limit is reported instead of silently truncating.
- Shared conversation sync gains checkpoints: snapshot persistence, bridge transport, and session control are steadier, and interrupted runs recover from checkpoints without replaying submitted tool results.
- Conversation history and viewport intent live in one place. History paging, gap filling, and scroll anchors behave uniformly, duplicated renderer implementations are removed, and long sessions scroll and load more reliably.
- Mobile sync checkpoints, reconnection, and large-snapshot recovery land together; the Bot component version follows the source update.

The desktop release includes macOS Apple Silicon DMG and ZIP packages. Mobile source changes are included, with the iOS test build installed separately; this release does not include Windows installers or App Store/TestFlight distribution.
