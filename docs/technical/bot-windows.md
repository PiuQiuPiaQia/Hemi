# Windows Bot

Windows x64 可作为 Bot 的 SSH 远端主机。桌面端沿用现有 Bot 入口、系统 SSH 配置、密钥和密码管理。

## 主机要求

- OpenSSH Server 已安装并运行，SSH 主机指纹已确认，账号能够登录。
- PowerShell 5.1 或以上、`tar.exe`、`icacls.exe` 和运行中的 Task Scheduler。
- 本地账号目录可写，至少 512 MB 可用空间，可访问 Node 官方分发和 npm registry。
- 账号可创建自身的 S4U 计划任务，并拥有“作为批处理作业登录”权限。组策略禁止时，安装报错并保留原组件。

Windows 当前支持 x64。工作目录使用 `C:\Users\…` 一类本地盘绝对路径；安装前的目录浏览不接入 UNC 网络共享。Bot 可通过独立的交互用户助手操作 Windows 应用，浏览器和其他能力见 [Bot 主机能力](bot-capabilities.md)。

## 安装与常驻

探测先区分 Linux 和 Windows。Windows 使用 `powershell.exe -EncodedCommand`，兼容 OpenSSH 默认 shell 为 cmd.exe 或 PowerShell 的情况；动态路径用 PowerShell 字符串字面量转义。

用户点击连接时，已有安装未响应会自动启用并启动服务，再等待握手和重新探测。正常运行的 Bot 不重复启动；首次安装仍在初始化时自动部署 Node 与 npm 依赖。自动启动失败后显示具体原因和重试入口，重试期间禁用重复操作；不会因为旧服务不可用就覆盖安装或数据。后台只读探测不启动用户主动停止的 Bot。

根目录为 `%USERPROFILE%\.local\share\hemi-bot`。目录 ACL 只授予运行账号和 SYSTEM 完全控制。已有合格的 Node 22.19+ x64 与 npm 时复用；否则安装固定的 Node 22.22.3 Windows x64 ZIP，使用官方 SHA-256 校验。npm 通过选定 Node 执行 `npm-cli.js`，保留私有缓存、安装日志、锁文件和第三方声明，禁用依赖安装脚本。Windows 每次安装最多等待 300 秒。

Windows OpenSSH 的命令 stdin 在大数据传输时可能卡住，因此组件包和超过 64 KiB 的 RPC 请求采用分块上传。每块为 48 KiB 原始数据的 ASCII base64，以已知字节数读取，不等待 SSH EOF；安装包随后再校验完整摘要。大请求先写入私有临时文件，再通过本地进程管道送入 Node；临时文件在收口时清理。较长的 PowerShell 安装脚本也通过 stdin 上传，避免 cmd.exe 的命令行长度限制。

安装使用独立版本目录和 `current.json` 指针，不要求管理员符号链接权限。依赖和语法检查通过后才切换版本。保留上一版本、指针和任务 XML；新版本握手失败时恢复旧组件。维护时仍沿用任务空闲和实例身份检查。

`HemiBot-<当前账号 SID>` 计划任务以 S4U / Limited 运行稳定的 `windows-launcher.mjs`。每分钟重复触发，配置 StartWhenAvailable、IgnoreNew、无执行时限及故障重试，以便账号退出桌面后继续运行，并在系统调度恢复后启动。停止同时禁用触发器，启动时重新启用。该任务不使用 SYSTEM 身份运行 Bot。

计划任务明确使用优先级 `4`，使 CPU、I/O 和内存均按正常优先级处理交互请求。Task Scheduler 默认的 `7` 会同时降低这三项优先级，在 Windows 实测中让每轮模型请求前多等待数秒；会话锁校验不调用模型。启动操作先修正旧任务的设置，再启动进程；更新组件也使用相同设置。已在运行的进程不会因修改任务设置自动改变优先级。优先级对应关系见微软的 [Priority 定义](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-priority-settingstype-element)。

