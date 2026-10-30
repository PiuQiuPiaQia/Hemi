# 任务目标续跑与完成判断

PC 是 Hemi 的完整主流程，Bot 根据宿主能力裁剪工具、权限和传输。两端共享 `agent-runtime/core.mjs` 的目标执行、预算、续跑、完成校验和等待用户答复语义。主流程能力在共享核心实现，宿主仅负责装配和结果投影。

## 默认执行契约

`createAgentRuntime().runRootTurn()` 默认进入持久化目标驱动，不再要求 Bot 单独开启 `goalPolicy`。主 agent、子 agent、重试、压缩和辅助调用共享每段 60 次执行额度。分段交接与目标完成是两个边界：触顶时保存已有结果，仍有已受理工作则在原 inputId / rootRunId 下持久化检查点并进入下一段；在途前台动作与子任务报告收口后进行独立、无工具的完成校验；模型回复结束且只剩后台命令时先交接后台等待并释放前台；没有未决后台命令时再进入完成检查。目标累计最多 600 次执行请求、12 段；校验请求单独记账，不清零累计额度。

完成判定优先使用独立校验；校验服务或输出格式故障时，按下述宽松策略记录原因并放行本轮结果。执行、持久化和归属边界仍必须通过。必要提问以 `awaiting_user` 正常挂起，用户下一条输入经控制器的 `continuationOf` 续接同一逻辑目标，保留原目标、答复、已有成果和预算。重启不自动重放目标或已发生的副作用；显式停止等待同步取消账本目标。无进展、总预算用尽、执行失败和外部阻塞均保留未完成原因。校验基础设施故障不等同于模型明确判定未完成。

`goalRunOutcome()` 是 PC 与 Bot 共用的运行结果约束，统一输出完成、后台交接、等待答复、部分完成、阻塞或停止；模型判定及校验异常时的放行均由共享驱动统一决定，宿主不能自行改写结果。多段执行的正文、工具名称和执行用量在共享驱动中累计。最后一段触顶但实际工作已完成时，校验确认的完成说明进入正式流和保存的回复。

工作流节点由工作流调度器管理，仍使用原来的节点执行与挂起协议，不把每个节点转换为独立聊天目标。

## 后台工作与分段交接

单段触顶不等待后台命令退出，也不重启、取消或重新派发已受理工作。主会话在 SDK 安全边界返回，保存已收到的命令结果和子任务报告；账本的 `checkpointGoal()` 允许仍在运行的后台进程和子任务存在，保存检查点、推进轮次和请求偏移。下一段通过隐藏的 `hemi_goal_continuation` 消息获得原目标及待处理工作，沿用任务 ID、进程、generation、冻结模型策略和原截止时间。该检查点不是完成判定，也不会写入 `complete` 校验记录。

等待后台命令或子任务期间，共享请求上限通过账本提交事件唤醒主调度器，不轮询模型。子会话触顶后保留工作并等待根目标交接，不把共享额度不足当作子任务完成。下一段可以读取输出、核对成果、等待仍需要的任务，或明确停止不再需要的工作。静默观察与完成事件不因分段上限丢弃；等待的取消不会消费完成结果。进程在交接期间恰好退出时，先等待有界的结果保存并投递一次，再进入完成检查。

模型回复结束且只剩受管后台工作时，目标先持久化为 `waiting_background`，本轮 flow 以 `awaiting-background` 释放前台；不调用完成校验来决定是否允许用户继续对话。后台完成事件进入同一对话调度器，在当前回合及用户队列后处理，保留原目标身份、模型策略和累计预算。没有未决后台工作时，`checkGoal()` 仍拒绝任何未确认请求、工具、前台进程、清理未知进程、派单及报告。详细规则见 [后台命令与对话回合](background-commands.md)。标题等独立辅助作业仍按原契约分别收口。交接上限或目标累计预算耗尽时，宿主先停止所属命令和子任务并确认清理，再以 `partial / budget_limited` 收口。清理失败保持明确失败，不能伪装为已完成或已清理。用户停止优先于检查点及校验，迟到事件不能启动下一段；重启保留检查点事实并将未收口目标标记 interrupted，不重放副作用。

本逻辑对普通后台命令统一适用，不检查 WebSocket、下载工具、命令文本或特定报错。

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

## 分段与后台任务交接验证（2026-10-29）

源码基线 `1e1697b84fc2099a1b1165d163c5f4cd5bcbf6c9` 加本次工作树差异；macOS arm64 / Node 22.22.3，真实 Electron 44.0.0（内置 Node 24.18.1）。保留工作树内其他会话的改动。模型 HTTP 使用本地合成响应，PC 核心、Bot Host、Pi SDK、账本、Shell 进程、文件及未关闭的真实 WebSocket 均走实际实现；所有验证使用新临时应用数据。

