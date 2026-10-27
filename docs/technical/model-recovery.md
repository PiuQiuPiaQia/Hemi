# 模型会话自动恢复

## 2026-10-27：统一请求恢复所有者

受控主会话和子会话由 Hemi 的请求恢复器统一决定同候选重试、冻结候选链的向前切换、等待和终止。Pi agent/provider 的自动重试均关闭；虚拟模型路由只投影宿主选中的物理候选，不根据错误文案另开恢复路径。非受控 SDK 会话保留原策略。

HTTP 响应头、终态与错误分类分开记录。连接等待默认 60 秒，收到响应头后首个模型输出默认 5 分钟，后续有效流事件之间默认 5 分钟；策略随受理时的预算冻结。HTTP 200 后的首个输出超时记录为 `TIMEOUT / first-output`，不能称为连接失败。取消、鉴权、额度、输入、上下文、预算和未知错误不会触发网络恢复。供应商原始错误只在适配边界归一为结构化事实，调度不依赖展示文案。

未开始输出的暂时失败可按冻结顺序选择能力匹配且不重复的备用候选；已经输出的失败只在当前候选恢复。选择备用前先落盘恢复事件，并遵守同一绝对 30 分钟期限、`Retry-After` 和实际请求额度；切换不创建第二个恢复窗口，也不继承上一供应商的认证头。成功后同一根目标继续使用已选候选，新用户运行才重置为主候选。

恢复重发的是请求前的上下文。失败尝试的文字、思考和未提交工具调用不会进入成功历史；已经完成的工具结果保留，不重新执行。请求内的三个超时器负责模型等待，主/子会话的通用停摆检测不再提前掐断在途模型请求。请求迭代与取消信号竞争，即使供应商未及时结束 iterator，也能按原归属收口。持久化失败不作为模型网络错误重试。

子任务的持久 `taskId` 在派单 reservation 的同一原子事务中分配，贯穿任务档案、原生子会话 owner、回执、终态与报告 inbox；`t1` 等进程内编号仅为交互句柄。重放同一 reservation 返回同一身份，重启或续用子会话后的新派单取得新任务身份。旧记录保留，不把未知/中断伪写为完成，不自动重投旧副作用；只读恢复和新运行不再与旧短编号冲突。

### 本轮验证

测试基线为 `67fb7a70849a4bb11cebf59a709118b57c1932cb` 加本轮工作区；macOS 26.5.1 arm64、Node 22.22.3，Windows Server 2025 x64、Node 22.22.3。所有合成模型测试使用独立临时数据目录。

- `npm test`：1907 项，1895 通过、0 失败、12 跳过。覆盖 HTTP 200 后首输出超时、固定模型恢复、备用候选选择及根目标边界、完成过的工具不重复执行、持久化失败不重发、重启后任务身份和旧终态保留。
- `npm run build`、`npm run build:mobile`、`node scripts/check-spacing.mjs`、`git diff --check` 通过；构建保留既有 chunk 大小警告。
- `node scripts/verify-command-lifecycle-windows.mjs`：Windows 实机 21 项恢复/账本/重启身份测试、8 项命令生命周期、2 项 Host/SDK 交接、2 项引号与登记门禁均通过；另 2 项 POSIX 专属跳过。实际组件包守卫无需编译器即可执行，测试前后生产 Host 和已有 DSH 身份不变。
- `node scripts/verify-recovery-order.mjs`、`node scripts/verify-command-lifecycle-desktop.mjs`：开发和构建 Electron 均通过真实 IPC、模型恢复顺序、重载持久化及正常/停止/清理不明时的队列交接验证。
- `node scripts/verify-mobile-background.mjs`：开发和构建移动 renderer 在 320/375/390/768/1440、短屏、键盘遮挡、重连及系统深色偏好下通过；产品声明浅色外观。浏览器桥接使用真实 Host/SDK/后台命令，没有覆盖实体 iPhone 和原生 TLS。

