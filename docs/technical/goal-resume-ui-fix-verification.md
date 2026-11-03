# goal-resume：入口收敛与回显排序验证

## 结果

本批要求的五条验证命令全部退出 **0**：构建与间距检查通过，单测 **9/9**，built / Vite dev 真实 Electron 验证各 **14 项通过**，两份报告均为 `PASS`、`errors: []`。已目检双模式的停止横幅、文字/语音首字前回显及完成态截图。

- 验证日期：2026-11-03（Asia/Shanghai）。最终 UI 运行：built 18:36:13–18:36:25；dev 18:36:34–18:36:49。
- 测试基线：`de9273011222993a326ee93b81de6df21957c808` **加当前未提交工作树**，不是仅测试纯净 HEAD。
- 环境：macOS 26.5.1 / arm64；命令行 Node **v22.21.1**；Hemi 0.2.57 / Electron 44.0.0（内嵌 Node 24.18.1）。dev renderer：`http://127.0.0.1:5173/`。
- 每次 UI 验证均创建全新的临时 `HEMI_USER_DATA_DIR`；仅合成模型响应、ASR 服务和静音采集设备。真实渲染器、IPC、目标运行、账本和文件写入链路未替换；未开启真实麦克风。完成后测试实例、服务和成功实例的临时数据均已清理。

## 两项修复及改动文件

**入口收敛。** `VoiceScreen` 已去掉旧的空队列「继续任务」入口及其 props；停止后的目标恢复统一由 `GoalBar` 的「恢复」按钮承担。`voice/page.tsx`、`bot/page.tsx` 均传入目标投影与恢复动作。有待发送输入时，队列仍保留 `resumeQueue` 的“恢复发送”语义，不与恢复目标混用。

**回显排序。** `createGoalResumeEcho` 冻结提交前的运行 ID 集合；`mergeGoalResumeEchoes` 将本地原话插在首个新运行之前，不再追加到投影末尾，也不重排权威时间线。文字与语音共用该路径，首字前占位和完成回复都位于用户气泡之后；会话与 generation 隔离防止回显串入其他会话或历史版本。

| 文件 | 状态与作用 |
| --- | --- |
| `src/renderer/src/windows/voice/page.tsx` | 前批实现，本轮保留：回显合并、文字/语音白名单转换、GoalBar 接线，移除旧恢复处理器 |
| `src/renderer/src/windows/voice/voice-screen.tsx` | 前批实现，本轮保留：移除旧按钮分支，目标横幅与待发送队列分工 |
| `src/renderer/src/windows/voice/goal-bar.tsx` | 前批实现，本轮保留：目标状态、单一「恢复」按钮、完成后隐藏 |
| `src/renderer/src/windows/voice/lib/goal-resume-echo.ts`、`goal-resume-echo.test.mjs` | 前批实现，本轮保留：时序插入与 6 项排序/隔离单测 |
| `src/renderer/src/windows/voice/lib/goal-resume-phrase.ts`、`goal-resume-phrase.test.mjs` | 前批实现，本轮保留：trim 后精确白名单与 3 项单测 |
| `src/renderer/src/windows/bot/page.tsx` | 前批实现，本轮保留：复用 GoalBar 与既有命令通道 |
| `src/renderer/src/styles/037-desktop-conversation.css` | 保留既有 token 与布局；本轮仅移除 `git diff --check` 提示的 EOF 多余空行 |
| `scripts/verify-goal-resume.mjs` | 本轮补完：实际调用旧入口缺席和回显顺序断言；接入恢复首字前挂起/释放；补齐语音场景与 ASR 清理；删除未使用变量，记录运行起止时间 |
| `docs/technical/goal-resume-ui-fix-verification.md` | 本轮新增验证报告 |

接手时脚本已有 `assertNoLegacyResume`、`assertEchoOrder` 和语音测试服务，但断言尚未调用、ASR 服务未关闭。以上是在阅读现状时发现并补完的验证缺口，不是重做渲染实现，也没有删除或放宽原断言。对 `src/renderer/src` 搜索 `queueStoppedIdle`、`onContinueStoppedTask`、`handleContinueStoppedTask` 均无命中。

本轮未编辑 `src/main`、`packages/conversation-flow/src`、`src/shared` 及指定的并行改动文件；这些目录的工作树差异指纹前后相同。保留现有界面层级和 token：横幅位于输入框上方，可恢复态为轻提示；没有另加恢复按钮、弹窗或新的视觉系统。

## 命令与真实结果

命令环境先执行 `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`。输出用 `tee` 留存，并启用 `pipefail`，退出码不是日志管道掩盖的结果。收尾清理后已复跑以下全部命令。

