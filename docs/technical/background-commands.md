# 后台命令与资源等待

## 执行语义

本机 `bash` 支持 `run_in_background: true`；普通调用默认前台等待 10 秒，超出后交回模型并继续在宿主中运行。`yield_ms` 可调整前台等待预算（0–120000）。`timeout_ms` 是独立的进程硬超时：前台默认 30 分钟，显式后台默认 24 小时，最大 24 小时；自动转后台保留原截止时间。

所有后台命令使用同一套进程守护、输出缓冲、事实库和控制工具，不提供服务分类参数，也不根据命令文本、运行时间或日志关键词推断服务类型。`rootRunId`、generation、taskId 保留执行来源；进程可以越过本次模型生成与主目标收口继续运行。同一会话主 agent 可用 `job_list`、`job_output`、`job_kill` 查询和控制当前及此前根目标、所属子任务的后台命令；子任务只可控制自己的命令，其他会话不能访问。

转后台回执只表示进程受理，不证明用户目标完成。启动工具在受理后结束，进程结果作为独立宿主事实保存，不让工具永久显示执行中。

## 对话回合与后台目标分离

- 主模型决定是否还需要同步等待：需要结果时调用 `job_output`，每次最多等待 30 秒；仍有独立工作时继续调用工具；本轮助手回复结束后，宿主释放前台。
- 若此时仍有所属后台命令，目标持久化为 `waiting_background`，flow 的本轮结果为 `awaiting-background`、会话回到 idle。原目标尚未被判为完成，用户可以正常提问，队列也可继续派发。
- 交接后台等待发生在独立完成检查之前，不调用额外模型选择等待对象，不根据命令名、日志或时长识别常驻服务，没有 `waitForJobs` 协议。
- `pnpm dev`、构建、测试和下载走同一条路径。服务可以持续运行；有限命令退出后，宿主保存真实终态和输出，并将通知交给现有对话调度器。当前对话忙时先等待，空闲时启动事件回合；用户队列优先，暂停队列时也不自动唤醒。
- 事件回合保留原 `rootRunId`、generation、冻结模型策略、目标原文与累计请求预算，在 flow 中有独立回合身份；不插入伪造的用户消息、不重发原始命令。模型读取已完成结果后抑制重复通知；被主动停止的命令不会自行唤醒旧目标。
- 结果处理后若还有所属命令，继续交接后台等待；没有待处理后台工作时，现有目标检查可以决定完成、继续、等待用户或阻塞。服务启动就绪需要主模型按用户目标执行独立有界核验，启动回执不能代替就绪证据。服务仍在运行不会因此占住前台。
- 显式“检查进展”可提交状态观察事件；静默本身不产生周期性模型请求，也不证明失败，不延长原截止时间。

`checkGoal()` 仍拒绝在途请求、工具、派单、报告、前台进程及清理未知的进程。主模型回复结束且只剩受管后台工作时使用安全交接，不拿完成检查充当前台锁。目标总预算耗尽则先清理所属工作，再以部分完成收口；不能借后台唤醒重置预算。

## 清理和恢复

普通新输入保留后台进程。自动失败或预算收口仅清理所属目标；明确停止、插队、回卷、会话释放及应用退出仍遵守实际清理屏障。模型或工作区切换时，仍持有后台命令或未读结果的旧会话保留命令控制能力；后续事件按原目标的模型策略处理。持有未决后台目标的会话不做空闲淘汰。

进程启动前持久登记 PID、出生信息和随机归属标记。重启先按真实归属回收旧进程，将旧后台目标标记中断，不恢复服务、不重跑命令、不重放旧通知、不自动执行保留的用户队列。清理未确认时拒绝后续模型动作、标明失败并暂停自动发送。开发验证使用新的临时 `HEMI_USER_DATA_DIR`，不改写个人会话或安装版数据。本实现覆盖主／子 agent 的本机命令；远端 SSH 工具保留原有前台执行、取消及超时语义。

