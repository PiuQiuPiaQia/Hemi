# 后台任务的查询、核验与正常收口

实现基线为 `e34326c4dc68a0b3f9df7e5091e98a8e5b7ece7f` 加本次工作区改动。参考本地 ZCode `aac47556` 的 TaskOutput / TaskStop、后台通知与工作流停滞观察，以及已安装 DSH 的 `0.2.0-rc.2` jobs / tool-jobs 组件的归属隔离、有限等待与输出游标。没有复制第三方实现，没有新增依赖，也不识别某种命令、网址或报错文字。

## 控制与等待

- `job_list` 允许主 agent 列出同会话当前及此前目标的后台命令，子任务仅可访问自己的命令；`job_output` 通过命令 ID 读取状态和增量输出，可有限等待，最长 30 秒。等待到限返回当前快照，原命令继续，硬截止时间不变。
- `job_kill` 仅取消指定命令，并等待进程清理确认。其他命令继续运行。进程清理未确认使当前任务失败并暂停其自动发送，不伪写为成功，也不锁住其他会话或用户后来明确发起的新任务。
- 命令按照 conversationId、rootRunId、generation、taskId 复核归属，不能越过会话、代次或子任务控制边界。观察者读取不会消费完成通知；模型读取已完成结果后不会再重复收到同一完成事件。
- 模型结束本轮回复后，所属后台命令继续运行，原目标进入 `waiting_background`，本轮 flow 收口为 `awaiting-background` 并释放前台。此路径不调用完成检查者选择等待命令；同步等待由主模型显式调用有界 `job_output`。真实完成事件通过现有对话调度器排队，空闲后按原目标和预算继续处理；显式检查进展也走事件回合，静默不触发周期性模型轮询。详细规则见 [后台命令与对话回合](background-commands.md)。
- 静默不是失败证据。主 agent 收到观察后，可读取任务输出并做只读核验，再决定继续等待、停止已不需要的工作，或提出必要的用户接手请求。没有周期性模型轮询，不自动重试原命令，也不延长原截止时间。

共享对话组件和桌面输入区默认只显示一行任务状态；展开后仅保留最近输出和每条任务的“停止”按钮。只读界面隐藏停止按钮。查询输出、显式核验与有限等待仍由后端工具及原 flow command 通道提供，继续校验当前 run / generation 和设备写入权。新输入继续遵守既有排队与显式抢占语义。

## 输出与状态

命令结果保留最近 8 MiB，后台可查询流保留最近 256 KiB；两者都按实际输出推进。后台读取返回绝对字节偏移、next、total、earliest 和 lossy，过期输出不会静默伪装成完整日志。读取按 UTF-8 边界分段，界面日志与模型游标互不消费。高输出量时使用有界缓冲和惰性输出投影，避免每个数据块重建全部历史。

Bot 列表、桌面实时缓存与共享投影统一显示后台等待和等待用户。运行时长、最后输出时间、硬截止时间仍保留在后端事实中，界面不再重复展开这些计时或命令全文；单条及多条命令静默 30 秒后，状态行显示“暂无新输出”。没有可核对的下载进度时不生成百分比。

显式外部阻塞仍以 `blocked` 正常结束。连续无进展和目标总预算耗尽以 `partial` 结束，分别保留 `halted.kind = no_progress / budget_limited`、原因、剩余事项和后续动作；已耗尽预算的用户答复不会再次请求模型。真正的模型、持久化、校验格式或清理异常继续失败，目标阶段记录为 failed，避免用 blocked 包装异常。取消优先，旧结果不能复活已停止目标。

`awaiting-user` 进入新结果提醒范围，后台时使用“等待你的回复”通知。Bot 桌面实时流只通知新收口；重连快照和重启不会重播旧通知。现有历史记录、待发送输入与等待用户的问题不做迁移或重放。

## 命令故障的影响范围（2026-10-30）

继续使用现有共享 Runtime、每会话执行器和命令事实库，不新增工作区进程、恢复队列或永久会话锁。

- 运行中的命令清理或持久化异常由当前任务失败收口，执行器停止本任务后续操作并释放。用户明确发起下一任务时，按原历史重建执行器；待发送输入继续保持暂停，不因恢复自动执行。
- 启动恢复逐条核对旧命令。只清理身份可确认的进程；无法确认的命令保留 `unknown / cleanupConfirmed:false` 和原因，并记录所属会话。继续检查其他记录和启动运行时，不重跑命令，不把历史未知状态变成全应用启动失败。
- 命令登记晚于进程收尾时，保存真实清理结果；不能无条件将已经确认退出的命令改成未知。
- 事实库读取、结构校验或写入失败仍向上报错。这是共享存储故障，不按单条命令异常忽略。

