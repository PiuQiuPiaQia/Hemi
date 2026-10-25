# Hemi Mobile

React + Vite + Capacitor 8 移动端工程。Web、iOS 和 Android 使用同一份前端，消费仓库中的 `@hemi/conversation-flow`，不启动额外后端服务。

产品围绕连接已有 Bot：启动页以“连接你的 Bot”为中心，扫码为主入口，手动连接为次入口。手动入口可粘贴 PC 生成的一次性配对内容；连接建立后进入该 Bot 的真实对话与任务。

已按确认的交互稿实现移动端主界面：左侧会话抽屉、顶部模型／目录／连接入口、共用 SDK 对话流，以及与输入框合为一体的紧凑队列。正文 14px、列表与队列 13px、可编辑输入 16px；主要操作保留 44px 点击范围。

输入框工具栏可选择 Bot 模型和思考强度（自动／关闭／低／中／高），底部目录可点击切换。目录面板浏览服务器真实文件夹，支持输入绝对路径、上一级、主目录、默认及最近目录。选择写入当前云端会话，用于之后发送的消息；保留当前草稿。

页面使用固定外壳，只有对话、抽屉和面板内容滚动。iOS 使用官方 `@capacitor/keyboard` 读取键盘高度，关闭原生 resize，统一缩短整个会话容器；输入框随之上移，对话区自动缩短。SDK 在容器高度变化后保持底部锚点，翻历史时保留阅读位置。键盘高度与底部安全区不叠加，也不再重复按 `visualViewport` 缩放。浏览器预览单独使用可视视口高度。焦点切换统一避免带动页面滚动。

启动后进入正式连接页。离线演示入口、预置会话、模拟回复／断线、示例目录／模型和内置示例文件均已移除，也不再读取旧版演示启动标记或缓存。旧本机数据不自动删除。

iOS 已接入原生相机、Keychain 设备身份和固定证书的 HTTPS Bot 客户端。扫码后先预览目标，再申请连接；PC 核对双端验证码并明确允许后，手机读取真实会话、模型与对话流。断线后核对原操作回执，不自动重发未知结果的消息。Android 尚缺对应的原生连接插件，Web 仅作界面预览，均不会模拟连接成功。

## 开发

在仓库根目录使用 Node 22.19+（Node 22）：

```sh
npm ci
npm run dev:mobile
```

打开 `http://127.0.0.1:5300`。原桌面开发仍用 `npm run dev`，桌面源码暂留根目录 `src/`。

```sh
npm run build:mobile       # SDK → 类型检查 → 许可 → Vite
npm run verify:mobile      # 已构建后，验证开发与构建页面
npm test --workspace @hemi/mobile # 与真实 Bot Host 的协议契约检查
node scripts/verify-mobile-settings.mjs # 已构建后，验证设置 UI → 真实 Bot Host；原生桥为边界替身
npm run sync:mobile        # 构建并同步本地资源、原生插件
npm run ios:mobile         # 同步后打开 Xcode
npm run android:mobile     # 同步后打开 Android Studio
```

`ios/` 和 `android/` 是 Capacitor CLI 生成并纳入版本管理的原生工程；不要在应用自己的 `dist/` 或原生工程内的复制资源目录改前端源码。iOS 使用 Swift Package Manager。初始标识为 `ai.hemi.mobile`，发布前配置团队签名、证书和各商店信息。原生应用图标与启动图出自仓库唯一矢量母版 `build/icon.svg`，在 macOS 运行 `npm run build:icons` 重新导出，不要手改这些图片。