## 参考实现

只读核对本地源码，未复制第三方实现、引入依赖或修改参考项目：

- ZCode `3.17.1`，`a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`：`apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` 分离后台登记、观察和终态通知；`tool/handlers/task-output.ts` 提供有限等待和结果读取；`runtime/methods/background-notifications.ts` 在退出或旧 branch generation 时抑制通知。
- DeepSeek Harness `d743267388641bc76f17c45ce8b4c231aed1d32c`：`packages/jobs/jobs-local/src/index.ts` 的 job 归属准确的会话 Agent，可越过工具调用存活，owner disposal 取消并等待实际收尾；`packages/shell/tool-bash/src/background.ts` 分离进程与工具调用取消；`packages/jobs/tool-jobs/src/index.ts` 提供统一查询、输出和停止。

两者的 Bash/Job 层均未按常驻服务与普通任务分类。Hemi 同样将后台进程存活与前台回合占用分离；需要同步等候时由主模型显式有限等待，宿主按实际退出事件交接后续处理。

## 本轮验证（2026-10-30）

基线为 `de447c7f603b1e4cda00fa50a833cafe1b717532` 加本次及工作区原有未提交改动；macOS arm64、Node 22.22.3、Electron 44.0.0（内置 Node 24.18.1）、源码应用版本 0.2.29。源码与安装版版本不同，本轮未提交、发布、替换安装版、更新生产 Bot 或操作实体移动设备。

验证入口：

```sh
node --test src/main/agent-runtime/goal-driver.test.mjs src/main/agent-runtime/run-journal.test.mjs src/main/agent-runtime/background-handoff.test.mjs src/main/agent-runtime/agent-task-lifecycle.test.mjs src/main/agent/gate/background-job-controls.test.mjs src/main/agent/background-commands.test.mjs
node --test src/main/bot/background-jobs.test.mjs src/main/bot/command-lifecycle.test.mjs src/main/bot/execution.test.mjs src/main/bot/goal-continuation.test.mjs
HEMI_USER_DATA_DIR=<新的临时目录> npm test
npm run build
node scripts/verify-background-goals.mjs
node scripts/verify-background-goals.mjs --dev
git diff --check
```

Electron 验证走实际 UI → preload → IPC → Runtime → Pi SDK → Shell → HTTP 服务，仅模型响应合成：无服务分类参数启动开发服务，独立就绪检查后结束本轮回复，队列中的问题继续执行且服务仍响应 HTTP；重载保持 idle，不重放；使用完全相同的后台接口启动有限构建，构建期间前台空闲并可继续问答，真实退出结果回来后按原目标自动处理，期间原开发服务继续运行；后续目标查询和停止同一进程。PC/Bot 定向回归另覆盖分段交接、真实超时、单条停止、所属子任务的后台工作、取消清理失败和队列暂停。

最终结果：`npm run build`、`git diff --check` 通过。开发 renderer 与构建 renderer 的 Electron 流程各四组断言通过，页面错误列表为空，截图已复核。Dev 控制台有既有 ResizeObserver 通知循环提示，功能断言通过。按 `scripts/run-tests.mjs` 相同四个根目录枚举全部 291 个测试文件，以 Node 文件并发 4、独立临时数据目录完整重跑：2226 项，2205 通过、21 跳过、0 失败；随后未读与通知文案专项 14 项通过。完整命令为 `node .visual/workflow/background-goals/run-full-suite.mjs`，入口脚本内部创建和清理临时 `HEMI_USER_DATA_DIR`。最终日志为 `async-full-final.log`、`async-build-final.log`、`async-dev-final.log`、`async-built-final.log`、`async-notification.log`。额外真实 PC/Host 场景覆盖模型切换后保留原进程和原策略、在另一目标结束后停止旧目标、异步清理未知拒绝启动模型，以及事件受理保存失败后等待显式恢复。

