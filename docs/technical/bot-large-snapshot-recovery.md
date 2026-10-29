# Bot 长会话连接恢复（2026-10-28）

> 当前结论已更新：首次传输修复后用户再次复现断线，见下文复发证据。共享 SDK、历史窗口与存储配额修复记录在 [共享会话同步](shared-conversation-sdk-sync.md)。此前短时观察不能证明问题已彻底解决。

验证基准：`1e1697b84fc2099a1b1165d163c5f4cd5bcbf6c9` 加本次工作区修改。客户端环境为 macOS arm64、Node 22.22.3、Electron 44；生产桌面为 v0.2.23，初始 Windows Bot 组件为 0.2.22.2，获明确授权后已更新至 0.2.23.3。PC 端已恢复运行；后续原生修复包获明确授权后已于 2026-10-29 覆盖安装，实体 iOS 当前长会话与实时连接验证通过。没有重发用户消息。

## 证据与修复

- 当前长会话的完整目录／详情响应约 3.4 MB，单独 flow 快照约 3 MB。原 `reset` 同时包含 `detail` 和相同内容的 `details[0]`，导致一次订阅重复传输会话详情。单会话现在只发送 `detail`；多会话只发送 `details`，保留两类既有客户端读取方式。
- 控制管道在每次发送前检查固定 2 MiB 排队门限。一个合法的大快照尚未排空，紧随其后的 `ready` 就会触发断开。使用真实常驻 Host、控制管道和 3 MiB 合成详情，在修复前复现了 `Large initial control snapshot disconnected before ready`；修复后能完整读取快照、进入 `ready` 并继续接收更新。
- 控制管道和设备 WSS 现在允许一帧合法大消息，加 2 MiB 后续积压；单帧上限为 40 MiB，与原生接收限制一致。超限或持续积压仍断开连接。没有截断历史、修改执行状态或重放发送。
- Windows 一次性 RPC／watch 的包装程序原先先启动 Node，再从 SSH 标准输入读取请求。生产 Windows 上的只读阶段探针停在子进程启动之后；将读取移到启动前，同一握手约 0.7 秒返回。现在先完整收取固定长度输入，再启动并写入 CLI；持久控制通道和已有大请求暂存文件路径保持原有传输方式。

生产只读检查还证明：HTTPS challenge 与证书指纹正常，Host 内部可快速返回握手和快照；这不足以证明手机的完整会话同步成功。真机小回执约 1.9 秒、目录约 1.2 秒成功，但当前会话 snapshot 和 flow.snapshot 都在约 12.8 秒超时。原生 WSS 空会话订阅约 0.8 秒进入 ready，同一长会话在约 25 秒观察期内未收齐首帧。这说明身份和网关可用，长响应传输受固定总截止影响。

服务器曾有 45 个已无存活 sshd 祖先进程的旧 CLI 读取进程及对应 PowerShell 包装进程；在精确限定命令、进程年龄和祖先关系后清理了这些孤儿进程，保留 Host 与有效连接。首次安装因系统提交内存不足而在切换前失败；清理后 0.2.23.3 安装成功，校验了实例、会话、模型、草稿、队列、设备授权、证书和私钥未变。之后 SSH 仍出现服务器拒绝新增 session，尚不能在 PC 任务运行期间假定 Host 空闲。

早期失败消息的服务端结果为 `unsupported-modality`，当时主模型和备用模型均不支持已有历史图像。此配置未修改，也未自动重试该消息；用户随后确认 PC 已正常运行，后续聚焦 iOS。

## iOS 长响应修复与真机安装

