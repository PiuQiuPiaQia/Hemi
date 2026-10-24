# 移动端应用与真机接入记录

2026-10-23。基准提交 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加当前未提交工作区；本轮没有提交或推送。工程位于现有 npm monorepo 的 `apps/mobile`，复用 `@hemi/conversation-flow`。工作区同时存在交付物和图片预算等其他修改，已保留；`host.mjs` 中本轮只叠加设备网关集成，不重写其余工作。

## 当前行为

离线演示、模拟回复／断线、示例会话／模型／目录和内置文件已删除，不再读取旧演示标记，也不自动删除旧本机输入。连接首页只保留“连接你的 Bot”、扫码主入口、手动邀请内容和开源许可。正文 14px、列表／队列 13px、编辑输入 16px，主要点击范围 44px。

iOS 已实现真实连接链路：原生相机扫码 → 预览 Bot → 本机独立设备密钥 → 提交申请 → 双端六位码 → PC 明确批准 → 原生 TLS／签名 RPC → 真实 Bot workspace 与共用 SDK 对话流。手动入口粘贴同一份一次性邀请，不导入 PC 的 SSH 密钥。

Bot 增加默认关闭的设备 TLS 入口。PC 仍经原有 SSH 管理签发、批准、回执和撤销；手机使用 Bot 自身的受限 HTTPS RPC，不经过新中间服务器。IP + 二维码固定证书支持没有域名的部署，原生系统继续校验证书用途、有效期和地址。实际部署步骤见 [Bot 设备连接](bot-device-pairing.md)。服务器端口与云安全组需管理员配置，已重启用户实际 PC 开发实例并通过现有 SSH 更新实际云端组件，配对配置页正常。用户明确同意后已启用指定 TCP 29421 入口；已在腾讯云轻量控制台确认缺少 29421 入站规则，用户再次确认后仅新增 TCP 29421／全部 IPv4／允许规则，保留原有 16 条规则。公网固定证书与 Bot 实例校验已通过，用户随后确认 iPhone 流量连接云端 Bot 成功。

## 对话与恢复

- `workspace-client.ts` 提供真实模型、会话目录、权限请求与稳定 SDK client。`createBotConversationTransport` 对接 `flow.snapshot`／`flow.command`／`operation.get`，不生成本地假回复。
- 页面继续使用 `ConversationFlow`、presenter、动作处理器、React hook、`TurnQueueTray` 和现有抽屉／顶部面板／紧凑队列布局。
- 草稿、快照缓存、稳定操作 journal 按 Bot 实例与会话隔离。切换释放后的 client 会从缓存移除，回来重新创建并恢复草稿，不复用已 dispose 的 client。
- 已受理消息或新建对话的回执丢失时，重开后只核对原操作，不重复发送，不清掉后来写的新草稿。网络错误不被当成明确拒绝。
- PC 的批准／取消／撤销持久化稳定操作标识，结果未知时只读查询回执，不自动重放授权。收起待确认请求保留申请；关闭未扫码的自有 QR 请求取消。
- iOS 的 pending／active 设备身份分开存于 Keychain，私钥不进入 JS；并发状态核对不会重复保存或覆盖其他请求。取消与批准竞态以 Bot 权威结果为准，前端忽略旧轮询和申请的迟到结果。申请进行中仍可取消；原生取消会中断旧连接，新取消请求有明确截止时间。无法核对服务器时可通过确认面板“退出本机等待”，仅删除本机 pending 身份，不声称服务端已撤销。
- 启动先恢复 Keychain，再决定进入对话、待确认页或未连接页；身份读取错误停留在恢复页并提供重试，不误导用户重新配对。没有保存身份时才显示连接首页。

## 输入框设置与工作目录补全

2026-10-23 在同一基准提交及未提交工作区上补全。输入框工具栏展示当前模型、思考档位；工作目录可从顶部或底部路径入口切换。`MobileWorkspace.update` 将模型／思考／目录映射到现有 `session.update` 的 `modelKey`／`thinking`／`dir`，从 Bot 快照读回当前会话配置、默认目录与最近目录，不改 SDK 核心或设备鉴权协议。服务器在受理输入时冻结模型策略和工作目录，已受理消息不被新设置改写。

