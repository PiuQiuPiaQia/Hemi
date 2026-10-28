# 任务目标续跑与完成判断

PC 是 Hemi 的完整主流程，Bot 根据宿主能力裁剪工具、权限和传输。两端共享 `agent-runtime/core.mjs` 的目标执行、预算、续跑、完成校验和等待用户答复语义。主流程能力在共享核心实现，宿主仅负责装配和结果投影。

## 默认执行契约

`createAgentRuntime().runRootTurn()` 默认进入持久化目标驱动，不再要求 Bot 单独开启 `goalPolicy`。主 agent、子 agent、重试、压缩和辅助调用共享每段 60 次执行额度；触顶等待已受理工作收口后做一次独立、无工具的校验，有可执行的剩余工作则在原 inputId / rootRunId 下续跑。目标累计最多 600 次执行请求、12 段；校验请求单独记账，不清零累计额度。

只有通过独立校验的目标可以完成。必要提问以 `awaiting_user` 正常挂起，用户下一条输入经控制器的 `continuationOf` 续接同一逻辑目标，保留原目标、答复、已有成果和预算。重启不自动重放目标或已发生的副作用；显式停止等待同步取消账本目标。无进展、总预算用尽、校验失败和外部阻塞均保留未完成原因。

`goalRunOutcome()` 是 PC 与 Bot 共用的运行结果约束，统一输出完成、等待答复或停止；未通过完成校验的结果不能由宿主自行标记成功。多段执行的正文、工具名称和执行用量在共享驱动中累计。最后一段触顶但实际工作已完成时，校验确认的完成说明进入正式流和保存的回复。

工作流节点由工作流调度器管理，仍使用原来的节点执行与挂起协议，不把每个节点转换为独立聊天目标。

## PC 宿主接线

`llm.ipc.mjs` 将控制器的 `continuationOf` 传入共享核心，将 `goalComplete` 和 `waitingForUser` 保留到最终运行收口，等待答复不产生错误通知。独立校验用量进入会话用量账本，实际 HTTP 请求仍由共享请求账本记录。停止、回卷和销毁沿用同一归属及取消屏障，迟到校验不能启动新段。

Bot 复用同一核心默认策略及结果约束；保留其远端工具、权限、设备能力和传输装配。历史 Bot 生产部署记录见 [Bot 目标续跑与完成判断](bot-goal-completion.md)。

## 验证

2026-10-28，源码基线 `dcac29084a1d` 加本次工作树改动；macOS arm64 / Node 22.22.3，真实 Electron 44.0.0（内置 Node 24.18.1）。所有应用验证使用全新临时 `HEMI_USER_DATA_DIR`、本机合成模型服务与真实 Pi SDK、文件和 IPC，不读取个人会话或凭据。

- `node --test src/main/agent-runtime/root-goal.test.mjs src/main/agent-runtime/goal-driver.test.mjs src/main/bot/goal-continuation.test.mjs src/main/bot/goal-clarification.test.mjs src/main/agent/hemi-session.test.mjs`：41 项通过。覆盖核心默认驱动、多段输出保留、软额度续跑、主子额度共享、后台结果交接、完成校验、等待答复和取消。
- `node scripts/verify-desktop-goals.mjs --dev` 与 `node scripts/verify-desktop-goals.mjs`：分别验证 Vite 开发 renderer 与构建 renderer。真实 PC 输入触发默认 60 次边界，同一输入/运行进入第二段，实际写文件、独立校验且用量入账；另验证提问、应用重启不自动执行、回答续接、重启后取消等待、校验期间停止和校验失败单条通知。
- 应用报告与截图在忽略目录 `.visual/workflow/desktop-goals/{dev,built}/`。每份报告记录源码基线、工作树、Electron / Node 环境、HTTP 请求分类及通过项。
- `npm run build`、`npm run typecheck`、`node scripts/check-spacing.mjs` 和本次文件的 `git diff --check` 通过。首次构建曾被另一批用量页改动的 `vitest` 类型导入阻断，该文件在并行修改中改用 `node:test` 后，重新执行完整构建通过；renderer 保留已有大 chunk 警告。
- `node scripts/run-tests.mjs` 运行完整测试集：1967 项，1953 通过、13 跳过、1 失败。唯一失败为工作区另一批用量页改动触发的原生样式门：`styles/usage-history.css:202` 的 `:focus:not(:focus-visible)` 没有挂在 `html.kb-nav` 下。单独复跑 `node --test src/renderer/src/native-gate.test.mjs` 确认相同失败。本次未修改该页面或它的样式。

验证不代表已发布或替换已安装的 PC / Bot；本次没有使用真实外部模型或生产主机做验收。Windows、实体移动设备和工作流的额外界面回归不在本次专项范围内。