S4U 不保存密码，也不提供网络登录凭据和加密文件访问；本次不承诺 SMB 共享或 EFS 支持。参见微软的 [任务安全上下文](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks) 和 [任务主体文档](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)。

## 控制通道和执行

Linux 继续使用 Unix socket。Windows 使用按数据目录身份和私有 token 生成的命名管道，并对每个本地 RPC／事件订阅检查控制 token。请求与响应使用换行分帧，避免依赖 POSIX 半关闭语义；控制管道与 CLI 标准输入均流式解码 UTF-8，保留跨块的中文与 emoji。只有通过认证的请求才能进入 Host。

Agent 的系统提示词说明实际平台：Windows 的 `bash` 工具由既有宿主命令执行器使用 cmd.exe 执行；需要 PowerShell 时显式调用。初始化验证使用当前 Node 读写验证文件。文件链接支持 Windows 盘符和 file URL，目录与控制数据范围按平台路径规则判断。

Windows 命令以 cmd.exe 的原始命令行规则传参，保留 `node -e` 等嵌套引号。需要登记进程归属的命令使用独立 Node 守卫：等待宿主完成持久化后再启动 cmd.exe；宿主管道关闭时清理命令进程树。该守卫也兼容桌面 Electron 的 Node 运行模式，不把内部运行模式变量传给用户命令。

## 验证命令

`HEMI_BOT_TEST_HOST` 必须指向专用测试账号。脚本会安装 Bot、配置仅用于测试的合成模型、创建会话，并测试停止／启动。`HEMI_BOT_TEST_SSH_BIN` 可指定带独立 known_hosts 和密钥配置的 SSH 包装器。真实供应商凭据不参与测试。

```sh
HEMI_BOT_TEST_HOST=user@windows-host node scripts/verify-bot-windows.mjs
node --test src/main/bot/windows.test.mjs src/main/bot/cli.test.mjs src/main/bot/runtime.integration.test.mjs
```

重复使用先前测试安装时显式设置 `HEMI_BOT_TEST_REUSE=1`；不要对已有个人 Bot 使用该脚本。报告写入忽略目录 `.visual/workflow/windows-bot`，包含被测提交、源码摘要、环境和检查结果。截图、SSH 配置、临时密钥及服务器私有数据均不进入提交。

## 2026-10-26 实测记录

被测基线为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加当前未提交工作树。桌面环境为 macOS 26.5.1 arm64、Node 22.22.3、Electron 44；Windows 为 Server 2025 Datacenter x64 / build 26100、PowerShell 5.1.26100.32522、2 核 / 2 GB、Node 22.22.3。Windows 全流程验收包的组件摘要为 `2fb47e55b7c8f26deeee8ead92905d22ce58f0036416c2ff3abeedaa6c3de1fa`。最后的客户端 UTF-8 JSON 读取调整另经真实桌面服务连接、绑定保存与重建服务后的恢复检查。

- `npm test`：1814 项，1807 通过、7 跳过、0 失败。跳过项包含 Windows 专属检查，已在 Windows 原生测试中执行。
- Windows 原生运行 `node --test src/main/bot/windows.test.mjs src/main/bot/runtime.integration.test.mjs src/main/bot/host.test.mjs`：32 项，30 通过、2 个 POSIX 专属场景跳过、0 失败。覆盖真实 SDK 文件执行与恢复、命名管道认证、UTF-8 跨块、PowerShell 目录、ACL、原子指针和命令启动守卫。
- `HEMI_BOT_TEST_HOST=… HEMI_BOT_TEST_REUSE=1 node scripts/verify-bot-windows.mjs`：8 项全通过，含真实安装／升级、计划任务与命名管道握手、模型请求、初始化、实时订阅、控制 SSH 断开后继续执行、中文交付文件、大于 SSH 窗口的文本往返、停止／禁用／启动及同一实例的会话恢复。模型为合成 HTTP 服务，通过独立反向隧道提供；断开的是 Bot 控制 SSH。
- `node scripts/verify-bot-linux.mjs`：真实 Linux SSH、systemd、SDK、文件执行和停启恢复 8 项通过，环境为隔离 Docker Linux arm64 / Node 22。
- `npm run build`、`node scripts/check-spacing.mjs`、`git diff --check` 通过。开发与构建 renderer 在 375／768／1440 宽度检查连接入口和弹窗，无横向溢出或页面异常；当前外观 schema 仅支持 light，不计作暗色验证。