| 命令 | 最终结果 | 日志 |
| --- | --- | --- |
| `npm run build` | exit 0；SDK、TypeScript、Vite build 全通过 | [build.log](../../.visual/workflow/goal-resume/build.log) |
| `node scripts/check-spacing.mjs` | exit 0；`spacing ok` | [spacing.log](../../.visual/workflow/goal-resume/spacing.log) |
| `node --test src/renderer/src/windows/voice/lib/goal-resume-echo.test.mjs src/renderer/src/windows/voice/lib/goal-resume-phrase.test.mjs` | exit 0；9 pass / 0 fail | [unit-tests.log](../../.visual/workflow/goal-resume/unit-tests.log) |
| `node scripts/verify-goal-resume.mjs` | exit 0；14 项 PASS | [built 日志](../../.visual/workflow/goal-resume/verify-built.log) · [原始报告](../../.visual/workflow/goal-resume/built/report.json) |
| `node scripts/verify-goal-resume.mjs --dev` | exit 0；14 项 PASS | [dev 日志](../../.visual/workflow/goal-resume/verify-dev.log) · [原始报告](../../.visual/workflow/goal-resume/dev/report.json) |

另已通过 `git diff --check` 与 `node --check scripts/verify-goal-resume.mjs`。构建仍有大于 500 kB 的 chunk 提示；Node 输出 SQLite experimental warning，均未造成失败。

## 双模式 UI 覆盖

以下断言在 built / dev 中全部执行并通过：

1. 停止后横幅可见、`data-resumable=true`、只有一个横幅「恢复」按钮；旧「继续任务」按钮和 `.h24-queue-resume-only` 均不存在。
2. **真实点击**横幅「恢复」后，生成接续原目标的运行；核对真实 proof 文件内容，续跑完成后横幅从 DOM 移除。
3. 输入「继续」触发 `goal-resume`，不进入普通 pending 输入队列。合成模型在首字前显式挂起，等待真实占位行出现后，检查用户回显与当前运行行 **DOM 相邻且先后正确**、用户气泡 bottom ≤ 回复行 top、活动指示都在原话之后。完成后再验证位置不变。
4. 停止可恢复时输入「继续，但换个思路」仍作为普通文本抵达模型，不产生原目标的 continuation；普通文本回合回归也保留独立 root。
5. 附加验证：本地 ASR 定稿「接着做」经真实通话入口触发目标恢复；回显在占位及输入区通话活动指示之前，续跑完成、横幅消失，测试通话正常挂断。
6. 保留原有真实链路断言：停止状态、账本接续、恢复上下文、运行中重复恢复拒绝、完成后重复恢复拒绝等。

最终 `report.json` 各保存 4 组 `echoOrder` 几何与 DOM 证据。文字首字前回显/回复索引均为 **10 → 11**，语音为 **9 → 10**；两模式首字前与完成后均通过。

## 截图清单与目检

所有截图位于 `.visual/workflow/goal-resume/{built,dev}/`，每种模式 8 张，尺寸 2588 × 1634。

| 截图 | built | dev |
| --- | --- | --- |
| 首个目标停止可恢复 `stopped-resumable.png` | [查看](../../.visual/workflow/goal-resume/built/stopped-resumable.png) | [查看](../../.visual/workflow/goal-resume/dev/stopped-resumable.png) |
| 命令恢复完成 `resume-completed.png` | [查看](../../.visual/workflow/goal-resume/built/resume-completed.png) | [查看](../../.visual/workflow/goal-resume/dev/resume-completed.png) |
| 单一恢复横幅 `ui-goal-bar-resumable.png` | [查看](../../.visual/workflow/goal-resume/built/ui-goal-bar-resumable.png) | [查看](../../.visual/workflow/goal-resume/dev/ui-goal-bar-resumable.png) |
| 点击恢复完成、横幅消失 `ui-goal-bar-completed.png` | [查看](../../.visual/workflow/goal-resume/built/ui-goal-bar-completed.png) | [查看](../../.visual/workflow/goal-resume/dev/ui-goal-bar-completed.png) |
| 「继续」在「正在想」之前 `ui-continue-whitelist.png` | [查看](../../.visual/workflow/goal-resume/built/ui-continue-whitelist.png) | [查看](../../.visual/workflow/goal-resume/dev/ui-continue-whitelist.png) |
| 「继续」仍在完成回复之前 `ui-continue-completed.png` | [查看](../../.visual/workflow/goal-resume/built/ui-continue-completed.png) | [查看](../../.visual/workflow/goal-resume/dev/ui-continue-completed.png) |
| 语音回显在活动指示之前 `ui-voice-continue-whitelist.png` | [查看](../../.visual/workflow/goal-resume/built/ui-voice-continue-whitelist.png) | [查看](../../.visual/workflow/goal-resume/dev/ui-voice-continue-whitelist.png) |
| 语音恢复完成 `ui-voice-continue-completed.png` | [查看](../../.visual/workflow/goal-resume/built/ui-voice-continue-completed.png) | [查看](../../.visual/workflow/goal-resume/dev/ui-voice-continue-completed.png) |