目录选择使用已授权的 `directory.list`，支持浏览子目录、上级／主目录、默认／最近目录、路径输入、空目录和错误重试。切换和关闭面板丢弃迟到读取结果，读取失败或尚未确认路径时不能使用旧目录。`session.update` 继续由服务器检查存在性、可写性及运行数据目录隔离；保存失败保留面板与草稿。保存期间阻止发送，离线禁用设置；设置回执丢失只查询原操作回执，不自动重放。保存后的刷新等待先前轮询完成，再读新快照，避免旧轮询覆盖刚保存的配置。

定向验证：`npm test --workspace @hemi/mobile` 6/6；`node --test src/main/bot/device-gateway.test.mjs` 5/5，包含已批准设备经实际签名 TLS 浏览目录并保存设置；`node scripts/verify-mobile-settings.mjs` 开发／构建各 5 组通过，使用真实 Host/controller/文件系统，仅原生桥与模型执行为替身，验证消息冻结配置、草稿保留、回执丢失、目录错误与迟到响应、路径输入不会被迟到读取覆盖、保存时目录消失、重开和会话隔离、离线、320／375／390／768／1440／短屏与系统深色偏好。`npm run verify:mobile` 原连接／恢复 UI 回归开发／构建各 8 组通过。移动构建、间距检查通过；iOS 已复制本地资源、编译、验证签名并覆盖安装、启动到已连接的 iPhone，7 个运行资源在 dist／原生 public／签名 App 三处哈希一致。真机上的新设置选择仍需用户操作验收，不以浏览器检查冒充。

证据在 Git 忽略的 `.visual/workflow/mobile-settings/`、`mobile-settings-*.log` 和 `vision-report-mobile-settings.md`，报告记录基准提交、环境和源文件哈希。此前完整测试结果见下文；本次局部功能未重复全套或广泛桌面回归。

iOS 27 真机暴露了原 URLSession 公网 IP 自签证书路径的 TLS `-1200` 失败，而 macOS 与局域网验证不能证明该路径可用。现改用 Network.framework 的原生 TLS：明确 TLS 1.2+、先固定 QR 证书指纹，再以系统 SecTrust 校验证书用途、有效期与地址，未增加全局 ATS 放宽。HTTP 仅处理 Bot 的单次 JSON POST、Content-Length 和有限响应，拒绝重定向及分块编码。该实现重新通过原生握手／签名／错误指纹／回执／撤销／取消验证，并完成了实际 iPhone 流量连接。

`SceneDelegate` 必须创建 `HemiBridgeViewController`。首个真机安装暴露了 scene 默认控制器覆盖 storyboard 的问题，导致扫码按钮为灰色；修正实际启动控制器后，用户已确认扫码连接成功。编译成功和 macOS Swift 集成测试不能代替插件启动的设备验收。

## iOS 环境与安装

### 统一视口、键盘与焦点处理

2026-10-23 针对顶部按钮跳动和软键盘错位，采用官方 `@capacitor/keyboard` 8.0.6（与 Capacitor 8 兼容）获取键盘事件，最终配置为 `resize=none`。iOS 外层 WebView 禁止滚动，保持 `contentInset=never`；插件同时管理根 UIScrollView 的偏移，HTML/body/root 固定，聊天、抽屉、面板保留内部滚动。`useAppViewport` 将原生键盘高度注入一份 `--keyboard-inset`，整个会话容器高度统一使用 `100% - keyboard inset`，由 flex 同时缩短对话区并上移输入框，底部安全区不重复计入。原生不再通过 visualViewport 二次缩放。浏览器独立使用可视视口回退。弹层／抽屉的初始焦点、循环焦点及关闭恢复均使用 `preventScroll`。

用户真机确认整页跳动消失、输入框上移正常后，仍反馈对话流没有跟随。使用 20 条消息加长文本，在真实 SDK 虚拟列表中复现容器变矮但末尾落到可见区之外，不能以单条长消息或窗口已缩小的测试代替。SDK 的 `VirtualTranscript` 现观察视口高度变化，在 virtualizer 读取新尺寸后恢复此前的底部锚点；用户正在翻历史时保留位置，期间发生新的指针／触摸／滚轮／键盘操作则取消待执行跟随。不把平台键盘 API 放入 SDK。