证据位于 `.visual/workflow/windows-bot/` 的 `windows-validation.json`、`native-tests.log`、`desktop-binding-report.json`、`full-tests-final4.log`、`ui-report.json` 及截图；Linux 记录位于 `.visual/workflow/bot-implementation/linux-validation.json`。验证使用独立桌面 `HEMI_USER_DATA_DIR` 与临时目录，没有访问已安装 Hemi 的个人数据。

测试后移除了合成会话、模型、交付文件、上传残片、验收用源码和重复下载文件，并停止／禁用测试 Bot。临时 SSH 公钥已从服务器移除，新建 SSH 连接已确认被拒绝，本机临时私钥已删除。按用户授权，sshd 保持运行并自动启动；已有云防火墙规则未修改。

未覆盖 Windows 物理重启、Windows 11／其他 Windows 版本、Windows ARM64、中文账号目录上的完整安装、真实供应商凭据及签名安装包；Windows 新版本启动失败后的自动回滚流程尚未做故障注入实测，原子替换和常规升级已实测。代码未提交、推送或发版。已有其他工作树改动保留。

### 2026-10-26 连接时自动启动补充验证

- 基线仍为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 的未提交工作树，macOS / arm64、Node 22.22.3。
- Windows Server 2025：复用用户已登录的 SSH 连接，实际 `createBotDesktopService.connect` 从服务停止状态自动启动任务，经命名管道握手恢复原实例身份。没有读取密码、添加密钥或修改模型与会话。本次为用户继续使用保留 Bot 运行，取代首次验收时的停止状态。
- `node --test src/main/bot/connection.test.mjs src/main/bot/desktop-service.test.mjs src/main/bot/windows.test.mjs`：33 项，26 通过、7 平台专属／PowerShell 环境跳过、0 失败。
- `npm run typecheck`、`npm run build:renderer`、`node scripts/check-spacing.mjs` 通过。
- `node .visual/workflow/windows-bot/autostart/verify-ui.mjs`：独立 `HEMI_USER_DATA_DIR` 下验证 Vite 和构建版 Electron 的自动启动进度、失败提示、重试互斥及成功状态。初次握手不可用和首次启动失败在 SSH 边界注入，重试通过真实 Windows PowerShell、任务计划程序和 Bot 控制通道。两种模式均无页面异常。
- 证据保存在 `.visual/workflow/windows-bot/autostart/`。未重跑全量测试、重新安装远端依赖或更新已安装桌面应用；本次修复仅涉及连接恢复流程。

### 2026-10-26 切页重连补充验证

桌面端临时断线按 1 秒、5 秒、15 秒、60 秒退避持续重试，不再在四次失败后永久停下；认证、身份或协议错误仍停止后台重试。切回 Bot 立即触发只读状态刷新，不启动／重启服务，也不撤销用户主动断开或停止。连接中的空页面不再显示“启动 Bot”，该按钮仅在已确认停止或缓存明确停用时显示。未变化的快照恢复连接后也会清除旧断线错误。

