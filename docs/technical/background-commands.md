# 后台命令与资源等待

## 执行语义

本机 `bash` 支持 `run_in_background: true`；普通调用默认前台等待 10 秒，超出后交回模型并继续在宿主中运行。`yield_ms` 可调整前台等待预算（0–120000），`timeout_ms` 是独立的进程硬超时（默认 30 分钟，最大 24 小时）。

模型可先做不依赖结果的工作。一次 SDK 生成结束后，宿主保留原目标，等待后台命令的完成 Promise。期间不持续调用模型或查询进程。完成结果以隐藏的 `hemi_background_command_result` 消息交回原会话，沿用其 rootRunId、generation、模型计划及请求预算。多条命令的完成结果按批消费；已消费的结果不会再次唤醒。

`prompt` 返回和 flow 的 `run-closed` 都发生在必要后台结果处理完之后。模型的一次生成结束不等于用户目标完成。等待期间同会话普通新输入仍遵守现有队列规则；用户可以停止或插队。其他会话可独立工作。

停止、插队替换、回卷、会话释放和应用退出会取消所拥有的命令，并确认进程树退出。唤醒前再次检查取消状态及执行归属，旧目标不再续跑。进程启动前仍须持久登记 PID、出生信息和随机归属标记；应用重启先清理旧命令，将旧目标按中断恢复，不自动重放命令。

这次后台执行覆盖本机命令（包含子 agent 的本机命令）；远端 SSH 工具保留原有前台执行、取消及超时语义。

## 锁的范围

- 普通 Bash／PowerShell 不申请工作目录租约；命令前台运行或转后台都不会阻塞其他会话对同目录文件的读取、写入或其他命令。文件工具仍按显式目标协调冲突读写，浏览器按会话使用 `browser:<owner>`，桌面使用交互资源租约。
- 后台命令仍由原目标跟踪进程、保存结果，并在退出后通知原目标继续；它不保留目录锁。共用目录不提供任意 Shell 写入隔离，需要隔离并发修改时使用独立工作目录。
- 进程清理未确认时拒绝原目标的后续执行，避免冒充已停止；不为其他会话留下整目录锁。

## 等待状态与输出

flow 的运行记录增加 `activity`，不新增第二个主运行或改变四态调度器：

- `running`：模型或工具在推进，可同时列出后台命令。
- `waiting-background`：SDK 已结束本次生成，宿主等待后台命令终态。
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
