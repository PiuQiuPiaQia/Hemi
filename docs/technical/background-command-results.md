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