忽略目录 `.visual/workflow/command-lifecycle/`、`.visual/workflow/vision/recovery-order/`、`.visual/workflow/mobile-background/` 保存实测结果和源码哈希；视觉复核记录为 `.visual/workflow/vision-report-bot-recovery.md`。

### 生产组件接入

同日已将 Windows Bot 从 0.2.22 更新至 **0.2.23**，源码指纹 `47ccbdc31f442e08e3c44095c21ea654fa751679d0e9d412d1cb43ef35f00f41`，tgz SHA-256 为 `662fea931935fb6c16211be15c2d5c13fd775630e7da31fa640b64a94bca6cb3`。桌面版本不变。等待原有工作正常结束后，经现有维护门禁及组件安装/回滚通路切换；实例身份保持不变，bootId 更新，Node 仍为 22.22.3。

维护前在远端私有目录完整备份并逐文件核验 1154 个数据/配置文件。上线后原文件仍在，4 个既有会话的历史、运行、待发送输入、草稿、附件、权限和原用量记录保持完整，11 个模型及原选择不变。检查期间用户又在原会话提交并完成一次新运行；验收按原记录逐项保留并允许合法追加，未用旧快照覆盖新增输入。现存 DSH 的进程出生身份与监听端口保持一致。上一组件由更新器保留；数据备份和原任务 XML 仍在私有维护目录，回滚应使用现有组件回滚通路并保留维护后新增数据。

部署报告在 `.visual/workflow/bot-recovery-update/deployment-report.json`。组件切换后的首次只读核验遇到 SSH 复用连接断开，重连后完成核验；没有因此再次安装或重放任何用户任务。

生产真实模型验收通过：专用临时会话沿用现有模型和路由配置，主代理派发 fixer 子任务，子任务执行唯一标记的 echo 命令后回报，主目标经独立校验落为 completed / complete。5 次实际 HTTP 请求均有终态，派单为 terminal，子任务使用新的持久 UUID，命令记录为 windows-job-v1 / finished / cleanupConfirmed:true。验收会话已删除，原会话和模型目录保留；证据为同目录 `live-canary.json`。

后续章节中的历史验证记录保留原基线；上述规则替代其中关于 60/15 秒首字门及 SDK 备用切换的旧描述。

实现日期：2026-10-23。采用已确认的 30 分钟恢复窗口和精简状态行，设计稿位于 `docs/design/session-recovery/v1/`。

## 行为

- 首次可恢复错误建立绝对截止时间：`firstFailureAt + 30 min`。依次等待 1、2、5、10、20、30、60 秒，随后每 60 秒尝试一次；不再以 3 次为上限。
- 请求、退避、离线和休眠均计入窗口。页面重载、切换会话和“立即重试”不会刷新截止时间。截止后不再自动发请求；已经正常生成内容的健康流按正常流程完成。
- 429 遵守 `Retry-After`；额度、鉴权、输入/配置错误、权限拒绝和预算限制不进入自动重试。普通网络错误和临时服务错误使用同一调度器。离线时只按原期限检查网络状态，不发 HTTP。
- 重试的对象是当前失败的模型请求：保持同一模型和请求前上下文，不重新提交整条用户输入。已完成的工具与附件不会重做或重复登记。失败请求的部分文字在替代输出开始时清除，不把两次独立生成拼接起来。
- SDK/provider 内层重试在受控通路中关闭，防止叠加次数或额外启动恢复窗口。受控恢复保持冻结的实际模型；这条通路不会另启 SDK 的备用候选切换。原有非受控 SDK 会话行为保持原策略。
- 所有真实 HTTP 尝试共享逻辑调用身份，分别写入原请求账本，并遵守现有总请求/费用预算。30 分钟是恢复上限，明确的预算或配置限制可以提前结束。
- “停止”取消原运行和在途 HTTP，取消退避定时器，暂停队列；旧回包、旧 generation、旧恢复 ID 都不能恢复任务。请求耗尽/到期也暂停后续队列。
- 进程内状态由主进程持有，并随 flow 快照保存。renderer 重载接回同一恢复身份；应用重启后只显示保留的记录，不自动重跑旧任务。

