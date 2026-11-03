# 目标恢复（goal-resume）宿主核心链路 · 实施与验证报告

日期：2026-11-03 · 基线 commit `de927301`（+ 工作树并行改动：pi-model / oauth-models / pi-chat / model-output-limit，本批未触碰）· macOS arm64 / Node 22.21.1 / Electron 44.0.0。

## 结论

宿主核心链路已按评审定稿实施并全部验证通过：用户显式 `goal-resume` 命令可将被停止/失败/中断的终态目标以「新建 root 接续」方式恢复（不复活旧 root、不清零累计预算），真实 Electron（dev 与 built renderer 双模式）跑通「运行 → 停止 → 恢复命令 → 续跑 → 完成」及「恢复进行中重复恢复被拒」「完成后重复恢复如实拒绝」。渲染层「继续任务」按钮接线属下一批，本轮只定型协议投影与命令。

## 改动清单

实现（8 个文件 + 2 个新测试文件 + 1 个新验证脚本）：

- `src/main/agent-runtime/run-journal.mjs`：新增 `findResumableGoal`（只读摘要：goalId/objective/phase/round/status/sourceRootRunId/nextAction/remaining/reason + unconfirmedWork/budgetExhausted 预判；goalId 缺省取最新链头）、`resumeGoal`（事务准入：资格 → 同 goal 活跃幂等拒绝 `goal-already-active` → 会话 busy → 未确认工作 `goal-unconfirmed-work` → 预算 `goal-budget-limit`；通过后新建 root 持克隆 goal，旧 root 经 `edit()` 标 continued）、`goalProjection`（flow 快照 goal 投影）。terminal 集合（第 7 行）未动；workflow root 被资格口径排除。
- `src/main/agent-runtime/core.mjs`：`resumeGoal(conversationId,{generation,runId,goalId})` 公开入口 + `goalResumeHostEvent`（恢复上下文模板：原目标/当前段/上次结束状态中文映射/剩余工作/下一步）。
- `src/main/ipc/llm.ipc.mjs`：适配层 `findResumableGoal` 效果；`start` 的恢复预检（停止屏障检查、账本准入、`goal-already-active` 幂等自闭合）；`executeChatTurn` 增加 `resume` 参数（无用户文本、不改写对话历史缓存、hostEvent 透传 runRootTurn）；`applyGoalStatus` 在 chat / 后台回合收口后追加 `goal-status` 事实。
- `src/main/services/conversation-controller.mjs`：`startRun` 支持 `resume`（continuationOf=来源 root、run-preparing 带 `resumeOf`/恢复摘要、`already-active` 幂等收口返回）；`commandGoalResume`（idle 且非 awaitingUser 受理；拒绝分支全部带中文 message；受理层 alreadyActive 幂等）；`goal-resume` 命令分支。
- `src/shared/conversation-flow.mjs`：快照 `goal: null` 字段；`metaOf` 携带 goal；`run-preparing` 恢复守卫（`continuationOf!==resumeOf` 拒 `invalid-resume`、同源在途拒 `stale-resume`）+ 恢复摘要投影（resumable:false）；`goal-status` 事实（无变化不递增 revision）。awaiting_user 续接守卫原样保留。
- `packages/conversation-flow/src/core/flow-window.mjs`：diff meta 数组加 `goal`（UI 收得到增量）。
- 协议类型：`packages/conversation-flow/src/core/protocol.ts` 定义 `GoalSummaryView` + `FlowSnapshotView.goal`；`types/api.ts` re-export（dist/index 权威投影入口）；`src/shared/protocol.ts` 以 `import('@hemi/conversation-flow')` 引用，不重复定义。dist 由 `npm run build` 重建。
- `src/main/bot/host.mjs`：命令白名单加 `goal-resume`（generation 检查路径沿用既有）。

测试：`run-journal.test.mjs`（恢复资格终态×goal.phase 矩阵、接续/幂等/beginGoal 幂等复用、拒绝矩阵、workflow/busy、continued 落盘断言）、`goal-driver.test.mjs`（恢复回合驱动：幂等复用、verifier 看到原目标、预算连续、完成收口）、`conversation-controller.test.mjs`（受理/拒绝文案/幂等/stop 竞态）、新增 `packages/conversation-flow/test/goal-resume.test.mjs`（归约 5 例）。

脚本：新增 `scripts/verify-goal-resume.mjs`（真实 Electron 链路：停止 → goal 投影 resumable → goal-resume → 恢复上下文进真实模型请求 → 续跑完成 → 账本接续形状 → 重复恢复幂等/拒绝 → 投影清空；报告与截图在 `.visual/workflow/goal-resume/{dev,built}/`）。`scripts/verify-desktop-goals.mjs` 增加 `PC_GOAL_RESUME` 场景；另有两处环境性修正（见偏差 5/6）。