基准提交与环境同下文，当前工作区未提交。`npm ci`、移动构建、renderer notices（156 项无待核对）、移动 notices（新增 Keyboard 后 130 项）、间距及 diff 检查通过。单独核对 Keyboard 的 Package.swift、包级 Ionic MIT 许可和 Keyboard.m 的 ASF Apache 2.0 源码头，原始第三方源码未修改，补充通知随本地许可页打包。`cap sync ios` 确认 KeyboardPlugin 被加入 SwiftPM 和原生 packageClassList，iOS 编译、严格签名验证及覆盖安装通过。

开发／构建设置回归各 7 组通过：保持窗口原高、键盘覆盖的边界替身模型中，整个会话容器缩短，header 坐标与根滚动不变，输入区与消息区一起调整，20 条消息的底部锚点可见；开启正常动画连续升降键盘三次后仍正确，手动上翻历史前后的滚动位置保持。另测多行输入、目录面板和浏览器视口回退。连接恢复回归各 8 组通过；重新构建 SDK 独立示例后，8 组独立 UI 检查通过，含虚拟化、历史前插、表单、隔离与触屏目标。新证据在 `.visual/workflow/mobile-viewport-*.log`、`mobile-settings/report.json`、`vision-report-mobile-viewport.md` 和 `mobile-viewport-final.json`。最终 SDK 锚点修复已进入新 iOS 构建并安装、启动，记录签名 App 的 7 个运行资源哈希与原生键盘配置；随后工作区资源存在并发重新构建，不将当前 dist 当作已安装包。用户在真实 iPhone 上连续展开／收起键盘后确认“输入框和最后一条消息都正常”。未重复完整模型或广泛桌面测试。

macOS 26.5.1 arm64、Node 22.22.3、Xcode 26.6（17F113）、iOS 26.5 平台支持；实际设备为 iPhone 16 Pro／iOS 27.0.1。账号、开发者模式、设备信任与开发签名已由用户配置。

个人 Team 仅在 Git 忽略的 `signing.local.xcconfig`，公共工程不写个人身份。源盘为 ExFAT，DerivedData 使用 APFS 临时目录 `/private/tmp/hemi-ios-native.7EZPAd`。App 内资源为本地打包文件，未使用手机浏览器或 live reload 替代安装。

```sh
npm ci
npm run build
npm run build:mobile
npm test --workspace @hemi/mobile
node --test src/main/bot/device-gateway.test.mjs src/main/bot/cli.test.mjs src/main/bot/desktop-service.test.mjs
node scripts/verify-device-pairing.mjs
npm run verify:mobile
node scripts/check-spacing.mjs
git diff --check
```

涉及同一 SDK 产物的根构建和移动构建应依次执行。验证时并发运行两者曾在 ExFAT 的旧共享块清理中产生 ENOENT，改为顺序构建后通过；未为此修改 SDK 构建逻辑。iOS 使用 `npx cap sync ios` 同步本地资源后，以 `xcodebuild` 的 App scheme／Debug／generic iOS destination、上述 APFS DerivedData 和自动开发签名构建；`codesign --verify --deep --strict`、`devicectl device install app` 与实际设备 `process launch` 已通过。

## 验证结果与证据

以下为此前扫码接入阶段的记录；输入框设置补全的最新定向验证见上节。

| 检查 | 结果与边界 |
| --- | --- |
| 设备网关／CLI／桌面 service | 19/19 通过。实际 HTTPS、未批准访问拒绝、篡改／重放、过期、并发批准、原子回执、取消、撤销和重启。 |
| 移动端协议／workspace | 5/5 通过。真实 Host/controller、SDK 草稿与发送回执恢复、client 生命周期、新建对话回执丢失后恢复。模型执行为替身。 |
| PC 开发／构建 | 各 5 组通过。新增结构化 IPC 错误码、旧 PC 重启提示和旧 Bot 维护入口回归；真实 Electron/preload/IPC/CLI/socket/Host，实际 QR 像素由 Core Image 解码，生产 Swift CryptoKit 与 Network.framework TLS，丢失批准回执恢复、会话读取／新建／发送、错误指纹拒绝和撤销；375／768／1440 无溢出。 |
| 原生客户端并发／取消 | 同一生产 Swift client 同时查询已批准请求，双方均取得批准，身份保存可恢复。新增真实 TLS 服务故意不回应的验证：取消中断正在等待的请求，取消本身受 12 秒截止时间约束，结果未知时保留 pending 身份，显式退出才清理本机申请。测试凭据存储为内存实现，不冒充 Keychain 设备验收。 |
| 移动端开发／构建 UI | 各 8 组检查，包括 320／375／390／768／1440、短屏、浅色、焦点／许可、旧标记不生效；模拟原生桥延迟／错误／重试，验证保存身份和 pending 身份不会闪过连接首页。桥替身只验证前端生命周期。 |
| iPhone 物理扫码 | 先用隔离 Bot 验证相机与 Keychain；随后更新实际云端组件、启用入口、放行用户确认的云防火墙规则，并修复 iOS 公网 IP 自签名路径的 TLS 握手问题，用户最终确认使用流量连接真实云端成功。 |
| iPhone 身份恢复 | 用户确认会话可见，彻底关闭重开后仍可进入；同时反馈连接首页短暂闪烁，已增加启动恢复状态，安装修复版后用户确认“不再闪首页，正常进入对话”。 |
| 完整 `npm test` | 1695 项中 1693 通过、2 失败。失败在本轮未修改的 `flow-timeline-view.test.mjs` 交付物去重测试（原第 357、418 行）；对应工作区另有交付物改动，未改写或撤销这些工作。不能称全套测试通过。 |
| 构建／许可 | 桌面与移动构建通过；根 renderer 许可清单 156 项、移动 npm 清单 129 项，无待核对项。保留 Capacitor 原生 MIT／Apache 通知。仍有现有大块体积提示。 |

