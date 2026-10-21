# 后台命令与资源等待

## 执行语义

本机 `bash` 支持 `run_in_background: true`；普通调用默认前台等待 10 秒，超出后交回模型并继续在宿主中运行。`yield_ms` 可调整前台等待预算（0–120000），`timeout_ms` 是独立的进程硬超时（默认 30 分钟，最大 24 小时）。

模型可先做不依赖结果的工作。一次 SDK 生成结束后，宿主保留原目标，等待后台命令的完成 Promise。期间不持续调用模型或查询进程。完成结果以隐藏的 `hemi_background_command_result` 消息交回原会话，沿用其 rootRunId、generation、模型计划及请求预算。多条命令的完成结果按批消费；已消费的结果不会再次唤醒。

`prompt` 返回和 flow 的 `run-closed` 都发生在必要后台结果处理完之后。模型的一次生成结束不等于用户目标完成。等待期间同会话普通新输入仍遵守现有队列规则；用户可以停止或插队。其他会话可独立工作。

停止、插队替换、回卷、会话释放和应用退出会取消所拥有的命令，并确认进程树退出。唤醒前再次检查取消状态及执行归属，旧目标不再续跑。进程启动前仍须持久登记 PID、出生信息和随机归属标记；应用重启先清理旧命令，将旧目标按中断恢复，不自动重放命令。

这次后台执行覆盖本机命令（包含子 agent 的本机命令）；远端 SSH 工具保留原有前台执行、取消及超时语义。

## 锁的范围

- Shell 使用其真实工作区的 `file:<cwd>` 写租约，浏览器按会话使用 `browser:<owner>`，桌面使用交互资源租约。Shell 不再持有同主机的 `*` 全局写租约。
- 转后台后工作区租约仍跟随实际进程结束，不因前台工具返回而提前释放；同工作区文件读写仍受协调，独立项目和浏览器不被 Shell 阻塞。
- 此为协作调度，不能把任意 Shell 的 cwd 当作 OS 隔离边界。脚本自行跨目录访问不在该锁的隔离承诺内。
- 进程清理未确认时保留所属工作区租约，拒绝后续执行，避免冒充已停止。

## 等待状态与输出

flow 的运行记录增加 `activity`，不新增第二个主运行或改变四态调度器：

- `running`：模型或工具在推进，可同时列出后台命令。
- `waiting-background`：SDK 已结束本次生成，宿主等待后台命令终态。
- `waiting-resource`：等待工作区、桌面或共享浏览器资源；携带阻塞操作摘要和等待起点。

界面显示等待原因、耗时、命令最近输出及停止入口；列表使用时钟标志。等待时收起正文生成光标、输入框的回应提示和用量运行点；通话条也显示等待。renderer 重载通过 flow 快照接回，运行收口清除 activity，旧代次/旧运行的活动更新被丢弃。

完整输出保存到受控上下文快照，模型收到有界尾部、真实退出状态及快照引用。内存中的完成队列只保留有界输出；UI 显示最近 2000 字符。子 agent 的停摆检测区分宿主明确的后台/资源等待与无响应模型流。

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