## 主要实现

`src/main/agent-runtime/model-recovery.mjs` 提供分类、`Retry-After` 解析、退避、绝对期限、可取消等待与手动唤醒。每个逻辑模型请求一个 owner；`attempt` 表示当前/下一次恢复序号，`attemptsMade` 记录实际开始的恢复尝试，离线检查不增加后者。

`usage-ledger.mjs` 在真实 fetch / SDK stream 边界执行恢复，同一上下文重发并逐次记账。首次请求等待首个有效输出最多 60 秒，恢复请求最多 15 秒且服从剩余窗口；有效内容开始后继续使用现有流停滞看门狗。恢复等待期间暂停旧的 5 分钟无事件看门狗，避免它提前结束合法的 30 分钟恢复。

`hemi-session.mjs` 转发恢复与请求边界事件。`conversation-turns` 与 `flow-parts-projection` 保存当前模型请求前的展示检查点，仅替换失败请求的文字/思考，保留此前步骤；已执行工具不参与重放。SDK 第二次 start 不创建重复助手消息。

`run-recovery` 归约事实带入运行快照，沿原 revision / generation 协议广播和持久化。`retryRecovery` 使用现有 flow command 通道，校验会话、运行与 recovery ID；手动唤醒和自动定时共享同一等待器，只允许一次在途尝试。

共享会话 SDK 的 `ModelRecoveryNotice` 渲染当前恢复状态：默认 40px、无边框、一个操作与详情箭头。恢复时保留可编辑草稿并阻止发送，提示先停止恢复；宿主仍防御性将并发输入入队。详情包含次数、剩余时间和有界状态记录；读屏只播报状态变化。成功反馈 3 秒后转为“恢复记录”，历史条目不保留每秒刷新定时器。

默认行仅显示状态、倒计时/次数、操作和详情箭头；删除“进度已保留”等重复说明。非暂时错误同样使用精简行，完整诊断默认折叠。到期行只提供一个重新开始入口，不再叠加输入区“继续任务”。**到期后的重新开始沿用已有手动重试语义，重新提交原消息**，详情明确说明；这不等于自动恢复失败请求，也不保证外部操作幂等。

## 验证记录

基准提交：`b31c949bc4f3920e961881cf979e5f1693ca8a38` + 本次工作区改动，未创建提交。环境：macOS arm64、Node v22.22.3、Electron 44、已安装 Pi SDK 1.3.0。没有修改依赖版本。

执行命令：

```sh
npm run build
npm test
node scripts/check-spacing.mjs
node --test --test-reporter=dot src/main/agent-runtime/model-recovery.test.mjs src/main/agent/model-recovery.test.mjs src/main/services/model-recovery-flow.test.mjs src/renderer/src/native-gate.test.mjs
node scripts/verify-model-recovery.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5186 node scripts/verify-model-recovery.mjs
node scripts/verify-turn-error-retry.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5186 node scripts/verify-turn-error-retry.mjs
```

最终完整测试套件 1678 项通过；文案精简后重新构建，并复验开发/构建 renderer 的实际恢复链和原型交互。完整套件首次发现 SDK 测试工具使用 URL pathname、导致中文路径未解码；以 `fileURLToPath` 修正这一行测试路径，四组 SDK 测试恢复。新增样式的键盘焦点按原生门禁挂到 `html.kb-nav`。

单元与 SDK 接缝覆盖完整 30 分钟的虚拟时钟退避（34 次基准尝试）、期限不刷新、429 冷却、离线/休眠、取消和晚到唤醒。另验证恢复后遇到永久错误、后续新请求的停滞看门狗仍正常工作。真实生产会话工厂 + 实际本地 HTTP 流验证“工具执行完成后下一次请求断流”：只执行一次工具；失败文字被替换；SDK 历史没有额外失败助手项；重试发出的上下文一致；实际请求分别记账且密钥不入账本。

