# 模型会话自动恢复

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
