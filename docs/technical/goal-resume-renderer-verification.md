# goal-resume 渲染层接线与目标横幅 · 验证报告

- 任务：voice 窗口两个继续入口改发 `goal-resume`；语音/文字「继续」受限转换；目标横幅 GoalBar；Bot 网页端恢复动作；双模式真实 Electron UI 验证。
- 基线：宿主核心链路已交付（`snapshot.goal` 投影、`goal-resume` 命令），见 `docs/technical/goal-resume-verification.md`。
- 测试提交：`de9273011222993a326ee93b81e6df21957c808`（工作树含本任务渲染层改动与并行批次）。
- 环境：macOS（darwin/arm64），构建/测试 Node v22.21.1（nvm），Electron 44.0.0（app 0.2.57，主进程 node 24.18.1），隔离 `HEMI_USER_DATA_DIR` 临时目录。

## 改动文件（仅渲染层 + 验证脚本；未动 src/main 与 packages/conversation-flow/src）

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/windows/voice/page.tsx` | `handleContinueStoppedTask` 改发 `goal-resume`（保留 resumeQueue 兼容）；`handleRetryTurn` 可恢复时优先 goal-resume、否则回退重发原输入；新增共用 `sendGoalResume`（被拒不弹错、非 busy 轻提示 message）；`handleSubmitText` 与语音定稿 `submitTurn` 的白名单受限转换＋本地回显（`goalResumeEchoes` 并入 transcripts，切会话清空） |
| `src/renderer/src/windows/voice/lib/goal-resume-phrase.ts`（新） | 白名单常量 `GOAL_RESUME_PHRASES`（继续/继续任务/继续上次任务/接着做/接着干）＋纯函数 `isGoalResumePhrase`（trim 后全等，不做包含/前缀匹配） |
| `src/renderer/src/windows/voice/lib/goal-resume-phrase.test.mjs`（新） | 纯函数单测：精确命中（trim 容差）、近似串全部不命中、宽度/大小写不折叠 |
| `src/renderer/src/windows/voice/goal-bar.tsx`（新） | GoalBar 组件：`goal` 存在且（resumable 或活跃）时渲染一行「objective（截断）＋状态短语（已停止·可恢复／进行中·第 N 轮）＋恢复按钮」；goal 为 null 不渲染；无倒计时/进度条 |
| `src/renderer/src/windows/voice/voice-screen.tsx` | 新 props `goal`/`goalActive`/`onGoalResume`；GoalBar 挂在对话流之后、回合错误行之前（对话区/输入区之间） |
| `src/renderer/src/styles/037-desktop-conversation.css` | `.h24-goal-bar` 系列样式：可恢复态轻琥珀底、进行中中性；全部走既有 token（`--sp-*`/`--r-md`/`--fs-12`/`--warn-200`/`--accent` 等），`@container (max-width: 480px)` 窄窗换行 |
| `src/renderer/src/windows/bot/page.tsx` | 会话详情 VoiceScreen 传 `goal`/`goalActive`/`onGoalResume`（既有命令通道发 `goal-resume`，出错走既有 setError 提示；不改布局） |
| `scripts/verify-goal-resume.mjs` | 扩展渲染层场景（见下）；合成模型服务器改为多 marker（`stage-<marker>.txt`/`proof-<marker>.txt`）支持同会话多轮目标；恢复回合判定从「全量 includes」改为「最后一条 user 消息含宿主恢复注入」（历史残留会误判） |

## 验证命令与真实结果（退出码均为真实读取）

| 命令 | 结果 |
| --- | --- |
| `npm run build`（Node 22.21.1） | exit 0（build:sdk → tsc --noEmit → vite build 全过） |
| `node scripts/check-spacing.mjs` | exit 0，`spacing ok` |
| `node --test src/renderer/src/windows/voice/lib/goal-resume-phrase.test.mjs` | exit 0，3/3 pass |
| `node --test src/renderer/src/windows/voice/lib/*.test.mjs` | 237/238 pass；1 个失败为 `flow-timeline-view.test.mjs`「terminal recovery retains full error details…」，其 import 链（`src/shared/conversation-flow.mjs`、`src/main/services/flow-bootstrap.mjs`）均为宿主核心批次已修改文件，本任务未触碰该链任何文件，判定与本改动无关（遗留缺口见下） |
| `node scripts/verify-goal-resume.mjs`（built） | exit 0，11 项 PASS，report `result=PASS` |
| `node scripts/verify-goal-resume.mjs --dev`（Vite dev server） | exit 0，11 项 PASS，report `result=PASS`（renderer=http://127.0.0.1:5173/） |

## 真实 Electron UI 场景（dev 与 built 双模式均过）

同一隔离实例内连续 9 个场景（前 5 项为宿主链路回归，后 4 项为本次渲染层）：

1. 真实目标运行中被停止：run stopped、账本 root cancelled 且目标未完成。
2. 停止后快照 goal 投影可恢复，goalId 指向停止的根目标。
3. `goal-resume` 直发命令路径：受理并启动恢复回合，continuationOf 指向来源 root，恢复上下文进入真实模型请求。
4. 恢复进行中重复恢复被拒（busy）。
5. 恢复回合续跑完成（`proof-PC_GOAL_RESUME.txt` 真实产物核对），旧 root 标 continued；完成后投影清空、重复恢复如实拒绝。
6. **目标横幅**：停止后 `.h24-goal-bar` 出现（`data-resumable='true'`）且带「恢复」按钮；**真实点击按钮**（非直发命令）启动 continuation run；续跑完成（`proof-PC_RESUME_UI.txt`）后横幅 detached。
7. **白名单外**：停止且可恢复时输入「继续，但换个思路」→ 按普通文本回合直发（模型请求收到原文、resumeContext=false）、不产生任何 continuationOf run。
8. **白名单命中**：输入「继续」→ 改发 goal-resume（新 run `continuationOf` 指向停止 root、不进入 pending 输入队列），原话「继续」以用户气泡回显在时间线（`.h24-user-bubble` 文本精确等于「继续」）；恢复回合续跑完成（`proof-PC_RESUME_TEXT.txt`）。
9. **普通输入回归**：无 marker 输入「继续，但换个思路这个说法只是普通输入」→ 走原文本回合（模型收到原文、账本 +1 个独立 root、不续接被恢复目标）。

截图与报告：`.visual/workflow/goal-resume/{dev,built}/`（`ui-goal-bar-resumable.png`、`ui-goal-bar-completed.png`、`ui-continue-whitelist.png`、`stopped-resumable.png`、`resume-completed.png`、`report.json`）。

## 设计取舍

- GoalBar 放在对话流与回合错误行同一层（滚动区外、输入区上方），与 `h24-turn-error`/修复条同一视觉层级；可恢复态轻琥珀底（与队列暂停条同语义：有件事等你拿主意），进行中中性安静。按钮复用「继续任务」的 accent 胶囊语言（`--accent`/`--r-full`）。
- 「继续任务」按钮（TurnQueueTray）与 GoalBar「恢复」并存但垂直分离：前者属队列语义，后者是目标状态的常驻行；两者共用 `sendGoalResume`。
- 白名单转换仅在 `goal.resumable && flow.phase==='idle' && 无附件` 时触发；被拒（如 budget 用尽）以输入区内联轻提示呈现 message，不弹错误对话框。
- 语音路径被拒时回退定稿边界（`lastSubmitCountRef`），原文不丢；文字路径接受轻提示后由用户重发。

## 遗留缺口

- `flow-timeline-view.test.mjs` 1 例失败依赖宿主核心批次工作区改动（`src/shared/conversation-flow.mjs`），需宿主批次收口；本任务文件不在其 import 链上。
- Bot 网页端「恢复目标」动作未做端到端真机验证（需远端 Bot 实例；任务口径为轻量接线，类型与命令通道均复用已验证的 VoiceScreen/GoalBar 路径，`tsc` 全量通过）。
- 截图已产出且 DOM 断言覆盖结构（横幅出现/消失、按钮存在与点击），像素级目检未做（本角色无图像输入）；样式全部复用既有 token 并过间距门禁。