- 同一基线工作树、macOS / arm64、Node 22.22.3。`node --test src/main/bot/connection.test.mjs src/main/bot/desktop-service.test.mjs` 共 23 项全部通过，覆盖四次以上断线后的定时恢复、认证失败停止重试、显式断开和停止不被刷新覆盖。
- `npm run typecheck`、`npm run build:renderer`、`node scripts/check-spacing.mjs` 通过。
- `node .visual/workflow/windows-bot/residency/verify-ui.mjs` 在独立 `HEMI_USER_DATA_DIR` 下验证 Vite 与构建版 Electron，使用真实 renderer、IPC、desktop service、CLI 和 Host，SSH 网络边界注入断线。五次断线后切回页面自动恢复，多次切页期间 bootId 不变、远端服务启停调用为零，明确停用仍保留启动按钮，无页面异常。
- 开始排查时对 Windows 的只读检查确认任务计划程序为 Running／Enabled，Bot `enabled=true`，无需唤醒。后续只读复核时借用的已登录 SSH 连接已失效，未读取密码或重新添加密钥，因此不将该复核计为 Windows 连续运行验证。本轮没有修改 Windows 服务、模型或会话。
- 证据位于 `.visual/workflow/windows-bot/residency/`。本轮只验证受影响范围，未更新已安装桌面应用或发版。

### 连接正常但会话加载受更新阻塞

现场使用的是 Vite 开发版，另有正式版同时运行，不能仅凭 `/Applications/Hemi.app` 判断用户窗口。Windows 的握手和不含会话详情的状态查询正常；自动组件更新中的 npm 安装超时，详情读取同时出现长时间等待。

服务器实测 npm 官方源 `/-/ping` 返回 200、约 2579 ms，备用源返回 200、约 124 ms；这不能证明每个依赖包都能下载，但不支持“源整体不可达”的判断。安装日志大量命中缓存，2 GB 系统可用内存约 99 MB。重建已有 SSH 控制连接，并仅终止匹配 Bot 专用目录的依赖安装器及其 npm 子进程，保留常驻 Host；可用内存回升至约 423 MB，握手和原会话只读打开分别约 890／891 ms，bootId 保持不变。未修改安全软件、源配置、模型或用户会话。

页面优先呈现已保存会话，再异步读取云端状态；初次会话尚未载入时也显示组件更新或失败提示。自动更新失败后，切页不再重复触发同一次安装，用户仍可显式重试。Vite 页面已热更新；主进程的额外自动重试保护在重启后生效。未发布安装包。

同一基线工作树下，`node --test src/main/bot/component-update.test.mjs src/main/bot/desktop-service.test.mjs` 24 项全部通过，类型检查、renderer 构建和 spacing 检查通过。`.visual/workflow/windows-bot/loading/verify-ui.mjs` 使用隔离 profile、真实 renderer／IPC／Host 与 SSH 故障边界，在 Vite 和构建版中验证：SSH 请求未完成时已有会话仍可显示、安装失败原因可见、切页不自动重复安装。证据在 `.visual/workflow/windows-bot/loading/`；未重跑全量测试，也未尝试升级实例配置。

### 2026-10-27 Windows 组件更新复用依赖

Windows 更新在 Node 路径相同、当前版本位于 Bot 管理的 releases 目录、package.json 与 package-lock.json 逐字节一致、npm 完成标记与直接依赖版本均有效时，将现有 node_modules 复制到新版本。新旧目录独立，失败回滚不会受新版本写入影响；核验不通过仍执行原 npm ci 流程，网络错误的备用源重试保持不变。不修改服务器的全局 npm 配置。