完整套件失败名称：`交付文件同回合去重，后续回合更新仍保留入口` 与 `067 缓存命中也参与交付去重，删除前一个入口后后一个必须恢复`。本轮后续局部 UI／恢复修正采用相关检查，未重复完整套件。

证据均在 Git 忽略的 `.visual/workflow/`：

- `device-pairing/report.json`：测试提交、环境、源文件哈希、开发／构建结果和截图。
- `device-pairing-e2e.log`、`device-pairing-security-tests.log`、`device-pairing-mobile-tests.log`。
- `mobile-connection/report.json`、`device-pairing-mobile-ui.log`：开发／构建 UI 与桥延迟恢复检查。
- `device-pairing-ios-*`：同步、编译、签名、安装和启动回执；`device-pairing-cloud-*`：真实云端 TLS 与用户确认的防火墙规则证据；个人设备标识只留于本机日志。
- `vision-report-device-pairing.md`：实际截图视觉检查。
- `device-pairing-full-tests.log`：完整套件结果。

PC 集成仅将 SSH 网络／认证与 systemd 边界替换成本机 wrapper，后续 CLI、Unix socket、Host、TLS、设备证明和会话持久化均为实际实现。物理扫码使用 Mac 隔离 Bot，手机需同一 Wi-Fi；该隔离测试不能代替公网验证；后续实际云端部署及 iPhone 流量扫码已另经用户确认。测试模型不请求外部模型服务。

## 剩余范围

Android 原生扫码／Keystore／TLS 适配及原生构建、设备测试尚未执行；Web 只预览界面。iOS 附件上传与交付物宿主能力已接入（见下文），推送未接入。真实公网扫码连接已完成；外部模型流式回复、锁屏／后台恢复、系统剪贴板和 Browser 完整业务、最终原生安全区／键盘交互仍需对应环境验收。

移动端资源宿主仍按统一 API 注入，以上平台工作不进入对话 SDK 核心。当前自有设备具有完整 Bot 账号权限，不包含多人隔离或只读设备权限。

## iOS 文件与照片上传（2026-10-23）

本轮沿用基准提交及当前未提交工作区。系统 PHPicker／UIDocumentPicker 由 HemiBot 原生插件实现，JS 只获取不透明文件 ID、名称、大小、类型和 SHA-256，通过受限读取方法每次读取 256KiB。App 私有缓存有文件保护；HEIC／HEIF 转 JPEG。未新增 npm 依赖或第三方原生源码。

Bot 的 `attachment.upload.begin/chunk/status/complete/cancel` 实现独立暂存、每会话最多 3／全局最多 12 个进行中上传、大小／分片编码／偏移校验、完整 SHA-256 校验和持久化完成回执。进行中暂存一小时，完成回执一天；完成才登记到原有附件目录。重复分片核对已有字节，完成回执丢失仍返回同一附件，重启可续传。实际设备网关只增加这 5 个鉴权方法，原有请求大小、设备批准与撤销、TLS 固定证书规则保持不变；PC 原有 `attachment.add` 兼容。