开发和构建两种 renderer 均使用独立临时 `HEMI_USER_DATA_DIR`，以真实 IPC/controller/Pi/HTTP/flow 链验证：503 自动恢复、Retry-After、重载恢复身份/原输入/草稿、立即重试与旧命令去重、停止取消真实 socket、401 不自动重试、主进程时钟跨过 30 分钟不补发请求、三种窗口宽度、键盘展开详情。原手动重试脚本改用不可自动恢复的 401，继续验证附件、草稿、连点、切换、重载和应用重启。

证据：`.visual/workflow/vision/model-recovery/{dev,built}/report.json` 与同目录截图；原手动重试证据位于 `.visual/workflow/vision/turn-error-retry/`。测试浏览器/应用与临时服务均在结束后关闭。只使用合成文本、附件和密钥，没有读取安装版应用数据或请求外部模型。

剩余边界：30 分钟使用协调器虚拟时间及主进程时钟跳变验证，未实际等待 30 分钟；实际网络验证使用本地服务，未穷举远端供应商、物理断网/休眠设备。外部工具结果不明继续沿用现有宿主等待/核对逻辑，本功能不增加自动重放或替代人工核对。安装版和既有云端 Bot 需更新到包含此代码的版本后才生效。

## 2026-10-26：恢复记录的展示位置

原投影把 `run.recovery` 附在整轮回复的最后一段，因此恢复后继续输出时，“恢复记录”会跟着移动到末尾。现在首次 `run-recovery` 事实保存 `anchor: {itemId, afterPartId}`；后续重试、恢复、运行收口和快照持久化保留同一位置。共享投影在该位置生成稳定身份的独立恢复行，后续文字、工具和交付卡片继续按原流顺序展示。恢复期间不显示生成光标，恢复后的新输出正常显示光标；终态错误的完整详情仍只保留一份。

旧档没有锚点时，在首个 `startedAt >= firstFailureAt` 的输出段之前展示记录；没有可用段时间戳时保留原尾部兜底，无法精确补回当时未保存的位置。对用户提供的会话存档做了只读投影核对：恢复行位于恢复后的第一段思考之前，所有原有 flow part 身份及顺序保留，没有改写安装版存档。

验证基线：`4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加本次未提交改动；保留工作区并行的 Bot 配置与会话发送改动。环境：macOS 26.5.1 arm64、Node v22.22.3、Electron 44.0.0。执行：

```sh
npm run build --workspace @hemi/conversation-flow
node --test --test-reporter=dot src/shared/conversation-flow.test.mjs src/renderer/src/windows/voice/lib/flow-timeline-view.test.mjs src/main/services/flow-parts-projection.test.mjs src/main/services/model-recovery-flow.test.mjs
npm run typecheck
npm run build:renderer
node scripts/verify-recovery-order.mjs
node scripts/verify-model-recovery.mjs
# 另以临时 Vite 服务的实际地址设置 VITE_DEV_SERVER_URL，执行 verify-model-recovery.mjs。
```

56 项相关测试通过。新的 `verify-recovery-order.mjs` 自动启动开发和构建两种真实 Electron renderer，各使用全新临时 `HEMI_USER_DATA_DIR` 和合成本地 HTTP provider，验证工具执行后的真实 503、同请求重试、继续生成、renderer 重载、收口落盘、请求不重复，以及 1440/768/375 三种宽度；结束关闭应用和服务并删除临时 profile。既有恢复脚本在两种 renderer 继续通过立即重试、停止取消真实 HTTP、401、到期和键盘详情检查。未运行完整测试套件，未发版或更新既有云端组件。

证据：`.visual/workflow/vision/recovery-order/report.json`、同目录六张截图和 `.visual/workflow/vision-report-recovery-order.md`。本次没有新增样式、动画、依赖或原生组件；产品仅支持 light 模式，因此跳过 dark mode。实际网络仍使用本地合成服务，未请求外部供应商。