日志、截图与最终检查结果保存在忽略目录 `.visual/workflow/background-goals/`。未验证 Windows 真机、移动设备、真实外部模型的完成判断或安装包更新后行为；没有对真实项目或个人配置进行启动、迁移或写入。

## 锁的范围

- 普通 Bash／PowerShell 不申请工作目录租约；命令前台运行或转后台都不会阻塞其他会话对同目录文件的读取、写入或其他命令。文件工具仍按显式目标协调冲突读写，浏览器按会话使用 `browser:<owner>`，桌面使用交互资源租约。
- 后台命令保留原执行来源并由会话持续管理；同步等候由主模型显式有限等待，回合结束后由完成事件触发后续处理。它不保留目录锁。共用目录不提供任意 Shell 写入隔离，需要隔离并发修改时使用独立工作目录。
- 进程清理未确认时拒绝原目标的后续执行，避免冒充已停止；不为其他会话留下整目录锁。

## 等待状态与输出

默认目标驱动的后台交接会关闭本轮运行并清除 activity；会话为 idle，后台目标为 `waiting_background`。以下 activity 仅用于仍未结束的前台／SDK运行，不代表所有存活后台命令都会占用主对话：

- `running`：模型或工具在推进，可同时列出后台命令。
- `waiting-background`：SDK 内的有界等待或非目标驱动兼容路径；默认目标驱动结束回复后使用独立后台交接。
- `waiting-resource`：等待工作区、桌面或共享浏览器资源；携带阻塞操作摘要和等待起点。

界面显示等待原因、耗时、命令最近输出及停止入口；列表使用时钟标志。等待时收起正文生成光标、输入框的回应提示和用量运行点；通话条也显示等待。renderer 重载通过 flow 快照接回，运行收口清除 activity，旧代次/旧运行的活动更新被丢弃。

完整输出保存到受控上下文快照，模型收到有界尾部、真实退出状态及快照引用。内存中的完成队列只保留有界输出；UI 显示最近 2000 字符。子 agent 的停摆检测区分宿主明确的后台/资源等待与无响应模型流。

## 展示与文案（2026-10-22）

`bash` 增加可选 `description`，说明操作目的，供工具摘要、后台面板和工作区阻塞说明共同使用。宿主将其收成最多 80 字符的单行文本并登记到命令记录；它不代表操作成功。缺少说明的旧调用仍可执行，后台面板显示「后台命令」，对话工具摘要显示「执行命令」。不从 Shell 脚本推断外部服务的阶段或完成比例。

每条后台命令只显示一处「已运行」，从其 `startedAt` 计时；资源等待才显示「已等待」，从进入资源等待时计时。多条命令分别计时。宿主从真实 stdout/stderr 事件记录 `lastOutputAt`，有该字段时显示「最近输出于…前」；无字段时不推测时间，空输出显示「尚无输出，正在等待命令返回」。输出推送保留每秒节流，并补发窗口内最后一次更新，避免命令随后静默时界面停留在旧输出。

默认面板收成一行状态栏，只展示状态图标、操作说明、计时或命令数以及展开箭头；长标题省略，悬停和展开后可读完整内容。点击整行或键盘激活后，在有高度上限的滚动区域中查看等待提示、完整操作说明、最近输出和原命令。切换会话时恢复默认收起状态。命令展示最多 8000 字符，超过时明确标注；原始进程登记仍保存原命令。等待提示简化为「完成后自动继续」，输入框说明「可继续输入，发送后排队…」。停止操作统一使用输入框现有入口，状态面板不再增加重复按钮。

本轮验证基线：`4e6f51707269cd4152ed7da9cd4fc00c21ca12c1` 加工作区改动。环境为 macOS 26.5.1 / arm64、Node.js 22.22.3、Electron 44.0.0（应用内 Node.js 24.18.1），应用代码版本 0.2.6。保留工作区已有的 `docs/requirements/cloud-bot.md`，没有变更依赖。