- 基线为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加当前未提交工作树，macOS arm64 / Node 22.22.3，实机为此前的 Windows Server 2025 x64 / 2 GB / Node 22.22.3。
- `node --test src/main/bot/install-dependencies.test.mjs src/main/bot/windows.test.mjs`：27 项，20 通过、7 平台专属／PowerShell 环境跳过。另用本地 PowerShell 执行 `--test-name-pattern='PowerShell payloads parse'`，安装、回滚等脚本解析通过。`node --check src/main/bot/install-dependencies.mjs` 与受影响文件的 `git diff --check` 通过。
- 复用用户已有 SSH 会话，通过真实 transport 安装、维护开关和计划任务升级。新组件为 v0.2.17 / `6982dd3604a1515cc77de8f9376955a6baca418c57df0da4ba6b30e23999b37c`；安装结果记录 `strategy: reuse`，没有再次启动 npm 下载。包括上传、复制、服务切换、清理和复核共约 337 秒。期间曾出现 SSH 新通道拒绝，随后恢复；不能把全部耗时归因于复制或下载。
- 完成后两次握手核对新 build 和同一实例身份，计划任务 Running，Bot enabled/configured 为 true；原 4 个模型与 1 个会话的身份、模型配置摘要保持一致。桌面实际页面显示已连接，更新／失败提示已消失，输入区可见。本次未发送测试消息、改变模型配置或清理用户会话。
- 证据位于 `.visual/workflow/windows-bot/update/` 的 `update-report.json`、`run-update.log`、`tests.log` 与 `powershell.log`。本轮未变更 UI，不重跑 UI 生命周期回归或全量测试；没有验证物理重启。桌面主进程的依赖复用调用需要下一次重启加载，本次更新由最新源码 transport 完成。未提交、推送或发版。

### 2026-10-27 后台检查降频与设置页状态

组件检查从页面生命周期移到桌面服务，连接后延迟 30 秒首次检查，此后每 6 小时检查一次；失败退避 6 小时，等待任务空闲的复查从 2 秒改为 1 分钟。手动检查立即执行。主动断开与停止后取消调度，切页不产生新检查或安装。组件版本、后台进度、失败原因、最后检查时间与重试入口集中在 Bot 通用设置；聊天和空会话页面不再显示维护横幅。

- 被测提交仍为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作树；macOS arm64、Node 22.22.3、Electron 44。
- `node --test src/main/bot/component-update.test.mjs src/main/bot/desktop-service.test.mjs`：27 项全部通过。使用真实 Host，定时器控制验证无页面时的自动检查、6 小时间隔、失败退避、1 分钟空闲复查、主动断开取消与手动立即检查。
- `npm run typecheck`、`npm run build:renderer`、`node scripts/check-spacing.mjs` 与受影响文件的 `git diff --check` 通过。
- `node .visual/workflow/windows-bot/quiet/verify-ui.mjs` 使用独立 `HEMI_USER_DATA_DIR`、真实 renderer／IPC／desktop service／CLI／Host，在 SSH 边界控制检查与安装阶段及安装超时。Vite 与构建版均验证检查／更新／失败只在设置页可见、切页无额外检查或安装、设置页手动重试有效，且无页面异常；375／768／1440 宽度无横向溢出。当前外观 schema 仅支持 light，未计作暗色验证。
- 证据位于 `.visual/workflow/windows-bot/quiet/` 及同级 `quiet-*.log`，视觉结论在 `.visual/workflow/vision-report-bot-quiet-update.md`。本轮未修改 Windows 服务或用户配置，未重跑全量测试与 Windows 安装。聊天页热更新后隐藏维护提示；新的后台调度在桌面主进程下一次重启后生效。未提交、推送或发版。

### 2026-10-27 发送延迟与任务优先级

基线为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作树；macOS arm64 / Node 22.22.3 / Hemi Dev 的 Vite renderer，连接现有 Windows Server 2025 x64 / Node 22.22.3 Bot。独立阶段测试使用新建临时数据目录；真实供应商对照只在专用诊断会话发送短消息。