当前依赖对应的工具要求见 [Capacitor 环境说明](https://capacitorjs.com/docs/getting-started/environment-setup)：Xcode 26+、Android Studio 2025.2.1+。Android 构建所需具体 SDK、Gradle 和 Java 版本以 `android/variables.gradle`、Gradle wrapper 和所用 IDE 为准。浏览器开发不需要安装原生工具链。

## iPhone 真机测试

通过 Xcode 将本地打包的 Capacitor App 安装到 iPhone，不依赖浏览器或本地 Web 预览服务器。完整步骤见 [iOS 真机运行说明](ios/README.md)。

在 Mac 安装 Xcode 26+，在 Xcode 中配置开发账号和签名 Team，用数据线连接 iPhone、信任电脑并开启开发者模式后，执行：

```sh
npm run ios:mobile
```

Xcode 打开后选择 `App` target、你的 Team 和连接的 iPhone，点击 Run。后续可用 `npm run devices:ios --workspace @hemi/mobile` 列出设备，再使用 `npm run run:ios --workspace @hemi/mobile -- --target <设备ID>` 安装运行；后者使用已构建的本地资源，修改前端后需先执行 `npm run build:mobile`。

已在 iPhone 16 Pro／iOS 27.0.1 上完成原生编译、签名、安装与启动。相机、系统权限、真实 Keychain 恢复等设备验收状态以[实施记录](../../docs/technical/mobile-app-implementation.md)为准；macOS 原生客户端集成测试不能代替这些真机检查。

## 边界

| 位置 | 职责 |
| --- | --- |
| `packages/conversation-flow` | 共用消息、Markdown、思考、工具和卡片展示；保留现有样式 |
| `src/app.tsx` | 页面与 SDK 组合；使用共用 core、React hook、队列和动作处理器 |
| `src/components/` | 会话抽屉、连接页、底部面板、焦点限制与恢复、错误边界 |
| `src/workspace.ts` | 真实 Bot workspace 的类型契约；宿主提供会话目录、模型和稳定 SDK client |
| `src/bot/native.ts`、`workspace-client.ts` | 注入原生鉴权 RPC、真实会话目录与模型，管理 SDK client 生命周期和恢复 |
| `ios/App/App/HemiDeviceClient.swift`、`HemiBotPlugin.swift` | 原生相机、Keychain、设备签名、Network.framework 固定证书 TLS；私钥不进入 JS |
| `src/bot/conversation-transport.ts` | 对接现有 Bot `flow.snapshot`／`flow.command`／`operation.get` 协议；注入经过鉴权的 RPC，不自行开网络服务 |
| `src/composer.tsx` | 输入框布局；草稿、发送、排队、受理清理由 SDK 管理 |
| `src/host/capacitor-host.ts` | 同名宿主 API；原生 Clipboard／Browser，浏览器使用 Web API |
| `ios/`、`android/` | 平台工程、原生能力、签名与打包 |

已连接界面保留抽屉、主对话流、输入区和共用 SDK 队列。消息、草稿、排队、编辑与回执核对仍由 SDK 管理；目录、模型和思考强度来自真实 Bot。iOS 原生文件／照片选择、分片上传，以及交付物预览、保存、分享已接入，界面不会生成示例目录或文件替代这些能力。

模型入口只保留在顶部标题，工作目录入口在右上角。模型和思考强度点选后立即关闭面板并显示新选项，后台串行同步；失败恢复服务器已确认的选择并提示。同步完成前暂缓发送，避免下一条消息使用旧设置。目录仍需选择实际服务器路径并确认。已移除的模型显示明确提示，不暴露内部供应商 ID。

## 连接已有 Bot

PC 继续使用严格核对主机密钥的 SSH 管理现有 Bot。更新 PC 构建与云端组件后，在 Bot → 连接新设备中启用手机可访问的地址，例如 `https://服务器公网IP:29421`，并在服务器防火墙／安全组放行对应 TCP 端口。启用前不会监听公网。Bot 自行生成包含地址 SAN 和 serverAuth 用途的证书，二维码携带证书指纹；无需域名、公共 CA 证书或中间服务器。

1. PC 生成有效期 120 秒的邀请，不包含长期凭据。
2. iPhone 扫码并预览 Bot 地址，提交申请；本机生成独立 P-256 设备密钥并保存于 Keychain。
3. PC 与手机核对六位码，PC 勾选确认后明确允许该请求。仅扫码无法读取对话或执行任务。
4. 手机通过原生 HTTPS 客户端使用设备签名访问 Bot 的受限会话 RPC；私钥留在原生层。云端任务在手机离线时继续。
5. PC 可单独撤销设备；后续 RPC／重连被拒绝，已受理任务和已缓存内容不会被远程回滚。

手机可使用流量或 Wi-Fi，只需能访问 Bot 的入口。使用 Mac 本机 Bot 做设备测试时，同网要求来自这次测试拓扑，不是产品限制。当前不提供原生 SSH 凭据导入；手动入口用于粘贴一次性邀请。部署、证书续期及协议细节见 [Bot 设备连接](../../docs/technical/bot-device-pairing.md)。

SDK 不感知相机、Keychain、TLS 和设备身份。它仍负责对话快照、消息、草稿、排队、稳定操作 ID 及未知回执恢复；原生连接层将经过鉴权的 Bot RPC 注入同一套 transport。模型／思考设置与目录浏览走宿主 workspace API；iOS 附件上传和交付物读取走宿主文件 API 与 Bot 分片接口；保存／分享使用系统面板，推送仍待接入。

## 开源与验收

构建前自动生成 `public/licenses/`，将 npm 运行依赖（包括 Capacitor 原生源码包）及 SDK 自带通知放入本地资源，连接说明页可离线查看。`dist/.vite/license.md` 另记录实际 Web bundle 许可证。生成目录不入库，锁文件记录确切版本与完整性摘要。

原生平台代码来自锁定版本的官方 Capacitor 模板。iOS 已核对锁定的 SwiftPM 8.5.3、Browser 和 Clipboard 源码许可；Android 原生构建与最终依赖仍待验证。当前验收范围见 [移动端实施记录](../../docs/technical/mobile-app-implementation.md)，历史记录见 [初始化记录](../../docs/technical/mobile-monorepo.md)。

## iOS 附件上传

点击输入框“＋”选择“照片”或“文件”。每条最多 3 个附件；图片（JPEG／PNG／WebP／GIF）10MiB，文本／Markdown／PDF／DOCX／XLSX／PPTX 20MiB。HEIC／HEIF 选择后转 JPEG 再校验限制。使用系统 PHPicker 和 UIDocumentPicker，所选文件暂存在 App 私有缓存；不请求整个照片库访问权限。

附件以 256KiB 分片沿用设备签名 TLS RPC 发送到自己的 Bot，不经过其他服务。界面进度来自 Bot 确认的字节数，支持取消、失败重试、重开后手动续传；系统清理缓存后需重新选择。App 退到后台时不承诺系统后台传输。SHA-256 与大小校验完成后，附件元数据才进入共用 SDK 草稿，支持附件单独发送和现有队列。未完成／失败上传会阻止发送，可移除或重试；切换对话保留各自草稿。

取消立即停止本机等待，并尝试取消 Bot 暂存；断网时远端暂存最多保留一小时，完成与取消竞争时可能留下未引用的已登记附件。取消不会撤回已经发送的消息。原始字节不写入 localStorage，也不放入二维码。Android 尚缺原生 Bot 插件与选择器适配，本次不宣称 Android 可用。

定向检查：`node --test apps/mobile/test/attachment-uploads.test.mjs src/main/bot/attachment-uploads.test.mjs src/main/bot/device-gateway.test.mjs`；构建后运行 `node scripts/verify-mobile-uploads.mjs` 可检查开发与构建 renderer，经原生桥边界替身调用真实 Host。

## iOS 交付物与附件预览

已登记的交付文件可从 SDK 卡片打开，图片可加载缩略图并预览，Markdown／文本在 App 阅读，PDF／Office 可读取文字并使用“系统预览”（QuickLook）。其他格式可交给系统支持的应用处理。底部提供“系统预览、保存到文件、分享”；保存和分享打开 iOS 系统面板，由用户选择位置／目标，取消不会显示“保存成功”。每个文件最多20MiB，能力按会话和 Bot 注入，共用 SDK 不引用原生 API。已上传附件也能打开和导出。

原始文件沿用设备签名 TLS 分片下载，每片最多1MiB。服务器每片重新检查交付归属与文件版本；下载后 SHA-256 校验通过才呈现系统面板。文件只暂存于 App 私有缓存，系统面板持有期间保留，关闭面板后清理。预览图片的对象 URL 随资源租约释放。正文里未登记的普通文件链接沿用现有受控预览规则，不开放系统导出操作。

验证：`node scripts/verify-mobile-resources.mjs` 检查开发／构建 renderer；`node scripts/verify-mobile-resource-store.mjs` 编译并运行生产 Swift 暂存实现；`node scripts/verify-mobile-resource-device.mjs` 验证生产原生 TLS／签名客户端经真实 Bot 网关读取交付物并落入原生校验缓存。系统面板的实际操作需 iPhone 验收。Android 原生能力仍待适配。

### 文件加载进度与短期缓存

文件读取显示实际已接收字节／总大小与百分比，校验、排队和准备系统文件各自显示状态。文件读取分片提升到1MiB，已完成并通过 SHA-256 的原始文件在内存缓存10分钟（固定到期，不随使用延期），最多8项／48MiB，按最近使用淘汰。缩略图、预览、系统预览、保存、分享复用同一份数据；同一文件并发请求合并，冷下载最多两个并行。

缓存按 Bot、会话、代际和资源版本隔离。到期后下次读取重新取原文件，预览中的“刷新”可立即绕过缓存。断开 Bot 或确认权限拒绝时清理；退出／重启 App 后清空，不保存到 localStorage。已打开的内容不会因缓存到期突然消失；已下载的新版本在下次读取或刷新后展示。普通正文路径仍只支持预览，系统操作的临时文件仍在系统面板关闭后清理。界面只显示必要的进度、操作与错误，不显示缓存说明或剩余时间。