- `npm ci`；本机 Electron 二进制未就绪时使用其官方 `node node_modules/electron/install.js` 安装脚本补齐。
- `node --test src/main/agent/background-commands.test.mjs src/main/agent/gate/command-execution.test.mjs src/main/agent/gate/file-tools.test.mjs src/main/agent-runtime/resource-leases.test.mjs src/shared/conversation-status.test.mjs`：29 项通过。
- `npm run build`、`node scripts/check-spacing.mjs`、`git diff --check`：通过。
- `node scripts/verify-background-commands.mjs`。
- `HEMI_DEV_PORT=5187 npm run dev:renderer`，然后 `VITE_DEV_SERVER_URL=http://127.0.0.1:5187 node scripts/verify-background-commands.mjs`。

界面回归在全新临时 `HEMI_USER_DATA_DIR` 中，走真实 renderer → IPC → Pi SDK → 本机 Shell，外部模型由本地合成响应替代。覆盖说明与输出时间的传递、renderer 重载、后台结果续跑一次、资源等待、唯一停止入口回收进程、无说明与无输出回退、键盘展开详情以及 375/768/1440 宽度。多命令与超过一小时的计时使用明确的展示边界样本注入真实 flow/renderer，不冒充第二个真实命令或一小时实测。

截图和两种 renderer 的结果位于 `.visual/workflow/vision/background-commands/{dev,built}/`，本轮视觉结论见 `.visual/workflow/vision-report-background-display.md`。开发性能浮层通过其现有移动控件移开后验证停止点击；未修改浮层。应用目前仅支持 light 模式，未做深色测试；未运行全套测试、Windows 真机验证、打包安装或发版。

后续紧凑样式验证使用相同基线和环境：重新执行 `npm run build`、间距检查和两种 renderer 的真实命令回归。默认面板在 375/768/1440 宽度均为 34 CSS px；改动前分别为 136/100/100 CSS px。多命令与资源等待默认同样保持一行；展开总高度不超过 260 CSS px，切换会话不继承展开状态。前后截图与测量记录见 `.visual/workflow/vision/background-compact/before/`、两种 renderer 的 `report.json` 以及 `.visual/workflow/vision-report-background-compact.md`。本轮仅修改展示组件和验证，不重复运行前一轮已通过的后台执行测试。

## 验证

基线及验证 HEAD：`e0b97054cf2845736c52dd434422a2d9430cd890` 加本次未提交改动。环境：macOS 26.5.1 (25F80)、arm64，Node.js 22.22.3，Electron 44.0.0（应用内 Node 24.18.1）。保留仓库已有其他未提交工作；没有新增依赖。

- `npm ci`
- `npm test`：1519 个测试全部通过，包含真实 Shell、真实 Pi SDK、取消后的延迟副作用、失败/超时结果、旧目标失效、后台租约保留和子 agent 看门狗。
- `npm run build`：TypeScript 与 renderer 构建通过。
- `node scripts/check-spacing.mjs`、`git diff --check`：通过。
- `node scripts/verify-background-commands.mjs`
- `HEMI_DEV_PORT=5187 npm run dev:renderer`，然后 `VITE_DEV_SERVER_URL=http://127.0.0.1:5187 node scripts/verify-background-commands.mjs`

两个 renderer 的回归均走生产 renderer → IPC → runtime → Pi SDK → 真实本机 Shell → 完成续跑。仅用本地 HTTP 服务替代外部模型，目录选择器返回测试目录；每次均使用新 `HEMI_USER_DATA_DIR`，不读取个人凭据或历史。覆盖独立工作区并发、同工作区排队、重载接回、自动续跑恰好一次及 UI 停止回收真实进程。截图覆盖 375/768/1440 宽度。应用当前没有系统深色主题，未添加独立深色样式。

证据位于 `.visual/workflow/vision/background-commands/{dev,built}/`，视觉检查记录为 `.visual/workflow/vision-report-background-commands.md`。未打包、安装或发版；Windows 进程树和真实 Chrome 扩展并行未做本机复现。