- 原生 TLS 将 RPC 的固定 12 秒总截止改为 12 秒无数据截止，加 60 秒总上限。收到数据时续期；配对和 challenge 保持 12 秒总上限。证书固定、签名、取消和长度检查继续生效。
- 原生请求显式声明 gzip，网关按需压缩 HTTP 响应。WSS 在带签名的订阅选项协商后，以 gzip 二进制发送大帧，原生解压后仍交给原有事件处理。旧客户端仍收原 JSON，新客户端也兼容旧服务端 JSON。
- 原生压缩与解压后的响应均限制 40 MiB；无效、截断、带额外数据的压缩包被拒绝。
- iOS v0.2.23 build 2026102901 已构建并验证签名；内嵌 HTML/JS/CSS 与已安装 build 2026102821 的哈希一致。只更新原生传输。已备份 App Documents/Library，检查到 160 个 accepted、13 个 rejected 操作，无 waiting/unknown，16 份草稿。获明确授权后已覆盖安装；安装后逐项核对 57 个本地会话目录、草稿、操作记录与缓存条目，值均未变化。最终已安装版本为 0.2.23 build 2026102901。
- Bot 0.2.23.4 压缩支持包已从基准提交与本次四个生产源文件单独构建，排除工作区同时进行的会话置顶和模型认证修改。该独立包未另行部署。随后只读检查生产已经是 0.2.23.4 build `45df2b706db2d317ad455e3497731b9d3a8bbaab61654c1845f02291cea57991`，实例一致、活跃任务 0，设备网关含本次压缩支持，其源文件哈希与当前工作区及完整开发／构建端到端回归时一致。保留此已运行版本。

## 验证

- `node --test src/main/bot/cli.test.mjs src/main/bot/realtime.test.mjs src/main/bot/device-gateway.test.mjs src/main/bot/windows.test.mjs src/main/bot/rpc-stream.test.mjs`：28 项通过、13 项平台相关检查跳过。覆盖大快照控制订阅、带认证的 TLS/WSS、大快照后的持续订阅、单／多会话详情去重、回放、跨端控制权与断线恢复。
- Windows 输入新增行为测试：请求不完整时不能启动 CLI，完整 UTF-8 请求应原样转发。当前 macOS 没有配置 PowerShell，因此该本地用例跳过；生产 Windows 的只读握手阶段对比作为额外实现证据，未将其算成完整 Windows 平台测试通过。
- `HEMI_BOT_AUTO_UPDATE=0 node scripts/verify-bot-realtime.mjs`：Vite 开发 renderer 与构建 renderer 各 5 项通过，覆盖真实 Electron／preload／IPC、CLI／Host、原生固定证书 TLS／ES256／WSS、增量输出、队列、重连和桌面重启后不重复输入。仅 SSH 网络、模型执行与原生测试凭据存储使用隔离夹具，数据目录为新建临时目录。验证夹具已按现有会话控制权约定，在原生发送和测试停止前显式接管。
- 修改的生产 `.mjs` 文件通过 `node --check`；`git diff --check` 通过。
- `node scripts/verify-native-slow-response.mjs --source /tmp/hemi-device-client-before-large-response.swift --expect-old-timeout`：旧原生实现复现约 12 秒截止；新实现通过约 14.5 秒慢速分段 gzip 响应，并拒绝解压超限与无效 gzip。
- 从独立打包目录运行 `node --test --test-skip-pattern='pins sessions' src/main/bot/cli.test.mjs src/main/bot/realtime.test.mjs src/main/bot/device-gateway.test.mjs`：22 项通过。只排除属于另一项工作、基准 Host 未实现的置顶测试。覆盖新增压缩 HTTP/WSS 与旧 JSON 兼容。
- 同一独立目录运行 `HEMI_BOT_AUTO_UPDATE=0 node scripts/verify-bot-realtime.mjs --native-only --large-snapshot`：3 项原生检查通过，使用真实原生 Swift TLS/WSS 与 3 MiB 合成详情。报告 `.visual/workflow/bot-connection-diagnosis/isolated-native-report.json`。
- 当前工作区再次运行完整 `verify-bot-realtime.mjs`：开发与构建 renderer 各 5 项通过。`verify-device-pairing.mjs` 停在旧 UI 夹具查找 Bot 控件超时，未将其记为通过。
- 待部署 0.2.23.4 包和源文件哈希、生产 0.2.23.3 更新与数据保留校验、真机读请求与 WSS 对照、原生慢传输结果均记录在 `.visual/workflow/bot-connection-diagnosis/`。

