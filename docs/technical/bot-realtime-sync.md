# Bot 会话多端实时同步

Bot Host 持有会话、排队输入、执行与消息输出的唯一状态。电脑和手机提交命令；客户端操作经 Host 校验与受理，随后同步权威状态；已受理任务沿用原有持久化保障。实时连接与现有 Host 同生命周期，不增加独立服务、调度器或监听端口。

## 通道与事件

- 电脑：`transport.watch` 经原有严格 SSH 执行 `cli.mjs watch`，连接私有 `control.sock`，持续接收 UTF-8 JSON 行。SSH runner 的流式输出不累积到内存中的完整 stdout。
- 手机：现有设备 HTTPS 入口增加 `/v1/events` WebSocket upgrade。首帧携带原生设备密钥签发的 ES256 证明，绑定事件路由与一次性 challenge。服务端验证设备已批准且未撤销后才发送数据。iOS 使用 Network.framework 的 NWProtocolWebSocket，复用 RPC 的固定证书、主机名、有效期与用途校验，私钥不进入 JS。真机上不再使用受 ATS 默认信任链限制的 URLSessionWebSocketTask，也不放宽 ATS。
- 操作仍走已有 RPC；上传、下载和文件内容继续走资源接口。
- 每个客户端与一个 Bot 维持一个事件连接。手机在连接内复用最多 16 个会话订阅；桌面跟随当前会话调整订阅。

事件信封包含 `version=1`、`instanceId`、`bootId`、递增 `sequence`。`flow` 携带现有 conversation-flow 补丁（包括会话版本、代次与运行身份）；`catalog` 通知会话列表、权限等元数据需要刷新；`reset` 携带订阅范围内的完整快照；`ready` 标识追赶完成。连续输出按 40ms 合批，同一消息更新只保留批次内的最新内容。

## 断线与恢复

客户端记录进程身份、事件序号和订阅范围。同一 Host 进程保留最多 512 条／8MiB 事件供重连补齐。首次连接、订阅范围改变、游标过期或 Host 重启时改发完整快照。快照捕获、补发与订阅安装在同一同步步骤中完成，避免交接窗口漏掉更新。

WebSocket 使用 20 秒心跳检测断开的连接；SSH 流含心跳并设接收截止时间。客户端指数退避重连，同时保留快照读取兜底。手机进入后台释放流，回到前台重连并核对状态。事件序号和会话版本过滤重复／迟到更新；补丁缺口触发现有 SDK 重取快照。桌面合并快照时保留同一 Host 进程中已收到的更新版本，防止较慢的旧 RPC 响应回退输出。

实时事件日志只用于传输恢复。会话快照和操作回执仍由原有存储负责；Host 重启后重新发布快照，不重放执行命令或未完成的有副作用任务。普通网络断线不停止云端任务。

启动和短暂重连先静默恢复；连续前台断线超过 10 秒才显示恢复连接提示。后台不累计提示等待时间，回到前台重新计时。发送立即反馈提交状态，云端受理前保留原草稿，失败恢复；提交回执不再等待额外一次会话目录读取。发送中的禁用原因使用发送提示，不复用工作目录失效提示。

## 操作冲突

- 同一会话的外部修改串行受理，包含异步输入冻结阶段，避免两个设备同时准备并启动重复运行。
- 消息按服务器受理顺序排队。稳定 `inputId` 与持久 `requestId` 去重；丢失回执后查询原操作／已受理输入，不自动重发结果未知的操作。
- 编辑校验 `expectedEditRevision`；附件等非正文修改也推进编辑版本。排序校验操作前的 `expectedInputIds`。过期操作返回冲突，不覆盖当前状态。
- 编辑占用绑定真实设备身份。其他设备不能保存、撤回或插队该编辑项。手机身份由认证边界注入；电脑身份持久保存在本机 Bot 数据目录中，不接受设备 RPC 参数冒充身份。
- 编辑占用默认 60 秒，由该设备对该会话的活跃事件订阅或编辑草稿操作续期。离开会话、失联或后台断开后占用到期，Host 保留原文与已保存编辑草稿，释放占用并暂停队列，等待明确继续。
- 停止绑定 `targetRunId`，旧运行的停止操作不能误停后续任务。命令携带会话代次，旧分支操作被拒绝。
- Host 重启清除旧编辑占用，保留草稿和恢复信息。客户端冲突时保留本机输入供核对。

## 验证