已实际打开两模式上述 6 类 `ui-*` 截图目检：横幅在输入框上方，无重复恢复入口；「继续」/「接着做」气泡先于「正在想」，完成回复仍位于其后，完成态无横幅。dev 右下角为既有性能 HUD，built 无此覆盖层。

## 已知问题与验证边界

- 按本轮交接事实记录：`flow-timeline-view.test.mjs` 有 1 例既有失败（`terminal recovery retains full error details…`），纯净 HEAD 同样失败，**不是本批引入**。本轮未修改、未重跑该测试，不将它计入上述 9 项单测；也未运行全量测试套件。
- 未验证远端 Bot 实例的端到端恢复、真实模型供应商、真实麦克风/ASR 服务，以及其他主题、窄窗和触控环境；Bot 接线经过全量类型检查。本次截图目检范围为默认桌面尺寸、classic/light。
- 本轮要求的验证无剩余失败项，无在途测试服务。这里的“通过”仅指上述明确覆盖范围。

## 补充裁决：目标横幅只在可恢复时出现（2026-11-03 19:5x）

用户目检发现：目标正在跑的恢复回合里，横幅仍以「进行中」+ 原目标原话常驻输入框上方。该行在运行中没有任何新信息（原话与进展时间线里已有），反而让用户不知道这条是什么，与「恢复入口只在该出现时出现」的初衷相悖。

修复：`goal-bar.tsx` 渲染条件收敛为 `goal?.resumable` 单一门槛，「进行中」分支与 `active`/`goalActive` prop 全部删除（voice-screen、voice/page、bot/page 三处传递同步清理）；恢复回合的活动状态由时间线内既有的 RunActivity（如「继续处理剩余工作」/「正在想」）表达，不再由横幅重复。

验证（改动后重跑，真实退出码）：

| 命令 | 结果 |
| --- | --- |
| `npm run build` | exit 0 |
| `node scripts/check-spacing.mjs` | spacing ok |
| `node --test …/goal-resume-echo.test.mjs …/goal-resume-phrase.test.mjs` | 9/9 通过 |
| `node scripts/verify-goal-resume.mjs`（built） | exit 0，14 项 PASS |
| `node scripts/verify-goal-resume.mjs --dev` | exit 0，14 项 PASS |

复跑后截图已覆盖：`ui-goal-bar-resumable.png` 停止态仅一条米色横幅（目标+「已停止 · 可恢复」+「恢复」）；`ui-continue-whitelist.png` 恢复回合进行中不再出现目标横幅（只余时间线内的「正在想」与「继续处理剩余工作」）；`ui-goal-bar-completed.png` 完成态无横幅、无按钮。

## 补充裁决二：续跑轮的「继续处理剩余工作」活动行不再投影（2026-11-03 20:0x）

用户追问「继续处理剩余工作又是什么东西」。来源是 `packages/conversation-flow/src/components/run-activity.tsx` 的 `PHASE_TITLES.continuing`：宿主目标续跑轮（`core.mjs` 里 `setActivityPhase('continuing')`）会把它渲染成输入框上方的一行活动标题。

它标记的是调度层事实——「这一轮是宿主的续跑轮，不是用户新回合」。对用户没有增量信息，且恢复回合里会与「正在想」并排出现，形成两条并列状态（同一问题的第二次出现：把内部阶段词投影成用户文案）。

修复：从 `PHASE_TITLES` 删除 `continuing`，并在原处加注释说明为何不投影。该轮若确有后台命令/资源等待，仍由既有的 jobs/resources 分支正常展示，不丢失真实状态。`compacting / verifying / waiting-subagents / finishing` 保留——它们对应用户可感知、可行动的真实阶段。

复验（改动后重跑）：`npm run build` exit 0、`node scripts/check-spacing.mjs` spacing ok、`node scripts/verify-goal-resume.mjs` 与 `--dev` 均 exit 0 / 14 项 PASS。截图 `ui-continue-whitelist.png` 已更新：恢复回合进行中只剩「正在想」，无额外活动行。
