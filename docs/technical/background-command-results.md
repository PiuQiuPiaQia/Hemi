# 后台命令结果及时投递

## 问题与行为

命令超过前台等待时间后由 Hemi 继续持有进程。原实现只在整个 SDK 运行停止后等待并投递后台结果；模型持续调用工具时，即使后台命令已经失败，退出码和完整输出也不会进入后续请求，可能导致无效查询和耗尽根目标的请求预算。

Shell 的 `cd target && SCRIPT_DIR=... && command_a &` 还会把目录切换和变量赋值一起放进后台子 shell。后续 `command_b` 没有继承这些状态，不能把缺失的输出文件解释成“仍在执行”。宿主不改写任意 Shell 命令；bash 工具说明要求独立长命令分别调用并使用 `run_in_background`，由宿主管理并行和完成通知。

## 实现

- `command-scope.mjs` 提供按会话、根目标、generation、子任务过滤的非阻塞 `takeCompleted`。工具批次边界和整轮收口共用消费入口，每条结果只消费一次；仍在执行的进程继续留在宿主中。
- `hemi-session.mjs` 在现有 `finishTurn` 边界检查已完成命令。在整批工具结果之后，通过 SDK 的 context-only custom message 写入退出状态、输出及完整快照引用，随后继续同一次运行。下一次正常请求即可看到结果，不重置路由或根目标预算。
- 模型先结束而命令仍在运行时，保留原来的宿主等待与续跑路径。取消、优先交接、模型错误或失效目标不强制续跑；取消时清理进程和待投递结果。
- 通知明确标记为宿主观察，保留实际失败，不自动重试有副作用的命令。

## 验证记录

- 日期：2026-10-26。
- 基线提交：`4af7ccbe70f9ffcd13854a8868ca034825e6e76d`，验证对象为该提交之上的未提交工作区；保留已有的原生记忆等无关改动。
- 环境：macOS 26.5.1、Node.js 22.22.3、Pi SDK 1.3.0。使用全新临时 `HEMI_USER_DATA_DIR`，测试会话、进程和存档另在各自临时目录中隔离；模型服务为本机合成 HTTP endpoint，不使用真实凭据或用户会话。
- 先用真实 Pi SDK 与 Shell 复现缺陷：修复前的两项用例在下一次请求中看不到后台退出状态，修复后通过。

定向回归命令（54 项通过）：

```sh
node --test src/main/agent/hemi-session.test.mjs src/main/agent/main-agent.test.mjs src/main/agent/gate/command-execution.test.mjs src/main/agent-runtime/run-journal.test.mjs
```

覆盖后台成功与失败、多个命令汇总、仅投递一次、原始工具消息顺序、模型先停止后的宿主等待、取消清理、跨根目标与子任务隔离，以及 OpenAI Completions 和 Anthropic Messages 两种协议。生产 `createAgentRuntime`、真实 Shell、请求事实库及 Pi 原生存档的集成用例验证：三次正常请求在同一个三次预算内完成，保留失败命令和完整输出引用，关闭并重建运行时后恢复会话，旧命令不重复执行。

以下检查也通过：

```sh
node --check src/main/agent/hemi-session.mjs
node --check src/main/agent/gate/command-scope.mjs
node --check src/main/agent/gate/file-tools.mjs
git diff --check
```

未运行全量测试、Electron 界面或设备回归；此次未改动 IPC 与 renderer 生命周期。未验证 Windows 的实际进程行为或真实外部模型是否遵循提示；运行时投递保证不代表模型一定正确处理错误。未发布安装包，已安装应用需在包含本修复的版本中生效。

## 2026-10-28：主／子 agent 统一等待与防空转

后台等待规则由 `background-wait.mjs` 提供，在主／子共用的 `hemi-session` 系统提示、bash 工具说明和后台回执中使用同一正文。没有独立工作时只输出简短说明并结束生成，不能用 echo、printf、sleep、true 等占位调用保持模型运行。

`command-scope` 在启动 Shell 前，按 conversationId、rootRunId、generation 和 taskId 核对是否有所属后台结果尚未收口。只对单条、字面量的占位等待命令返回 `waiting-background / actionState:not-executed`，不创建进程。工具结果以 `isError:false / terminate:true` 让出本次 SDK 生成，不把等待记为失败、成功或根目标完成。SDK 仅在整批工具均要求让出时结束生成；混合批次中的独立工作仍执行并进入后续请求。外层 `prompt` 等待后台真实终态，沿原归属和预算投递一次完成通知后续跑，取消沿用既有进程树清理。

识别器保留重定向、管道、复合脚本、通配展开、变量和命令替换，不改写任意 Shell。普通输出命令、没有所属后台工作的命令继续正常执行。它是保守的防空转处理，不是任意脚本或进程轮询检测器。