验收基准：2026-10-24（Asia/Shanghai），提交 `d020e5279a7ed9f27e73b630ae9669c9278c9987` 加未提交工作区。环境为 macOS 26.5.1 arm64、Node 22.22.3、Electron 44、Xcode 26.6。以下为首次隔离验证记录，后续实际部署与真机验证见下方。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 1709 / 1709 通过 |
| `npm test --workspace @hemi/mobile` | 23 / 23 通过 |
| `npm run build`／`npm run build:mobile` | 通过；保留已有 Vite 大 chunk 提示 |
| `node scripts/verify-bot-realtime.mjs` | 开发／构建 renderer 各 5 项实际跨端链路检查通过，renderer 异常为零 |
| 普通本地对话附加回归 | 开发／构建 renderer 各 10 项实际 IPC／SDK、read／bash、队列、停止、重载与虚拟列表恢复检查通过 |
| iOS Simulator Debug 无签名编译 | arm64／x86_64 工程编译通过 |
| spacing／`git diff --check` | 通过 |

运行 `node scripts/verify-bot-realtime.mjs` 可重跑真实 Host → Unix socket／CLI → SSH runner → IPC → 开发／构建 renderer，以及设备配对 → 原生 ES256／固定证书 WSS → 队列／流式输出／断线恢复链路。脚本使用全新临时 `HEMI_USER_DATA_DIR` 与 `HEMI_BOT_DATA_DIR`；仅 SSH 可执行程序／网络与模型执行器使用隔离夹具，不连接用户服务器或读取安装版数据。

证据保存在 Git 忽略目录 `.visual/workflow/bot-realtime/`，包括环境、提交、源码摘要、开发／构建界面截图和检查结果。原生客户端另经 iOS Simulator 工程编译验证；Android 原生适配和 APNs 系统通知未在这里验收。

部署需要更新云端 Bot 组件、桌面客户端和手机客户端。旧组件仍可通过既有快照轮询读取状态；它没有新的事件与设备编辑占用保证。

本地对话附加回归使用 `verify-turn-stage-flow.mjs` 的隔离副本，唯一差异是把 Playwright 的 textarea `focus()` 改为 DOM focus，以避免驱动在已有导航等待上超时；没有替换生产 IPC、SDK、工具或 renderer。脚本与完整日志保留在上述证据目录。最终检查清单、变更源文件 SHA-256 与 Bot 运行包摘要见 `validation-summary.json`；运行包内相关生产模块与当前源码逐字节一致。


## 实际云端与实体手机验收（2026-10-24）

云端通过现有组件更新流程部署到原 Bot 实例，保留原有 11 条会话、设备授权与配对证书，握手确认 realtime=1。电脑运行当前工作区开发版的构建 renderer；手机为已配对 iPhone 16 Pro（iOS 27.0.1），Xcode 26.6 签名构建后覆盖安装 ai.hemi.mobile，保留钥匙串身份。验证环境为 macOS 26.5.1 arm64、Node 22.22.3、Electron 44；最终基准为 aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e 加未提交工作区，准确源文件摘要保存在证据记录。

实际通过云端模型执行安全 echo/sleep 命令，手机与电脑各追加一条消息，并在运行中编辑、重排队列。两个真实设备通道返回 locked、stale-input、stale-queue；过期停止返回 run-changed。强制关闭服务器上该手机的已建立设备 TCP 连接后，手机重新认证并恢复事件，云端运行持续，队列顺序保留。三条输入按最终服务器顺序各执行一次，最终两端消息历史一致。手机切到设置再回到 Hemi，恢复事件订阅且无短暂重连横幅；终止并重新打开手机 App 后，原配对与实测会话保留，仍为同一组三条输入与版本 249。没有进行蜂窝／Wi-Fi 切换测试。

实测电脑短断线不显示重连横幅，连续断线约 10.1 秒后出现，恢复后消失。点击发送至清空当前输入显示的测量为电脑约 24ms、手机约 91–96ms；这些是界面反馈时间，云端受理依然由回执确认。

原生 WebSocket 修改经真实固定证书／ES256 Host 通道验证；更新后的开发／构建 renderer 各 5 项检查通过。补充验证命令：npm run build、npm run build:mobile、npm test --workspace @hemi/conversation-flow（42 项）、npm test --workspace @hemi/mobile（23 项）、node --test src/main/bot/desktop-service.test.mjs（包含在 24 项定向回归中）、node scripts/check-spacing.mjs，以及真机 xcodebuild 与 codesign --verify --deep --strict。Renderer 与手机许可清单生成无未解决项目。

部署、发送时延、冲突、断线和后台恢复记录位于 Git 忽略目录 .visual/workflow/bot-realtime-live/。真机 Web Inspector 在后台切换时会抢占检查连接，第一次自动验收因此中断；重新附着后以同一组三条输入核对最终状态，没有重发测试消息。
