# iPhone 真机运行

这是安装到 iPhone 的 Capacitor 应用，使用项目内打包的前端与共用对话 SDK。通过 Xcode 编译、签名、安装和调试；不使用手机浏览器、局域网预览或 live reload。

## 首次准备

1. 安装并首次启动完整 Xcode 26 或更新版本，按 Xcode 提示完成组件安装。只有 Command Line Tools 无法构建、签名和安装 iOS App。在 Xcode → Settings → Components 安装 iOS Platform Support；Xcode 26.6 即使只构建真机 App，也会要求这项平台支持，下载项可能同时包含 Simulator。
2. 在 Xcode → Settings → Accounts 添加自己的 Apple ID；本机测试可使用 Personal Team，也可使用已有开发者团队。
3. 用数据线连接 iPhone，解锁并信任这台 Mac；在 Xcode 的 Devices and Simulators 中完成设备配对。在 iPhone 的设置 → 隐私与安全性 → 开发者模式中启用开发者模式并按提示重启。
4. 确认 Xcode → Settings → Locations 的 Command Line Tools 指向完整 Xcode。也可在当前终端指定已安装 Xcode 的 Developer 目录：

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version
```

不需要把 Apple ID 密码或签名证书写进项目。当前工程使用自动签名，Team 由实际开发账号决定。

## 构建并安装

在仓库根目录运行：

```sh
npm run ios:mobile
```

该命令构建共享 SDK 和移动端，生成许可并同步本地资源、原生插件，然后打开现有 iOS 工程。

在 Xcode 中：

1. 选择 `App` target，在 Signing & Capabilities 保留 Automatically manage signing，并选择自己的 Team。
2. 选择 `App` scheme，运行目标选择连接的实际 iPhone。
3. 点击 Run（⌘R）。Xcode 完成构建、签名后将应用安装并启动到手机。

当前 App 名为 Hemi，Bundle ID 为 `ai.hemi.mobile`，最低 iOS 版本为 15。iOS 使用 Swift Package Manager，不需要另起 Web 服务。应用应从本地打包资源启动；可以关闭电脑上的 5300／5175 预览服务再检查。

### 本机 Debug 签名配置

`debug.xcconfig` 可选加载同目录的 `signing.local.xcconfig`。可以在该文件中配置自己的 `DEVELOPMENT_TEAM`，Debug 构建会自动使用它；该文件已被 Git 忽略。请使用实际开发账号的 Team ID，证书和私钥由 Xcode／钥匙串管理，不写入仓库。

通过 Xcode 的 Team 下拉框选择团队会直接修改 `project.pbxproj`。准备提交前，应将本机团队设置移到上述忽略文件，并移除这项个人设置对应的工程文件改动。Release 签名独立配置。

## 后续命令行运行

首次签名、配对完成后，在仓库根目录执行：

```sh
npm run build:mobile
npm run devices:ios --workspace @hemi/mobile
npm run run:ios --workspace @hemi/mobile -- --target <实际iPhone的设备ID>
```

`run:ios` 调用 `cap run ios`，会同步已构建资源并进行原生编译、安装和启动。必须明确选择实际 iPhone 的设备 ID；不要用模拟器运行结果代替真机验证。

## 这轮真机要验证的内容

- 首次启动、正式连接页及许可面板；旧演示启动标记不再生效。
- 字体、安全区、键盘弹出／收起、中文输入、长消息换行、输入区可见范围。
- 输入区已有焦点时打开／关闭顶部模型、目录和连接面板，确认顶部不跳动；反复展开／收起键盘、编辑多行消息和目录路径，确认输入区不被盖住、关闭后没有残留偏移。
- 抽屉搜索、新建／切换会话、滑动关闭、草稿和滚动位置。
- 输入框模型、思考强度与云端工作目录选择；新消息使用选择的配置，重开读回服务器设置。
- 执行中排队、编辑和撤回、停止后明确继续；切换会话时回复不中断。
- 原生 Clipboard 复制；点击实际网页链接时使用系统 Browser 宿主。
- 锁屏、切后台、返回前台及退出后重开，检查缓存和草稿，并记录实际表现。

iOS 已接入原生扫码、Keychain、设备签名和固定证书 HTTPS 连接。PC 启用 Bot 设备入口并生成邀请后，可走扫码 → 预览 → 申请 → 双端核对 → PC 允许的真实流程。没有域名时可使用公网 IP，详见 [Bot 设备连接](../../../docs/technical/bot-device-pairing.md)。照片／文件上传及交付物的系统预览、保存和分享已接入；推送尚未接入。

启动时 `SceneDelegate` 必须创建 `HemiBridgeViewController`；它在 `capacitorDidLoad` 注册 `HemiBotPlugin`。只修改 Main.storyboard 会被 scene 启动代码覆盖，导致扫码按钮不可用。真机验收需检查实际扫码入口，不能仅以编译成功判断插件已加载。

键盘高度由官方 `@capacitor/keyboard` 8.0.6 提供，配置为 `resize=none`；整个会话容器的高度统一减去键盘高度，flex 使输入框上移、对话区缩短，SDK 保持原有滚动意图。`ios.scrollEnabled=false` 固定最外层 WKWebView 滚动，`contentInset=never`，CSS 内部滚动保留。不要再叠加原生 resize 或 `visualViewport.height` 的第二次缩放。修改依赖后必须执行 `cap sync ios`，仅 copy 资源不会把新插件加入 SwiftPM 与 packageClassList。

## 当前机器检查记录

2026-10-23：已安装并初始化 Xcode 26.6（17F113），Command Line Tools 指向完整 Xcode；安装 iOS 平台支持后，已通过真实 iPhone destination 编译和签名，并将 App 安装、启动到 iPhone 16 Pro／iOS 27.0.1。使用本地打包资源，不依赖预览服务。

基准为 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加当前未提交移动端改动，环境为 macOS 26.5.1 arm64、Node 22.22.3。个人签名 Team 使用上述 Git 忽略文件，签名 App 与日志不提交仓库。

真实设备首次启动被信任检查拒绝时，在 iPhone 的「设置 → 通用 → VPN 与设备管理」中找到自己的开发者 App，按系统提示建立信任后重试。本轮签名校验、描述文件目标设备及有效期检查通过，用户完成信任后启动成功。

实际构建命令使用 `xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -configuration Debug -destination 'platform=iOS,id=<实际iPhone的UDID>' -derivedDataPath /private/tmp/hemi-ios-native.7EZPAd -allowProvisioningUpdates build`。源代码位于 ExFAT 外置盘时，将 DerivedData 放在系统 APFS 临时目录。

构建、部署和当前验证范围见 [移动端实施记录](../../../docs/technical/mobile-app-implementation.md)。首次缺少完整 Xcode／平台组件的错误日志仅是环境准备过程，不代表当前仍被这些问题阻塞。

参考：[Capacitor iOS](https://capacitorjs.com/docs/ios)、[cap run](https://capacitorjs.com/docs/cli/commands/run)、[Apple 真机运行](https://help.apple.com/xcode/mac/current/en.lproj/dev5a825a1ca.html)、[Apple 个人团队与签名](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html)、[开启开发者模式](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)。