- 实际常驻任务使用默认优先级 `7`，进程 CPU 为 BelowNormal、I/O 为 Low（1）、内存为 Low（2）；独立 SSH 测试进程的 I/O 为 Normal（2）、内存为 Normal（5）。修正当前进程和持久任务设置后，在同一会话、同一模型的对照中，请求前等待由 4244／2406 ms 降至 120／74 ms。模型服务本身的等待另计，不将全部响应差异归因于优先级。
- 新安装显式使用 `4`；旧任务的启动操作先修正设置，再启用和启动。真实 Windows 原生回归执行生产设置语句，并创建一个隔离的旧优先级任务，验证生产启动逻辑修正后实际运行的 Node 进程为正常优先级；2 项通过。
- macOS `node --test src/main/bot/windows.test.mjs src/main/bot/connection.test.mjs`：18 项，9 通过、9 个平台专属场景跳过。受影响 MJS 的 `node --check` 与 `git diff --check` 通过。本轮不变更 renderer，没有重跑全量测试或完整安装。
- Hemi Dev 真机窗口录屏确认修正后可以正常发送、显示回复，帧率约 60 FPS。服务后续重启后再次核对任务优先级 `4`、运行进程 Normal、原实例身份和关闭的诊断端口。首次创建 SDK 会话仍有初始化开销，供应商延迟也仍存在。
- 诊断期间一次性能采集清理回调异常导致 Bot 退出，已恢复同一实例并向用户说明。后续采样没有包装业务函数，完成后诊断端口已关闭。真实 Bot 的运行任务可能受该次重启影响，应按原会话状态核对；没有自动重放用户任务。
- 证据为 `.visual/workflow/bot-send-latency-20261027/` 中的 `priority-report.json`、原生测试日志和 `after-priority.mp4`。当前 Bot 已直接修正进程和任务设置；桌面主进程在下次重启后加载仓库中新的安装／启动脚本。未提交、推送或发版。

### 2026-10-27 持久控制通道与会话操作回执

Windows 在握手声明 `capabilities.rpcStream: 1` 后，复用一个 SSH / PowerShell / Node CLI 控制进程。消息分帧、并发请求与迟到回执处理使用微软 `vscode-jsonrpc@10.0.0`，实际请求继续通过私有 token 认证的本地命名管道进入原 Host。PowerShell 中的持久模式让 Node 直接继承 SSH 标准输入，避免 .NET 重定向管道对小请求的缓冲。旧 Bot 保持单次 RPC；大请求保持原来的分块暂存上传。断线、超时或取消不自动重放写操作；关闭连接、服务维护及退出时释放控制通道。

桌面新建、删除、更新会话时请求附带当前会话列表快照的成功回执，新建还带空会话详情。回执落盘后即可更新缓存和界面，随后后台核对，不等待第二次状态拉取。会话列表快照不保存在幂等操作日志中；重查同一操作时返回当前权威会话列表。已缓存的会话打开直接使用缓存，同时启动后台核对。旧轮询及事件重置不能覆盖更新的会话列表修订；失败的删除保留选择，显式断线后的迟到回执不改写缓存。

验证基线为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加当前未提交工作树，macOS arm64 / Node 22.22.3，远端 Windows x64 / Node 22.22.3。所有新测试使用临时数据；Windows 实测在临时目录启动独立生产 Host，使用合成模型配置、不调用模型，不修改现有会话或重启原 Bot。

- `npm ci`、`npm run build` 通过。最终定向测试 `node --test src/main/bot/desktop-service.test.mjs src/main/bot/host.test.mjs src/main/bot/windows.test.mjs src/main/bot/rpc-stream.test.mjs src/main/bot/connection.test.mjs src/main/remote/ssh-runner.test.mjs`：69 通过、11 个原生环境场景跳过；`device-gateway`、`realtime`、`execution`、`model-routing`、`component-update` 集成测试：31 通过。
- `node scripts/verify-bot-control-latency.mjs`：真实 Electron / preload / IPC / SSH runner / CLI / Host，替换 Windows SSH shell 这一 OS 边界，在 Vite 和构建后 renderer 中点击新建、模型选择、确认删除，通过；每个应用实例仅启动一个控制进程。断线、重连、旧响应、幂等日志及 UTF-8 分块有定向覆盖。
- Windows 真实 SSH / PowerShell 小请求测试确认：不关闭输入也能立即收到中文与 emoji 回显。真实 Host 对照中，5 次单次 RPC 读取会话状态耗时 1925–3161 ms；持久通道首次 2238 ms，后续 4 次 30–31 ms。3 轮新建并打开为 69–76 ms，切模型 65–162 ms，删除 72–133 ms。这些是本次隔离环境的 Bot 命令耗时，不代表模型回复延迟。
- `node scripts/generate-renderer-notices.mjs --check`：156 个组件、无待处理通知；新增依赖仅用于主进程和 Bot，保留 npm 包内许可及通知，已加入 Bot 打包依赖。