移动 workspace 上传协调器串行传输，元数据按 Bot 和会话保存，失败／重开后重试沿用上传身份和服务端偏移。传输持有对应 SDK client，切换会话不会错误附加到当前草稿；完成后合并附件元数据并保留文字。SDK 保持纯前端，不引入原生文件或网络依赖。App 支持附件单独发送；补齐 Bot 旧的非空文字校验，空消息仍拒绝。上传／失败状态阻止发送，附件列表可取消／重试／移除；排队修改期间不新增附件。

测试记录：macOS26.5.1 arm64／Node22.22.3／Xcode26.6，`node --test apps/mobile/test/attachment-uploads.test.mjs apps/mobile/test/workspace-client.test.mjs src/main/bot/attachment-uploads.test.mjs src/main/bot/device-gateway.test.mjs src/main/bot/host.test.mjs` 33/33 通过。覆盖真实 Host 的大于1MB文件、实际签名 TLS 分片、撤销拒绝、字节校验、重启／回执重试、会话隔离、取消迟到响应、附件单独发送到执行器。`node scripts/verify-mobile-uploads.mjs` 开发／构建各5组通过，含进度、失败、重开重试、取消、320/375/390/768/1440及键盘缩短容器，原生选择器和文件读取为边界替身。相关源码、截图和报告在忽略目录 `.visual/workflow/mobile-uploads/`。系统照片／文件选择及真实手机发送需安装后用户操作验收，不以浏览器替身代替。

本轮不重复全套测试；此前未通过的两个交付去重测试仍按原记录保留。Android 原生适配、远端交付物预览／原生保存分享、后台系统上传不属于本次实现。

部署与真机准备：云端标准组件安装在 npm 下载阶段超时，未切换旧服务；确认本次不增加运行依赖，且更新前 `host.mjs` 哈希与已审计部署一致后，从现运行 release 创建保留现有依赖的副本，仅替换 `host.mjs`、`device-gateway.mjs` 和新增的上传模块，语法检查后原子切换。旧 release 保留供回退。启动后核对原实例身份与这三个源文件哈希，并向实际 Bot 上传1,200,000字节临时文件，完成回执幂等及文件 SHA-256 均通过，随后删除临时会话及其附件。未更改端口、证书或已有设备身份。iOS 最新本地资源已编译、严格验证签名、覆盖安装并启动，未卸载清空手机数据。相关证据：`mobile-uploads-cloud-code-only.json`、`mobile-uploads-install.json`、`mobile-uploads-launch.json`、`mobile-uploads/source-manifest.json`。

## iOS 交付物宿主能力（2026-10-24）

用户已确认上一轮“照片和文件都能上传发送”。本轮沿用同一基准提交与未提交工作区，保留已验收上传、配对、队列、键盘容器和 SDK 锚点行为；没有提交或推送。

`resource-host.ts` 将 Bot RPC 与注入的 `MobileResourceFiles` 组合成标准 `ConversationFlowHost.resources`。workspace 提供资源能力，App 通过 `createMobileHost(workspace.resources)` 注入 SDK，承接 `preview.open` 打开紧凑的移动预览面板；仍使用 SDK 的交付物卡片、图片租约、Markdown 和标准资源操作。支持已登记文件及上传附件，文字／图片预览、正文路径受控预览、系统 QuickLook、保存到“文件”、分享。未登记正文路径只读，不提升为导出权限。

Bot 新增仅供已批准设备的 `resource.stat`／`resource.chunk`：每次重查会话归属和原文件范围，拒绝未登记交付、其他会话、控制数据及变化后的符号链接；最多20MiB，分片最多256KiB。以受控文件描述符读取，文件版本来自设备／inode／大小／mtime／ctime，元数据提供 SHA-256。计算摘要时也使用有界分片读取，文件变化返回冲突。原 PC 的文件 API 和已上线上传 API 保持兼容。

`HemiResourceStore.swift` 管理私有、受保护的临时文件，校验大小／偏移／SHA-256，最多8个暂存／呈现文件。`HemiBotPlugin` 用系统 QuickLook、UIDocumentPicker 导出、UIActivityViewController 分享；原生仅在系统面板已经呈现后返回 `presented`，不声称用户已经保存或分享。面板期间保留原始文件，dismiss／完成／取消后清理；App 重启清理旧资源缓存，上传缓存独立保留。JS 操作无论成功失败均释放暂存，已呈现面板由原生继续持有。关闭预览时中止未呈现的下载，图片 URL 随租约清理。没有新增 npm 依赖、第三方原生代码或公开下载链接。

