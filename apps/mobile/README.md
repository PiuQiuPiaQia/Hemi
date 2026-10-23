# Hemi Mobile

React + Vite + Capacitor 8 移动端工程。Web、iOS 和 Android 使用同一份前端，消费仓库中的 `@hemi/conversation-flow`，不启动额外后端服务。

目前是可运行的初始化工程：通过共享 SDK 会话核心完成模拟流式回复、停止、编辑、复制、排队、断线恢复及草稿保存。演示会话与待发送记录保存在 sessionStorage，草稿保存在 localStorage；连接说明与开源许可也可本地查看。**尚未连接真实 Bot**，不收集或保存 SSH／模型凭据。

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
npm run sync:mobile        # 构建并同步本地资源、原生插件
npm run ios:mobile         # 同步后打开 Xcode
npm run android:mobile     # 同步后打开 Android Studio
```

`ios/` 和 `android/` 是 Capacitor CLI 生成并纳入版本管理的原生工程；不要在应用自己的 `dist/` 或原生工程内的复制资源目录改前端源码。iOS 使用 Swift Package Manager。初始标识为 `ai.hemi.mobile`，发布前配置团队签名、证书和各商店信息，并替换模板中的原生应用图标及启动图。

当前依赖对应的工具要求见 [Capacitor 环境说明](https://capacitorjs.com/docs/getting-started/environment-setup)：Xcode 26+、Android Studio 2025.2.1+。Android 构建所需具体 SDK、Gradle 和 Java 版本以 `android/variables.gradle`、Gradle wrapper 和所用 IDE 为准。浏览器开发不需要安装原生工具链。

## 边界

| 位置 | 职责 |
| --- | --- |
| `packages/conversation-flow` | 共用消息、Markdown、思考、工具和卡片展示；保留现有样式 |
| `src/app.tsx` | 页面与 SDK 组合；使用共用 core、React hook、队列和动作处理器 |
| `src/composer.tsx` | 输入框布局；草稿、发送、排队、受理清理由 SDK 管理 |
| `src/host/capacitor-host.ts` | 同名宿主 API；原生 Clipboard／Browser，浏览器使用 Web API |
| `src/demo.ts`、`src/demo-session.ts` | 合成数据与本机通信替身；提供 snapshot／command／回执和存储、生命周期接口，不是 Bot |
| `ios/`、`android/` | 平台工程、原生能力、签名与打包 |

资源读写、保存和分享当前未注入，SDK 能力声明为不可用。后续接入 Bot 文件接口后再开放。应用只允许网页链接，文件导航应通过资源 API 处理。

## 下一步：连接已有 Bot

已核对当前桌面 Bot 实现：通过严格检查主机密钥的 SSH 执行云端 CLI，CLI 与常驻 Host 的 Unix socket 通信；没有公网 HTTP／WebSocket 控制接口。因此不能把地址填进浏览器 `fetch` 就完成连接。

接入时保持以下分层：

1. 原生平台 SSH 插件负责主机密钥确认、连接、命令、传输和取消；凭据引用保存在 iOS Keychain／Android Keystore 对应的安全存储中。
2. 独立 Bot 客户端负责握手版本／实例身份、会话快照、轮询或订阅、稳定操作 ID、回执核对、断线重连和附件。浏览器不提供 SSH 时明确报告不可用。共享前端状态与恢复逻辑已由 `@hemi/conversation-flow/core` 承载，不另设 Bot Client 包；本层只适配真实协议。
3. 适配层将 Bot 协议转换为 SDK 会话快照和命令，SDK 共用时间线投影与普通消息操作；Bot 文件读写映射为宿主资源 API。SDK 不感知 SSH 和凭据。
4. 应用进入后台后云端任务继续；恢复前台时重新核对实例、快照与操作回执。超时或断线不代表有副作用的操作失败，不能自动重放。

无需增设中转后端。原生 SSH、凭据安全存储、真实 Bot、设备后台恢复、文件传输与推送尚未接入。前端恢复逻辑已抽入 SDK；设备事件及真实连接仍由原生宿主适配。浏览器能预览同一套 UI，不意味着浏览器具备 SSH 连接能力。

## 开源与验收

构建前自动生成 `public/licenses/`，将 npm 运行依赖（包括 Capacitor 原生源码包）及 SDK 自带通知放入本地资源，连接说明页可离线查看。`dist/.vite/license.md` 另记录实际 Web bundle 许可证。生成目录不入库，锁文件记录确切版本与完整性摘要。

原生平台代码来自锁定版本的官方 Capacitor 模板。原生首次成功编译后，还需核对最终 SwiftPM／Gradle 依赖及许可清单；Web 构建通过不等于原生编译、插件或设备验证通过。当前验收范围见 [初始化记录](../../docs/technical/mobile-monorepo.md)。
