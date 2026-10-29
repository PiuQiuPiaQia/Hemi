# 正文输出与运行阶段

正文生成和目标运行分别表达。SDK 的 assistant `message_end` 经桌面 IPC 或 Bot runtime 投影为 `message-end`，关闭当前正文与思考 part，并持久化 `endedAt`。共享时间线仅为尚未结束的尾部内容显示光标；切换会话或重新加载后沿用快照中的事实。

宿主收尾沿用现有 `run-activity` 通道。SDK 会话报告上下文压缩、后台命令与资源等待，根目标驱动报告校验、续跑、子任务等待和收尾。消息继续输出时回到 `running`。桌面、Bot 页面与移动端共用 `RunActivity` 的一行展示，后台命令仍可展开查看最近输出和停止命令。

| activity.phase | 展示 |
| --- | --- |
| `running` | 正文或工具执行；有后台命令时保留原有命令摘要 |
| `compacting` | 正在压缩上下文 |
| `verifying` | 正在检查完成情况 |
| `continuing` | 继续处理剩余工作 |
| `waiting-subagents` | 等待子任务完成 |
| `waiting-background` | 保留现有后台命令摘要与等待结果提示 |
| `waiting-resource` | 等待桌面、浏览器或工作区资源 |
| `finishing` | 正在收尾 |

阶段只供展示，不改变目标状态、完成校验、额度或自动续跑。目标仍须按原契约关闭；停止期间及已关闭运行拒绝迟到的活动事实。运行关闭后状态行消失，原有等待用户、受阻、部分完成和错误说明继续使用原有展示。

## 验证

- `node --test packages/conversation-flow/test/run-lifecycle.test.mjs src/main/services/flow-parts-projection.test.mjs src/main/agent-runtime/root-goal.test.mjs`：消息结束、校验和续跑、旧快照、重放及迟到事件。
- `node --test src/main/bot/goal-continuation.test.mjs`：实际 Bot Host/SDK 的正文结束事实、校验期间运行状态、取消、额度续跑。
- `node scripts/verify-run-lifecycle.mjs`：新建隔离数据目录，分别运行 Vite 和构建 renderer；使用真实 IPC、控制器、SDK、自动压缩及本机后台进程，仅外部模型 HTTP 响应受控。覆盖输出光标、校验、原目标续跑、重载、三个窗口宽度和停止按钮。

执行环境、源码基线、截图与未覆盖项记录在 `.visual/workflow/run-lifecycle/report.json` 和 `.visual/workflow/vision-report-run-lifecycle.md`。本流程不更新安装版、生产 Bot 或设备。