验证基线为 `487743f1b5d5b7a960d75d46a37823454bb05870` 上的未提交工作区，保留已有改动。环境为 macOS 26.5.1、Node.js 22.22.3、Pi SDK 1.3.0；所有进程、会话、账本及上下文快照使用临时目录，模型服务为本机合成 HTTP endpoint，不使用真实凭据或用户会话。

以下定向回归 69 项通过，另通过相关文件的 `node --check` 和 `git diff --check`：

```sh
node --test src/main/agent/background-wait.test.mjs src/main/agent/background-commands.test.mjs src/main/agent/hemi-session.test.mjs src/main/agent/main-agent.test.mjs src/main/agent/gate/command-execution.test.mjs src/main/agent/gate/file-tools.test.mjs
```

新增回归用真实 Pi SDK、Shell、命令事实库和原生会话条目验证：OpenAI Completions／Anthropic Messages × 主 agent／fixer 共四种组合均在第一次占位批次后进入宿主等待，期间不再发请求或创建占位进程；后台 exit=7 的真实失败只交回一次，保留根目标与子任务归属。另覆盖混合批次的独立文件写入、普通 echo、让出后的取消及既有后台生命周期。未运行全量测试、Electron 界面、Windows 真机或真实外部模型回归；未发版或重启正在运行的实例，新会话层代码需要在更新后的进程中加载。

## 2026-10-28：后台命令与运行恢复使用真实终态

SDK 的 bash 调用返回“已转后台”只表示宿主已接管命令，不能视为命令成功。命令事实库、模型完成通知和界面状态分别消费同一个宿主命令的生命周期：

- `command-scope` 在进程退出、清理与结果持久化完成后发布终态。`hemi-session` 将后台受理和真实完成按宿主 `commandId` 关联；完成早于 SDK 受理回执时，先发布受理再发布终态。模型提供的短工具调用 ID 可以重复，不能替代宿主命令身份。
- 主对话、子 agent 对话和任务日志收到后台受理时保持执行中；只有实际成功、失败或取消才收口。子任务的其他工具有各自的执行身份，某个后台命令结束不会清掉另一个在途工具。
- 输出仍从真实 stdout/stderr 增量进入活动快照。无新输出超过 30 秒时，收起栏显示“无新输出”，展开显示无输出时长。这里使用已有界面时钟，没有定时请求模型、轮询进程或伪造进度；无输出本身不等于失败，实际命令截止时间和取消机制继续负责收口。
- 重启恢复统一结束运行和仍在执行的工具、思考段、子任务及其历史执行，清除旧 activity。已经完成的操作、输出和文件交付保留，并以中性提示说明中断；同一份快照反复恢复不增加提示、不复活运行。
- 本地会话把仅涉及根运行的恢复也保存到磁盘；Bot 在控制器恢复后直接保存该权威快照，目录列表、会话详情与落盘状态一致。队列保留并暂停，受理结果不明的提交保持待核对，不自动重放命令或发送排队输入。

验证基线为 `487743f1b5d5b7a960d75d46a37823454bb05870` 上的未提交工作区，保留已有改动。macOS arm64，Node.js 22.22.3；真实 Electron 44.0.0（内置 Node 24.18.1）。所有会话、命令、账本及应用数据使用独立临时目录，模型为本机合成 HTTP 服务。

定向回归覆盖主／子 agent × OpenAI Completions／Anthropic Messages、真实 Shell 成功失败与取消、受理／退出竞态、重复工具调用 ID、并行独立工具、旧快照幂等修复、Bot 目录／详情／磁盘一致性和队列不重放。扩展回归覆盖会话、运行事实库、进程清理、Bot SDK 集成、控制器与流展示。`npm run build:sdk`、`npm run typecheck`、`npm run build:renderer`、spacing 和 diff 检查通过。

界面验证命令：

```sh
node scripts/verify-background-commands.mjs
HEMI_BACKGROUND_UI_MODE=dev node scripts/verify-background-commands.mjs
```

两种模式均使用实际 Electron → IPC → Pi SDK → Shell；验证后台受理持续执行、真实输出、完成只唤醒一次、取消清理，以及 SIGKILL 后重新启动：运行／工具／列表／磁盘恢复为中断，队列保留暂停，没有重放。375／768／1440 宽度均验证无输出提示与详情布局。截图和运行记录在 `.visual/workflow/vision/background-commands/{dev,built}/`。现有外观仅支持 light，未计为暗色验证；未运行全量测试、Windows 真机或真实外部供应商回归，未更新已安装应用或生产 Bot。

最终定向回归 240 项全部通过，开发版和构建版各 12 项界面检查通过。验证期间系统临时盘空间不足，界面数据转入独立外置盘临时目录；依赖 POSIX 权限的最终测试在独立 HFS+ 测试映像中完成，没有放宽断言。详细环境、测试统计与源文件 SHA-256 位于 `.visual/workflow/vision/background-commands/validation.json`，视觉结论位于 `.visual/workflow/vision-report-background-recovery.md`。