证据位于 `.visual/workflow/bot-control-latency/`，包括 `targeted-tests.log`、`integration-tests.log`、`ui-report.json`、开发版与构建版截图、`windows-stdin.log`、`windows-report.json` 和可复现的 Windows 验证脚本。没有运行全量测试、物理重启或升级当前用户的 Bot；开发主进程需要重启，远端需要加载新组件后才会启用持久通道。未提交、推送或发版。


### 2026-10-27 当前连接的持久通道启用验收

用户重试后仍有延迟。实际 Hemi Dev 已加载桌面改动，但远端仍是 `5eefdbfc`，握手没有 `rpcStream` 能力，三次请求分别为 1104、1269、1219 ms。自动／手动更新被未完成的安装进程占用 `install.lock` 阻断；两轮完整 npm 安装在缓存命中后仍达到 300 秒超时。另一个网络修复流程随后切换到 `7332d1aa`，该组件同样没有持久控制通道。

只终止指向未激活 release 的安装链，保留运行中的 Host。独立准备当前组件：SFTP 上传源码组件包，复制现有依赖（不使用硬链接），核对锁文件中的版本与完整性；新增 `vscode-jsonrpc@10.0.0` 的官方 npm 包按锁文件 SHA-512 双端校验，保留原始许可。新目录的 Host 与 RPC 模块实际导入通过后，在 `activeJobs=0` 和维护保护下切换计划任务，并保留旧 release 回滚入口。切换时实例身份、模型配置、路由及原会话元数据一致。

远端现已运行 `72e872bd0cb6702e993a9ab31a8b8e053642555df9a09d8868f17341e3690f50`。实际窗口断开并重连后，已建立一个直接继承 SSH 输入的持久控制进程；设置页确认新版本且“已是最新版本”。真实 Bot 连续五次请求耗时 33、31、31、31、31 ms。

基线仍为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作树，macOS arm64 / Node 22.22.3 / Hemi Dev（Vite 5174），连接 Windows x64 / Node 22.22.3。生产桌面服务配合真实 Bot 的独立临时会话验证：创建 100 ms、缓存打开 6 ms、会话设置更新 89 ms、删除 106 ms，临时会话已清理。用户随后已在当前窗口发起自己的任务，未再对该会话切换模型或清理。没有重新执行全量测试，也没有在活动会话上做推理回归。

证据位于 `.visual/workflow/bot-control-live/`：`initial-handshake.json`、`activation.json`、`activation.log`、`live-operations.json` 及相关复现脚本。本轮重点是实际加载与验收，非再次声明隔离测试已通过；没有提交、推送或发版。

桌面无人值守时，可将当前账号已有的活动 RDP 会话交还控制台，避免依赖持续连接的 RDP 窗口。使用管理员 PowerShell 执行 [`scripts/windows-console-handoff.ps1`](../../scripts/windows-console-handoff.ps1)；这会立即断开当前远程窗口。腾讯云轻量 Windows 已完成移交后无 RDP 连接的原生桌面操作补验，详见 [Bot 主机能力验证记录](bot-capabilities.md#腾讯云轻量-windows-会话排查)。