## 设计与现实的偏差（均已在实现中标注）

1. **链头推导扩展**：`findResumableGoal`/`resumeGoal` 的「同 goal 活跃接续」判定把 `continued` root 也纳入链头 identity 推导——否则恢复成功后再次点击只能得到「没有可恢复的任务」而非「目标已在进行中」，幂等语义打折。受理层即可幂等返回 `{ok:true, disposition:'already-active'}`，账本事务兜底不变。
2. **resumeGoal 增加会话 busy 检查**（任务准入清单未列）：与 `beginRoot` busy 口径一致，防受理与事务之间其他目标启动的竞态；同 goal 幂等检查优先于 busy。
3. **goal 投影挂点**：适配层在 chat / 后台通道收口后异步追加独立 `goal-status` 事实（而非每条 run-closed 事实携带）；恢复受理的 `run-preparing` 直接带恢复摘要。controller 内部失败收口不更新投影，由下一次正常收口纠正。
4. **flow 恢复快照的 goal 不主动重算**：重启后从持久快照恢复，可能在极端情况下短暂展示过期投影；首次运行收口即纠正，受理层准入始终实时查询账本。
5. `verify-desktop-goals.mjs` 的 `import 'playwright'` 改为 `playwright-core`（本机只装 playwright-core，`_electron` API 等价），否则脚本无法运行。
6. `verify-desktop-goals.mjs` 的 jobs 场景对合成服务器响应加了延迟（首响应 500ms、后续 1500ms）：合成服务器即时响应会让回合在脚本轮询前收口，断言窗口不存在。该竞态经基线对照确认与 **HEAD+并行改动**（无本批实现）同点复现（`Timeout: backend progress review remains available`），属既有工作区问题，非本批回归；完整修复涉及旧断言语义，超出本批范围。

## 验证结果（真实退出码）

| 命令 | 结果 |
| --- | --- |
| `node --test src/main/agent-runtime/run-journal.test.mjs src/main/agent-runtime/goal-driver.test.mjs src/main/agent-runtime/root-goal.test.mjs src/main/services/conversation-controller.test.mjs` | 94/94 通过 |
| `cd packages/conversation-flow && npm test` | 110/110 通过 |
| `npm run build`（build:sdk + tsc --noEmit + renderer） | 通过（exit 0） |
| `node scripts/check-spacing.mjs` | spacing ok |
| `HEMI_USER_DATA_DIR=临时目录 node scripts/verify-goal-resume.mjs --dev` | 6 项 check 全 PASS |
| `node scripts/verify-goal-resume.mjs`（built renderer） | 6 项 check 全 PASS |
| `node scripts/verify-desktop-goals.mjs --dev`（基线对照：stash 本批实现后运行） | 与带本批实现同点失败（既有竞态，非本批回归；见偏差 6） |

真实链路覆盖的事实：停止后 `flow.goal.resumable=true` 且 goalId 指向停止的 root；`goal-resume` 受理后 `runs[].continuationOf/resumeOf` 指向来源 root；恢复上下文（宿主目标恢复 · 原目标/剩余工作）出现在真实模型 HTTP 请求中；恢复回合完成后新 root `completed`、`goal.id` 与 `continuedFrom` 保持接续、旧 root `continued`（含落盘验证）；恢复进行中重复恢复 `{ok:false,code:'busy'}`、完成后重复恢复 `{ok:false,code:'goal-not-resumable',message:'没有可恢复的任务。'}`；完成后 `goal` 投影清空。

## 过程中修掉的一个实现缺陷

真实链路首次运行暴露：`resumeGoal` 对旧 root 标 continued 时用了行内 mutation，而 journal-draft 只跟踪经 `edit()` 的行变更——内存状态被污染（单测误通过）、sqlite 不落盘。已改为 `edit(s,'roots',…)` 写入，并补「重开 journal 实例读文件仍为 continued」的持久化断言。

## 遗留缺口

- 渲染层「继续任务」按钮与语音路径未接线（下一批；`voice/page.tsx` 未触碰）。
- `desktop-goals` 完整多场景链路在本工作区存在与基线相同的 jobs 场景时序竞态（偏差 6），未在本批内修复；goal-resume 自身的端到端验证由新脚本完整覆盖。
- 恢复态的侧栏 `conversationStatus` 口径无需变化（idle+resumable 不是 running），未改动该文件。