真机首次页面探针确认模型按钮可用、无连接错误提示；设备锁屏后暂停验证，待用户解锁并保持前台后继续。最终 `snapshot{id}` 完整返回约 373 万 JSON 字符、耗时 8.615 秒，`flow.snapshot{id}` 约 324 万字符、耗时 3.521 秒；小回执和目录分别为 129 / 121 毫秒，均成功。

原生 WSS 当前会话收到 4,285,012 字节解压后 reset，14.326 秒进入 ready；订阅保持约 50.855 秒，跨过两个 20 秒心跳周期，收到 3 个真实增量 flow 事件及目录更新，没有断开回调。随后另做 40 秒、9 次页面观察，始终在前台、模型按钮可用、无连接／超时提示。所有操作均为诊断读取和临时只读订阅，没有发送生产测试消息。临时订阅已关闭、监听已移除。最终证据 `.visual/workflow/bot-connection-diagnosis/ios-final-verification.json`，HTTP 与 WSS 原始元数据在同目录。

本次已验证的恢复范围为真实长会话读取、原生 WSS reset/ready、增量更新和前台稳定连接。尚未实测实体设备 Wi-Fi／蜂窝切换及长时间后台／休眠。安装版 PC 的 Windows 输入包装修复需随桌面更新生效。未运行全量测试，未公开发版，未修改模型路由或设备授权，没有发送生产测试消息。工作区原有移动端／SDK 重连以及并行进行的置顶、模型认证修改均已保留。

## 后续复发与架构审查（2026-10-29）

上述真机成功记录只证明该观察时段内恢复。用户随后再次在同一会话看到断开，已重新打开问题，不能把短暂通过作为完整修复结论。

本次现场 UI 明确显示离线，服务端同一实例仍有 1 个活动任务。应用自身一次 `snapshot` 读取耗时 31.426 秒后成功；期间原生通道仍收到 `flow patch`，之后 UI 自动恢复。没有重启服务、没有点击恢复按钮、没有发送测试消息。证据为 `.visual/workflow/bot-connection-diagnosis/recurrence-evidence.json`。重复全量读取、请求取消与连接／同步状态混用是候选设计问题，尚待独立审查。

用户要求与 CC 讨论整体策略。CCB 首次返回提交回执后未送达活跃会话，状态检查证实无活跃 Claude 连接；已改用本机 Claude Code 只读审查，允许工具限 Read/Glob/Grep，不改文件、不重启、不部署。原始结果将写到 `.visual/workflow/bot-connection-diagnosis/cc-architecture.jsonl`。

### CC 两轮审查结论

本机 Claude Code 两轮只读审查已完成，补充核对了 PC 本地／PC Bot 与 iOS 的操作差异。原始结论位于 `.visual/workflow/bot-connection-diagnosis/cc-architecture-review.md` 和 `cc-parity-review.md`。

已核对的设计问题：多条恢复／轮询／命令路径重复拉取全量 flow；手机目录和小操作刷新仍携带整个 flow；每条增量触发整份快照复制与 localStorage 同步序列化，PC 共享客户端只存操作日志；unknown 回执查询串在完整快照之后，进而阻塞队列。WSS ready 也能通过 replica.connected 标在线，首轮“只有 refresh 成功才能 online”的描述已在第二轮纠正。缓存实际耗时、服务端同步持久化影响仍需 profile，不能将这些推测写作现场根因。

统一实现方向：共享 SDK 统一命令受理、控制权、幂等回执与恢复；由实时通道决定连接状态，数据同步新鲜度单独表达；命令回执不等待历史加载，未知回执查询独立进行；目录与权限／用量采用轻量数据；缓存只保留最新待写并合并写入；历史与活跃状态分离、有界恢复。是否可写仍必须受 generation、controlEpoch、输入版本及 unknown 约束，不以隐藏离线提示代替安全同步。

本轮未修改同步实现，未重启、部署或发送生产消息。问题仍未完整修复。后续验收必须用同一组发送／排队／编辑／排序／停止脚本覆盖 PC 本地、PC Bot、iOS Bot，并记录请求数量、字节、回执延迟、主线程任务与执行次数，覆盖持续生成、慢链路、前后台、重连和会话切换。