本次验证基线为 `de447c7f603b1e4cda00fa50a833cafe1b717532` 加本次修改及工作区原有未提交改动；macOS arm64 / Node 22.22.3 / Electron 44.0.0。原有模型传输、OAuth 等改动保留，未提交、发布或替换安装版及生产 Bot，也未修改个人会话数据。

执行与结果：

```sh
node --test src/main/agent-runtime/owned-processes.test.mjs src/main/agent/gate/command-lifecycle.test.mjs src/main/agent-runtime/command-isolation.test.mjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test src/main/agent-runtime/command-isolation.test.mjs src/main/agent-runtime/owned-processes.test.mjs src/main/agent/gate/command-lifecycle.test.mjs
HEMI_USER_DATA_DIR=<新的临时目录> npm test
node --test --test-name-pattern='GLM 真实 SDK 与恢复器' src/main/services/bigmodel-coding.test.mjs
git diff --check
```

初始定向 13 通过、1 个 Windows 场景跳过；补充事实库损坏场景后，Electron 定向 14 通过、1 跳过。真实 Runtime、Pi SDK、Shell 和事实库覆盖旧会话不存在时两个新会话执行命令、单条命令保存失败后其他会话继续、原会话执行器重建后明确新任务执行命令、取消先于登记完成、未知记录不妨碍另一受管进程回收、独立进程不被误杀，以及公共事实库损坏仍拒绝执行。只有模型 HTTP 响应和指定的一次保存失败使用合成输入。

全量首轮的 GLM 网络测试用 `/503/` 匹配整份记录，命中随机请求 ID 中的 `503`，同一断言导致父、子测试合计两项失败；该无关测试未修改，单独复验 5 项通过。第二轮完整 `npm test`：2168 项，2147 通过、21 跳过、0 失败，包含实际 Bot Host 的取消、逃逸输出持有者与队列暂停场景。最终将隔离测试的 Shell 验证命令改为跨平台 Node 命令后，Node 与 Electron 各复验 3 项通过；`git diff --check` 通过。

日志在 `.visual/workflow/command-isolation/`。未使用外部模型账号；没有渲染器或 IPC 改动，未执行 Vite／构建 renderer、Windows 真机或移动设备回归。

## 验证记录

环境：macOS arm64 / Node 22.22.3；桌面 Electron 44.0.0，使用新的临时 `HEMI_USER_DATA_DIR`；Windows x64 / Node 22.22.3。模型 HTTP 边界使用合成响应，实际 Host、Pi SDK、IPC、Shell、文件、命令守护、持久化及事件流均使用真实实现。

- 独立候选源码完整测试：1980 项，1967 通过、13 个平台场景跳过、0 失败。使用四个测试文件并发，避免时序敏感的流式指标基线在高负载下合并到同一毫秒；该原有用例另单独复验通过。
- 最终控制、命令清理、目标收口、Host/SDK 和桌面服务定向回归：67 项，66 通过、1 个 Windows 专属跳过、0 失败。
- `npm run build`、最终 SDK 构建、类型检查、移动 renderer 构建、spacing 及相关文件 diff 检查通过。移动类型检查发现的跨项目别名引用改为相对类型引用。
- `node scripts/verify-desktop-goals.mjs --dev` 与 `node scripts/verify-desktop-goals.mjs` 各八组：真实双后台命令、输出读取、手动核验、单条停止、另一命令继续完成、renderer 重载、无进展正常结束、等待用户答复、停止与迟到校验、blocked、真实校验异常。实际等待 30 秒核验静默标记，在 375 / 768 / 1440 截图复核。开发测试曾受同时重建 SDK 的热更新干扰，产物稳定后重新启动并通过。
- Windows 独立候选目录：117 项，115 通过、2 个平台场景跳过、0 失败；真实 Job 守护及清理确认通过，38315 个依赖目录项逐文件校验一致。测试等待真实首行输出，不假定进程启动速度。
- 额外真实命令探针确认：输出超过上限后，末尾 stderr 的失败原因和退出码仍被保留。

