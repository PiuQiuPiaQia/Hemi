# Bot 订阅账号

2026-10-26（Asia/Shanghai）。Bot 可独立连接 ChatGPT、Claude、GitHub Copilot、GLM Coding Plan，复用桌面已有的 Pi SDK／BigModel 账号适配。套餐可用型号、地区和额度仍由服务商实际权限决定。

## 使用

已有 Bot：设置 → 设置对象选择 Bot → 模型与路由 → 添加供应商 → 订阅。首次连接可选择「订阅」并点击「部署并登录账号」，无需先配置 API Key；部署完成后进入同一个模型设置页。

本机与 Bot 共用 `ModelProfilesSection`、供应商详情、添加流程、账号弹窗及 `ModelRoutingDialog`。添加入口和已有列表均按「订阅／New API／API 配置」分组；Bot 额外有「本机配置」和「从本机同步」入口，配置结果不确定时显示核对操作。Bot 通过专用 bridge 调用对应的服务器命令，不回退到本机模型读写；连接状态按本机和各个 Bot 实例隔离。Bot 的图片由当前模型处理，不显示本机全局看图模型的选择器。

Bot 的 New API 登录复用本机站点导入流程，但预览、计划哈希、操作日志和恢复回执固定目标实例。服务器自行验证模型后加密保存 Key；无法确认服务端是否提交时不回退写入本机，也不提前撤销可能已使用的令牌。本机配置只同步对比界面中明确勾选的模型，首次初始化和后续同步均不导入本机路由。

「从本机同步」中的订阅按账号显示「为 Bot 授权／重新授权」。用户选择了保留本机登录的方式，因此点击后进入共用的 Bot 授权弹窗，创建 Bot 自己的会话，成功后安装服务器目录；不会把本机凭据交给 Bot 续期。Bot 路由继续由用户单独配置，账号授权不会改动它。

登录完成后，服务端保存的账号型号可用于普通选模和主／角色／备用路由。退出只删除此 Bot 的账号凭据，保留型号键及路由，界面将它们标为不可用；重新登录恢复同一组键。详情中可测试连接、从账号目录选取型号、编辑思考强度和图像能力；不能在普通 API Key 编辑器中覆盖账号凭据或使用目录外型号。

## 授权和执行

每次为 Bot 发起一份独立授权。本机为当前 Bot 建立临时内存 CredentialStore，使用服务器持久化的主机 UUID，在系统浏览器完成原有 SDK 授权。已登录的桌面账号凭据不读取、不复制；首次初始化及「从本机同步」也不会隐式上传它们。

登录令牌只经主进程 → SSH stdin → CLI／私有 Unix socket → Host 传输，不进入 renderer。Host 从服务商重取账号目录，并通过实际 `validateCloudModel`／Hemi SDK／原生账号 transport 完成一次推理后安装配置；失败保留旧账号和型号。安装完成后释放本机临时凭据。调用成功只验证当前所测型号，不承诺目录内所有型号均有相同权限。

服务器将令牌存为 `<botDataDir>/oauth-credentials.json` 中的 AES-256-GCM 密文，加密钥匙属于同目录的 `secrets/`；文件权限 0600，私有目录 0700。备份需要同时保存密文和钥匙。服务器独立维护刷新令牌，SDK 串行刷新；电脑断开或关闭不影响后续调用。服务器重启后复用原主机身份、凭据和稳定型号键。

模型版本、队列、运行策略、会话、操作回执、诊断和桌面缓存只有 `oauthProvider` 引用、公开目录、登录状态及无敏感内容的 `apiKey: oauth` 标记，不保存真实令牌。Bot 使用 `AsyncLocalStorage` 绑定自己的 OAuth runtime，云端验证、主 agent、角色及原生退出生命周期均运行在该作用域；同进程的桌面全局 runtime 不能为 Bot 提供凭据。

`oauth.prepare` 返回主机 UUID；`oauth.import` 和 `oauth.logout` 使用既有实例校验与持久操作身份。桌面只开放 start／state／answer／cancel／logout，导入令牌由主进程内部执行。公网设备网关不开放账号管理 RPC；手机可选用已配置型号。握手及快照中的 `botOAuth: 1` 表示支持此能力；旧组件提示更新。