验证环境 macOS26.5.1 arm64／Node22.22.3／Xcode26.6，基准 HEAD `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加工作区。定向测试42/42通过（移动端、Bot Host、设备网关、上传兼容）；资源协议最后修改后复查11/11通过。Swift 真实暂存校验和生产 Network.framework／ES256客户端到隔离真实 TLS 网关、真实登记文件、原生 SHA-256 缓存的1.2MB读取通过。开发／打包页各3组通过，覆盖 SDK 卡片、真实字节、Markdown／图片、正文路径只读、系统操作边界、错误重试、取消迟到响应、320/375/390/768/1440、系统深色偏好和键盘缩短容器。未运行全套测试或广泛桌面回归；此前无关的两个交付去重失败仍见原记录。

云端因上一轮已确认 npm 安装超时且本次无运行依赖变化，直接从现运行 release 建立保留依赖的副本，仅替换 Host／网关／新资源模块；先核对原源文件哈希，语法检查后原子切换，保留旧 release 供回退。重启后核对原实例身份和3个源文件哈希；对实际云端现有2,407,403字节已登记交付文件只读分片取回，在服务器端比较完整摘要，通过且未修改用户文件。iOS 编译、严格签名与覆盖安装通过，dist／native public／签名 App 的7个运行资源逐个哈希一致。最后一次自动启动因 iPhone 锁屏被系统拒绝（CoreDevice Locked），需解锁后手动打开 Hemi。系统 QuickLook、“文件”导出、分享的物理操作已请求用户验收，尚不以浏览器边界替身宣称完成真机业务验收。Android 原生适配、后台系统传输和推送不在本次范围内。

证据在 Git 忽略目录 `.visual/workflow/mobile-resources/`、`mobile-resources-*.log/json`、`vision-report-mobile-resources.md`，含环境、源码哈希、测试与截图、云端校验及安装回执。

系统分享面板可能包含用户主动选择的“存储图像”，因此补充 `NSPhotoLibraryAddUsageDescription` 的写入用途说明；启动和 PHPicker 选择不请求完整照片库权限，系统仅在相应保存操作时处理授权。参考 [Apple 照片库写入用途说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsphotolibraryaddusagedescription)。

## 交付文件加载进度与缓存（2026-10-24）

真机反馈文件加载偏慢。本轮确认旧实现每256KiB均需独立 challenge + 签名 HTTPS RPC，缩略图、预览、系统操作之间还会重复读取。读取分片调整为1MiB，写入原生暂存仍以256KiB进行；原单文件20MiB上限、逐片归属与版本检查、SHA-256校验、设备鉴权和配对规则保持。旧客户端继续按较小分片读取。

App 新增 `resource-cache.ts` 与进度订阅，保持 SDK 核心不依赖原生或网络。进度来自完整收到的分片字节，元数据核对／排队／下载／校验／准备系统文件区分显示。只有通过完整性校验的文件进入缓存；同一文件多使用者共享一个读取作业，各自取消互不影响，最后一个使用者取消才停止传输。刷新会中止旧作业并拒绝迟到结果，失败／未完成数据不进入缓存。

缓存为本地内存缓存，固定10分钟到期，最多8项／48MiB，LRU淘汰，前台每分钟及每次读取时清理。按 Bot实例、会话、generation、资源kind/id/version隔离；系统操作从同一缓存 Blob 写入原生保护暂存，不再重复联网。解码文本按需处理，Office/PDF提取文本小于4MiB才复用并计入容量。缓存不会进入localStorage、磁盘或二维码；App重启清空，主动断开及明确权限拒绝也清理。“刷新文件”可立即重取；过期或移除缓存不销毁仍在展示的租约。

定向验证：缓存／资源／实际TLS网关16/16通过；移动端全部及Host／网关相关回归44/44通过，另外新增的8项缓存定向覆盖固定TTL、容量与LRU、请求合并、单使用者取消、最后取消、迟到结果、至多两路下载、原始字节复用、过期／刷新及坏摘要拒绝。首轮44项中的一个传输测试只在清理临时目录时出现ENOTEMPTY；该测试单独4/4及同组复查44/44均通过，未更改其产品或测试实现。开发／打包页各3组通过，含真实1MiB/total字节和百分比、缓存命中不增加RPC、320短屏、键盘、刷新及取消。截图检查发现初次剩余时间四舍五入可显示11分钟，已修为不超过实际10分钟上限，进度色使用现有灰绿令牌。

编译运行生产 Swift TLS/签名客户端，确认1MiB响应可经真实网关读取并拆分写入原生暂存。云端仅替换新资源读取模块，从旧release创建保留现有依赖的副本，先核对原hash再原子切换；实际2,407,403字节已登记文件从10片降到3片，逐字节摘要匹配。记录中的78ms是服务器本机读验耗时，不代表手机公网加载时间；物理蜂窝网体验仍需用户反馈。没有新依赖、端口或证书变化，没有提交或推送。

基准提交仍为 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加未提交工作区；macOS26.5.1 arm64／Node22.22.3／Xcode26.6／iPhone16Pro/iOS27.0.1。证据在忽略目录 `mobile-resource-cache-*.log/json`、`mobile-resources/`、`vision-report-mobile-resource-cache.md`。本轮不重复全套测试。

最后补充无效资源标识的进度订阅回退，避免文件标识错误升级为整页渲染异常，缓存定向8/8通过。新版签名安装通过；首轮自动启动曾因iPhone锁屏被系统拒绝，最后已成功启动到 Hemi，等待用户比较首读进度与第二次加载速度。当前缓存仅存在于 App 内存，未增加持久化文件缓存。

## 文件预览文案精简（2026-10-24）

用户已确认进度和再次加载正常。根据反馈移除预览中的缓存说明、剩余分钟数和对应计时器；下载只显示字节数／总大小、百分比和进度条，其余状态缩短为“等待中／加载中／校验中／准备中”。保留“刷新”“重试”、必要错误及系统预览／保存／分享操作，缓存策略与传输逻辑不变。

验证基准仍为 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加未提交工作区；macOS26.5.1 arm64、Node22.22.3、Xcode26.6、iPhone16Pro/iOS27.0.1。`npm run build --workspace @hemi/mobile`、`node scripts/verify-mobile-resources.mjs`（开发／打包页各3组，包含不再显示冗余缓存文案及缓存命中不增加RPC）、`node scripts/check-spacing.mjs`、`git diff --check` 通过；检查构建页预览及320短屏下载截图。`npx cap copy ios`、原生Debug构建、签名校验、覆盖安装与启动成功，dist／iOS资源／App包7项资源哈希一致。未改Bot服务、传输或缓存实现，未重复全套测试；本次文案调整尚未收到新的真机反馈。证据见忽略目录 `mobile-resources/` 及 `mobile-resource-copy-ios-*.log/json`。

## App 常驻说明文案精简（2026-10-24）

移除输入框下方“草稿自动保存在本机”及重复的任务／离线状态，工作目录入口保留并允许使用整行宽度。输入框占位缩短为“发送消息…”，离线和编辑队列保持对应提示；空对话／连接页删除与输入、扫码操作重复的引导句。移除思考强度面板开头说明、附件选择器的重复副标题及发送过程说明；附件数量／大小限制保留。目录提示缩短，明确是 Bot 服务器目录。保留不确定操作防重复发送、离线未发送、错误、模型差异、一次性扫码与权限范围、断开／取消授权后果。

本次只调整移动端界面文案和相关样式，不改变 SDK 草稿、队列、配对、上传或执行逻辑。React 检查未增加状态／副作用或依赖，控制按钮及可访问标签保留。环境与基准提交同上；移动端构建、`node scripts/verify-mobile.mjs`、`node scripts/verify-mobile-settings.mjs`、`node scripts/verify-mobile-uploads.mjs` 均通过开发／打包检查，覆盖320/375/390/768/1440、短屏、系统深色偏好、键盘容器和面板焦点恢复；spacing 与 diff 检查通过。设置验证首轮遇到既有模型按钮选择器依赖名称格式的问题，按实际 Host 返回的模型描述定位后复查通过；目录空态选择器随文案同步。未运行全套测试。

原生Debug构建、签名校验、覆盖安装与启动成功，dist／iOS资源／App包7项资源哈希一致。新文案尚未收到本轮真机反馈。证据见忽略目录 `mobile-copy-manifest.json`、`mobile-copy-*.log/json`、`vision-report-mobile-copy.md` 及三个验证脚本的截图／报告。