全量工作区还包含独立的使用记录页面改动；候选源码及云端包排除了这些无关改动。原工作区全量检查曾命中该未提交样式的既有焦点规则门禁，未修改这些样式。发布验收使用独立候选源码，完整结果如上。

证据在 `.visual/workflow/background-job-boundaries/`；桌面截图和报告在 `.visual/workflow/desktop-goals/{dev,built}/`。产品仅声明浅色外观；未新增动画，无 raster mockup 比较目标。

## 云端更新

候选组件为 `0.2.21.2`，build `e4c42f7372e9f295bc98d95a9b2587609a70af78ab26035d7fe65762239d316f`，归档 SHA256 `7eb6af0d4f0b8714c5c55d887581d9685a2ae27c3e89ceb54cf4306955870579`。2026-10-28 已从 `0.2.21.1` 切换到该组件。仅在空闲时进入维护，备份并逐文件校验 1395 个数据文件；切换后再次握手确认实际常驻版本与 build，Bot 已启用、活动任务数为 0、维护已解除。6 个既有会话的模型路由、草稿、附件、正文、待发送输入、等待用户的问题及凭据保持完整；目标会话保留原 awaiting-user 状态，没有重放克隆或改写历史。实际维护切换与数据保全结果记录在同目录 `deployment-report.json`。

本次只更新云端 Bot；桌面共享界面的新控制已在开发和构建 renderer 验证，安装版桌面及实体移动设备没有在本次任务中发布或替换。云端的静默核验、模型任务工具、状态与收口逻辑随组件更新生效，现有客户端可以接收核验产生的正常进度文本。未把外部账号登录、网络传输成功或生产回滚实际触发作为本次已验证结果。


## 展示简化（2026-10-28）

用户确认减少界面信息后，仅调整共享 RunActivity、对应样式和桌面验收脚本，后端、云端组件版本及模型任务控制接口保持原样。默认一行状态，展开只有最近输出、必要的并行任务名称与停止按钮；移除手动核验／读取按钮、时长、倒计时、命令全文及重复说明。资源排队没有命令输出时只显示状态行。

验收使用 `node scripts/verify-desktop-goals.mjs --dev --jobs-only` 和 `node scripts/verify-desktop-goals.mjs --jobs-only`，各自采用新临时应用数据，覆盖默认折叠、实际 30 秒静默、多宽度截图、展开内容精简、renderer 重载、单条取消不影响另一命令，以及后端查询和核验仍能调用。SDK 66 项测试、类型检查和 spacing 检查通过；未运行无关的完整套件，也未更新云端服务或发布桌面安装包。截图与报告在 `.visual/workflow/background-job-simple/{dev,built}/`。


## 本会话提交范围与验证（2026-10-28）

本次提交包含上述后台任务改动、简化后的界面，以及使用记录的手动刷新、格式化、Tooltip 与验证修正。另一会话同期修改的发送预显示和重连草稿锁逻辑留在原工作区，5 个共享文件按差异拆分，没有纳入本次源码快照。

在基线 `e34326c4` 加本次差异的独立临时源码副本验证，环境为 macOS arm64 / Node 22.22.3 / Electron 44.0.0，沿用本地已安装依赖，应用数据使用新的临时目录：

- `npm run build` 通过；完整单元与集成测试按标准测试入口同样的文件范围、4 文件并发执行：1983 项，1970 通过、13 平台跳过、0 失败。
- `node --experimental-strip-types --test src/renderer/src/utils/format-usage.test.ts`：14 项全部通过；spacing 和限定差异检查通过。
- `node scripts/verify-usage-history.mjs`：开发版和构建版均通过实际 renderer / preload / IPC / journal 链路，验证真实 usage:changed 广播不自动查询，手动刷新读取新增记录且只查询一次，以及分页、筛选、脱敏和键盘 Tooltip。375 / 768 / 1440 截图复核通过；窄屏标题与刷新控件换行排列。
- `node scripts/verify-desktop-goals.mjs --dev --jobs-only` 和 `node scripts/verify-desktop-goals.mjs --jobs-only` 均通过，再次验证默认折叠、真实 30 秒静默、展开只保留输出和停止、后端查询核验、重载与单条取消。

本轮提交验收证据在 `.visual/workflow/commit-session/`。本地提交不代表新的桌面或移动安装包发布，也未再次更新云端服务。