本实现参照 [OpenAI 自托管 VM 流程](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)，在本机完成授权、通过 SSH 传递独立会话，并由服务器拥有后续刷新。SDK 固定为项目已有的 1.3.0，未升级或增加 renderer 依赖。

## 验证与边界

2026-10-27 补充真实 Windows 出网排查：浏览器授权和 Bot 可用性是两步。Bot 所在服务器需自行访问服务商模型目录及推理端点；电脑浏览器可用不代表服务器直连可用。错误现在按读取账号目录、模型验证、凭据保存、模型保存阶段区分，并以固定文案表示连接超时、DNS、证书、授权、地区、额度或存储问题，不把服务商原始响应体或凭据带入界面。原账号安装仍在验证通过后提交，失败保留旧凭据。

Windows 常驻任务可加载 `<botRoot>/network.env`。在 Node 支持时显式启用 `--use-env-proxy`，并用 `--env-file-if-exists` 在进程启动时读取 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`；缺少该文件时沿用默认网络。安装／更新时保留根目录中的网络文件，Node 22.19 等旧版本不追加不支持的代理参数。代理地址应指向服务器能访问的代理服务，不复制电脑的回环地址。此功能参照 [Node.js 网络配置](https://nodejs.org/learn/http/enterprise-network-configuration)；实际 Windows Node 22.22.3 已验证显式参数及配置文件生效。

后续排查发现，启动参数生效仍不足以覆盖 SDK 导入后的网络状态。实际 Windows 探针中，原生 `fetch` 和导入 OAuth 模块后的未认证请求均返回 HTTP 401；导入 Host（包括 Pi SDK）后，Undici 8 初始化自己的全局 dispatcher，替换了 Node 已配置的代理，随后同一请求及账号目录读取均超时。此处不是 `network.env` 的加载顺序问题。Host 现在在导入完成、初始化账号之前显式安装 `EnvHttpProxyAgent`，通过公开 API 同时恢复原生 fetch 与 SDK 的代理通道；继续遵守 `NO_PROXY`。直接依赖固定为 SDK 已使用的 `undici@8.10.2`，并纳入 Bot 运行包，未变更 SDK 版本。

代理是可选的出网回退，并非订阅模型的前置条件。后续工作区将 Bot 常驻进程的默认策略调整为先直连：未配置代理时继续直连；已启用环境代理时，先尝试建立直连连接，DNS、TCP 或 TLS 握手的网络失败才尝试对应代理。配置代理的自动模式将直连建连限制在 3 秒；未配置代理时保留原默认超时。切换发生在发送 HTTP 请求之前，401／403／429、证书校验失败、用户取消及请求发出后的中断不触发代理重放。命中 `NO_PROXY` 的目标始终直连，失败也不借用代理。

可在服务器 `network.env` 中设置 `HEMI_BOT_NETWORK_MODE`：`auto` 为默认的直连优先回退，`direct` 强制直连，`proxy` 强制使用已有代理配置并遵守 `NO_PROXY`。显式选择模式或原有 `NODE_USE_ENV_PROXY=1`／`--use-env-proxy` 均可启用 Bot 的环境代理支持；`proxy` 模式缺少代理地址时给出固定配置错误。Clash 仅为需要代理的服务器提供一种实现，无需为可直连机器安装。此策略作用于 Bot 的 fetch／SDK 网络通道，依赖安装继续使用下文 npm 的独立重试策略。

组件依赖安装也支持云端代理回退：优先复用完整且依赖清单一致的已安装目录；需要下载时先直连，单次 fetch 等待 8 秒且不额外重试。网络或 npm 内部失败后，使用云端 Bot 根目录 `network.env`／云端进程中的代理设置，再以独立缓存重试；没有已配置代理时，Linux 读取该云端账号的交互式 shell，Windows 在 5 秒上限内读取该云端账号的 User／Machine 代理环境变量及系统 Web 代理。最后尝试直连镜像。这里始终使用云端机器可访问的代理，不建立宿主机代理隧道。

每条路线仅为本次 npm 子进程设置参数，保留 `NO_PROXY`、TLS 校验与锁定包的完整性校验；不修改服务器的 `network.env`、npmrc 或全局代理。磁盘、权限、锁文件、401／403／404 等永久失败不尝试切换代理；无法归因网络的整体安装超时仍停止。私有安装回执记录路线与耗时，不记录代理地址或凭据。

此安装器增量于 2026-10-27 基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交改动验证：macOS arm64／Node 22.22.3，`node --test src/main/bot/install-dependencies.test.mjs` 19 项通过，`node --test src/main/bot/component-update.test.mjs src/main/bot/component-version.test.mjs` 10 项通过，语法与 diff 检查通过。实际 Windows x64／Node 22.22.3 的隔离冷缓存安装调用同一生产安装器与实际 npm：仅将首轮 registry 指向不可用测试端口，随后使用服务器既有 `7897` 代理从官方 registry 安装锁定的 `vscode-jsonrpc@10.0.0`，第二路线耗时 2141 ms，锁文件及原网络文件保持原样，安装脚本未执行。最终源码、实机测试源码及新组件包中的安装器 SHA-256 一致（`bf904f9c7e0d3a1b259378f1c6d8e5bfaddecabb622890901e9dc085093fab0d`）。记录在 `.visual/workflow/bot-install-proxy/`。本轮不涉及 renderer，未运行全量套件；小型依赖实测不代表完整组件上传、依赖复制或服务切换的总耗时，也未将 Linux/systemd 或 Windows 系统 PAC 设置作为实机验收范围。

自动回退增量基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作区，在 macOS arm64、Node.js 22.22.3 以新临时数据目录验证。上述三个定向测试文件本轮共 11 项通过，覆盖真实 Host、SDK 导入、原生和 SDK fetch、可直连时不依赖代理进程、真实 CONNECT 回退、强制模式、NO_PROXY 失败不回退、TLS 握手超时，以及 HTTP 错误和已发送 POST 不重放；语法、spacing、diff 检查和隔离运行包源码一致性检查通过。记录位于 `.visual/workflow/bot-network-fallback/validation.json`。本轮没有 renderer 改动，未重跑 UI／全量构建或全量测试；自动模式尚未部署或在真实 Windows 上验收，已部署的 `7332d1aa` 仍是此前验证成功的显式代理版本。

`node --test src/main/bot/network.test.mjs src/main/bot/oauth-errors.test.mjs src/main/bot/oauth.test.mjs` 六项通过：包含真实 Host／真实 HTTP CONNECT 代理、原生与 SDK fetch、本机地址绕过、无效代理不泄露凭据，以及四种账号的隔离授权回归。`npm run build`、spacing 和 diff 检查通过；重新生成的 renderer 许可清单仍为 156 项，无待审查项。实际 Windows 请求、组件版本及后续账号状态记录在 `.visual/workflow/bot-oauth-followup/`；未认证的 401 仅证明网络通道可用，账号连接仍需有效授权及完成一次原生推理。

Windows 依赖安装也读取同一个 `network.env`，将代理传给 npm 子进程。npm 自行处理 `HTTP_PROXY`／`HTTPS_PROXY`，因此该子进程移除 `NODE_USE_ENV_PROXY`，在支持时显式使用 `--no-use-env-proxy`，避免再叠加 Node 原生代理；Bot 常驻进程仍保持自己的代理支持。真实 Windows 对照中，原生 Node 请求 npm 包源返回 HTTP 200，同时启用两层代理的 npm ping 超时；只使用 npm 自身代理后成功。安装器 16 项定向测试通过，Windows 相关测试 5 通过、10 个平台场景在 macOS 跳过，另外在真实 Windows 执行了生产安装调用语句，确认代理配置先于子进程启动生效。

2026-10-27 08:16（Asia/Shanghai）真实账号验收通过：Windows Bot 运行组件 `7332d1aa`，ChatGPT 独立授权成功、账号目录显示 7 个型号；随后通过保存后的 Bot 凭据，调用实际 Host 的 `model.test` 完成 `gpt-6.1-sol` 原生推理，耗时 4518 ms。验证前后实例身份一致，网络修复阶段的既有模型、路由和会话元数据保持原值；账号成功后仅追加订阅型号，未替用户配置路由。修复包基于服务器原组件制作，保留原有 SDK 与其他依赖版本，只增加 `undici@8.10.2` 及网络相关改动。现场冷安装达到 5 分钟上限后，在未启用目录使用同一锁文件补完，校验依赖树并验证完整 Host 导入后切换。未做完整冷安装时限、Windows 重启、远端 Linux 或手机硬件回归，也未逐个调用其余账号型号。

以下首次实现验证基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作区；macOS arm64、Node.js 22.22.3、Electron 44、Pi SDK 1.3.0。开始时已有模型管理、共享记忆及其他改动，本次增量接入并保留它们；首次实现验证没有修改用户的实际 Bot。后续真实 Windows 排查仅按用户授权配置服务器代理和 Bot 启动网络参数；没有提交、推送或发版。

- `node --test src/main/bot/oauth.test.mjs`：四家原生 transport 的云端验证和实际主会话；无 Key 初始化、独立凭据、Host 重启、电脑断开、并发刷新、退出／重登、稳定路由、覆盖拒绝及失败保留。OpenAI 的浏览器回调放在独立 Electron 验证中，避免与既有单测竞争固定回调端口。
- Bot 模型同步／路由／桌面服务／实际 TLS 网关、New API 加密导入和目标固定恢复均通过定向回归，包含公众设备身份不能管理账号。
- `node scripts/verify-bot-oauth.mjs`：分别使用 Vite 开发 renderer 和构建 renderer，通过真实 Electron、preload、IPC、SSH runner、CLI、Unix socket、Host 与 SDK，验证初次配置、授权弹窗重载恢复、取消、ChatGPT 回调、主机身份、目录导入、共用路由、退出后再次发起登录、Bot New API 双协议导入、本机三类列表与 Bot 四类列表、选择同步及关闭桌面后的推理。本轮增加从同步窗口发起订阅独立授权，验证本机登录和 Bot 路由保持原值。375／768／1440 宽度、深色系统偏好与减少动态设置均采集截图。
- `node scripts/verify-bot-model-sync.mjs`：开发和构建 renderer 均通过共享供应商详情编辑、型号图像能力、路由即时保存、选取同步、失败保留、过期预览拒绝和显式移除验证，确认本机配置未受 Bot 编辑影响。
- `npm test`：1802 项通过、2 项因缺少 Windows PowerShell 环境跳过（1804 项）；`npm run build`、spacing 和 diff 检查通过。完整套件覆盖当时共享工作区，其余并行开发仍以各自验收为准。
- 随后的「只同步模型、订阅独立授权」增量使用定向验证：模型同步／桌面服务／路由 36 项，以及增加 Host 兼容载荷测试后的模型同步／账号／New API 21 项均通过（两组有重叠）。两套 Electron 脚本的开发和构建 renderer 再次通过，本轮未重复跑整个套件。
- 构建、完整套件和最终视觉结果记录于 `.visual/workflow/bot-oauth/`，视觉判定见 `.visual/workflow/vision-report-bot-oauth.md`。

以上首次实现及回归验证使用新建临时 `HEMI_USER_DATA_DIR` 和合成凭据。服务商 HTTP 边界使用隔离 HTTP 服务，SSH 的 Linux／systemd 边界使用本机夹具；未读取个人账号或会话。

2026-10-27 的真实 Windows 排查使用用户已保存的 SSH 连接，按用户授权安装官方 Clash Verge Rev 2.5.8、导入代理订阅并为 Bot 的常驻进程配置代理。真实 Node 22.22.3 直连模型端点连接超时，显式启用代理后未认证模型请求返回 HTTP 401、授权发现端点返回 HTTP 200，证明服务器网络已通；这两个未认证请求不能证明 ChatGPT 账号已登录或有可用额度。Clash 服务自动启动、内核在 Session 0、Bot 的实际进程参数均已核验；未做 Windows 重启回归。代理订阅与网络文件只保存在服务器，不写入仓库或验证报告。

前一轮错误分阶段诊断及 Windows 启动参数改动通过定向测试（15 通过、9 个 Windows 专用测试在 macOS 跳过）和 `npm run build`；生成的 Windows 任务参数另在真实服务器验证。分阶段诊断已随后台组件更新在真实 Windows 生效，后续代理与账号验证记录见 `.visual/workflow/bot-oauth-followup/`。未在远端 Linux/systemd 或手机硬件上验收。本地生产代码与 SDK 路径通过，不等于这些外部边界已经通过。