- `node --test src/main/agent-runtime/background-handoff.test.mjs src/main/agent-runtime/goal-driver.test.mjs src/main/agent-runtime/run-journal.test.mjs src/main/agent/gate/background-job-controls.test.mjs src/main/agent/background-commands.test.mjs src/main/agent-runtime/root-goal.test.mjs src/main/bot/goal-continuation.test.mjs src/main/bot/goal-clarification.test.mjs`：82 项通过。新增 PC/Bot 场景覆盖工作已完成但 WebSocket 未关闭、触顶后的静默检查、正常长任务、停止一条不影响另一条、硬超时、子任务触顶唤醒父调度、用户停止、总轮数及总请求预算耗尽；另覆盖完成与持久化交接竞态、取消等待不消费结果、检查提醒与交接竞态、重启保留检查点且不重放。最终保持独立辅助作业原有收口边界后，目标驱动及后台交接 37 项复验通过。
- 按 `scripts/run-tests.mjs` 相同的 275 个文件范围，使用 `node --test --test-concurrency=4` 完整执行：2065 项，2045 通过、20 跳过、0 失败。
- `node scripts/verify-background-handoff.mjs --dev` 与 `node scripts/verify-background-handoff.mjs`：开发及构建 renderer 均通过真实输入、preload、IPC、controller 和默认 60 次分段边界。保持同一用户输入、root、任务 ID 与原截止时间，重载后恢复状态；下一段读取并停止残留连接，最终仅校验一次；交接后的在途请求被用户停止时清理进程且迟到响应不再启动工作。截图已复核。
- `npm run build`、`node scripts/check-spacing.mjs` 和本次差异的 `git diff --check` 通过。构建保留已有 renderer 大 chunk 提示。

证据在忽略目录 `.visual/workflow/background-handoff/`，含源码校验值、验证摘要和开发/构建 renderer 报告及截图。本次未替换安装版、发布 PC/Bot、更新生产服务或操作实体移动设备；Windows 的独立实机进程生命周期未在本轮复验。


## 完成校验宽松策略（2026-10-30）

根据用户选择，参考本地 ZCode `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1` 的宽松解析与 fail-open 语义，独立实现 Hemi 的校验故障放行。未复制 ZCode 源码。该策略替代初步实现的“格式失败后重试一次、再失败则终止”。

- 校验沿用实际执行的冻结模型候选，禁用工具和备用切换，每轮只请求一次。解析兼容代码围栏、解释文字和一层 JSON 字符串编码；能够解析的判定继续检查 Hemi 原有状态、证据、剩余事项及下一步结构。
- 有效的 `continue`、`awaiting_user`、`blocked` 判定保持原行为。输出 JSON、结构、结束原因或意外工具调用异常，以及校验 HTTP、网络、超时或流式服务故障时，按 fail-open 策略正常结束本轮，不因为校验器故障重启执行 agent、重跑命令、追加目标轮次或重放发布操作。
- 放行结果写入 `verificationBypassed:true` 和 `verificationFailure`。它是宿主的策略决定，`evidence` 为空，不伪造模型通过校验或已有执行证据；正常通过和故障放行在账本中可区分。
- `checkGoal()` 前置执行屏障拒绝未收口的请求、工具、前台进程、清理未知进程、派单及报告。当前目标仍有未决后台命令时直接交接后台等待，尚不调用完成校验，不把后台受理回执放行为成功。用户停止、执行失败、预算限制、凭据/归属控制错误、账本保存和诊断写入失败均不通过该兜底转为成功。受控传输通过 `onControlError` 将准入、持久化等控制错误交回校验调用者，避免被通用模型服务错误包装掩盖。
- `goal.verificationAttempts` 保存轮次、有效性、放行标记、错误类别、结束原因、响应形状、字符数和 SHA-256，不保存响应原文、思考或输入证据。真实 HTTP 和用量继续逐次记账。取消和重启保持禁止重放边界，不修改旧会话终态。

源码验证基线 `de447c7f603b1e4cda00fa50a833cafe1b717532` 加本次工作树差异；macOS arm64 / Node 22.22.3 / Pi SDK 1.3.0。专项使用新临时目录、真实 PC 共享核心、Bot Host、SDK、HTTP SSE、命令和文件；仅模型 HTTP 响应为本机合成数据。

验证命令、环境、源码哈希和结果保存在忽略目录 `.visual/workflow/goal-verification/`。UI 专项命令为 `node scripts/verify-goal-verification.mjs --dev` 与 `node scripts/verify-goal-verification.mjs`，覆盖开发和构建 renderer 的坏 JSON 放行、HTTP 故障放行、明确未完成后继续写文件、取消优先，以及重启保留诊断不重放。

本次未替换安装版、发布桌面版本、部署生产 Bot 或修改正式会话状态。原安装版没有留存失败校验的响应原文，历史输出形状无法追溯。真实 GLM-5.3 合成证据探针在此前命令行环境未连通；本轮专项不代表外部服务实测验收或 Windows/实体设备验证。

最终验证：`npm test` 共 2,210 项，2,189 通过、21 跳过、0 失败；包含最终取消竞态和宿主放行标记不能由模型设置的检查。`node scripts/verify-goal-verification.mjs --dev` 与 `node scripts/verify-goal-verification.mjs` 各 5 项界面/重启场景通过，截图已复核。`node --check` 与本次文件 `git diff --check` 通过。开发验证期间 Vite 打印过 ResizeObserver 回环通知，功能断言通过，截图未出现覆盖层；未改 renderer 处理该通知。
