# 移动端与 monorepo 初始化

> 2026-10-23 更新：移动端已移除离线演示、模拟数据和示例文件，启动只显示正式连接页。共享 SDK 与真实 Bot 协议适配器保留；原生 SSH／安全存储仍待接入。当前状态见 [移动端实施记录](mobile-app-implementation.md)，下文初始化与演示验收数字属于历史记录。

使用 npm workspaces，统一根目录锁文件和 `npm ci`。不引入额外任务调度工具。工作在 `codex/conversation-flow-sdk` worktree，保持主检出中的 Bot 等并行修改原状。

```text
Hemi/
├── apps/
│   └── mobile/                 React + Vite + Capacitor；iOS / Android 原生工程
├── packages/
│   └── conversation-flow/      共用纯前端对话流 SDK
├── src/                       现有 Electron 桌面应用
├── examples/conversation-flow/ SDK 的独立安装／原生桥示例
└── package-lock.json          正式工作区的统一锁文件
```

`examples/conversation-flow` 保留独立依赖与锁文件，用于验证发布包在仓库外可消费；不作为正式应用 workspace。桌面入口不迁移，原有开发、构建和打包路径不变。移动端不引入桌面 Node、Electron、preload 或 IPC。

## 技术选择

React + Capacitor 直接复用已经抽离的 React DOM 对话流及 CSS。移动端前端打包在应用内，以同名宿主 API 对接各平台能力。原生工程通过官方 CLI 生成；iOS 使用 SPM。

当前实现系统剪贴板和网页打开；未接入的资源能力声明不可用。复制和打开链接由应用的 host 实现完成，SDK 不引用 Capacitor。页面使用安全区和可视 viewport 高度，输入框归宿主管理；键盘、原生导航与平台生命周期仍须设备验证。

参考：[Capacitor 安装](https://capacitorjs.com/docs/getting-started)、[环境要求](https://capacitorjs.com/docs/getting-started/environment-setup)、[原生平台生成](https://capacitorjs.com/docs/cli/commands/add)、[Clipboard](https://capacitorjs.com/docs/apis/clipboard)、[Browser](https://capacitorjs.com/docs/apis/browser)。

## 初始化范围（会话核心扩展前）

完成移动端工程、共用 SDK 消费、宿主适配、输入／停止／本地编辑、明确标识的离线流式演示、原生平台骨架和本地许可页面。没有额外后端服务。Bot 连接是后续独立实现：当前生产 Bot 走 SSH → CLI → Unix socket，需要原生 SSH 与安全存储，不能用虚构的 HTTP 地址替代。Bot 分支与 SDK 分支最终集成时，应保留现有会话 bridge 和 SDK 宿主投影两方的职责。

## 初始化验收记录

2026-10-23，macOS arm64，Node 22.22.3，Chrome 155.0.8059.85。基于 `52460a00bcc2ee5bf7b491a215527f29a155a847` 加当前未提交 SDK／移动端工作区；没有提交、推送或发布。

| 检查 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 统一工作区安装通过；原有锁文件位置的包无版本升级 |
| `npm run build:mobile` | 移动端类型检查、SDK 与 Web 构建通过 |
| `npm run verify:mobile` | 开发和构建页面各通过 9 组集成检查 |
| 响应式与生命周期 | 320／375／390／768／1440；可视区域缩短；系统深色下保持声明的 light 外观；发送、停止、编辑撤回后续历史并重发、复制、流式期间切换页面均通过 |
| 网络与宿主 | 无 Electron 全局对象、无外部请求、无 renderer 错误；验证实际浏览器剪贴板 |
| `npm run sync --workspace @hemi/mobile` | iOS／Android 插件与前端资源同步通过；8 个构建文件在两端的 SHA-256 与 Web 输出逐个一致 |
| 原生静态检查 | appId 一致；无发布配置中的远程 server URL；SPM 精确锁定 Capacitor 8.5.3；`plutil -lint` 的 plist 与 Xcode 工程通过 |
| `npm run build` | 现有桌面类型检查和 renderer 构建通过 |
| `npm run test:sdk` | 16／16 通过 |
| 许可 | 移动端 124 个 npm 运行依赖无缺失通知；桌面生成并 `--check`，154 项，无待审通知 |
| 原生来源 | 官方 Capacitor 8.5.3 平台模板；Browser 8.0.5／Clipboard 8.0.1 源码与 MIT 许可随 npm 锁定；Gradle wrapper 8.14.3 的 jar SHA-256 与官方发布摘要一致，另保留上游 LICENSE |
| 规范 | spacing 与 `git diff --check` 通过；React hooks、稳定宿主回调、定时器清理、输入标签和按钮触达尺寸已检查 |

原生 wrapper 摘要：`7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172`。来源：[官方 wrapper 摘要](https://services.gradle.org/distributions/gradle-8.14.3-wrapper.jar.sha256)、[Gradle 8.14.3 许可](https://github.com/gradle/gradle/blob/v8.14.3/LICENSE)。

报告和截图在忽略目录 `.visual/workflow/vision/mobile/`：`report.json`、`native-sync.json`、`source-manifest.json`。源码清单包含正式移动端和 SDK 的源码、锁文件及验证脚本；用于定位此次未提交验收状态。

剩余范围：当前机器只有 Xcode Command Line Tools，没有完整 Xcode、Android Studio、Java 或设备环境，未编译 IPA／APK，未验证原生插件、真机键盘／安全区或原生生命周期。未连接真实 Bot；SSH、安全存储与平台后台恢复需后续实施。此次没有改变桌面 UI／IPC／生产服务，未重复完整单测或 Electron 回归。两个 Web 构建仍提示现有依赖带来的大 chunk，保留为后续体积优化项。


## 会话核心扩展

断线恢复、草稿、队列、消息投影与普通消息操作现统一由 `@hemi/conversation-flow/core` 管理。移动演示已移除页面中的独立会话状态和流式计时逻辑；具体范围、真实桌面 IPC 与移动验证见 [会话核心实施说明](conversation-flow-sdk-session-core.md)。以上初始化验收数字保留为当时记录，扩展后的结果以会话核心记录为准。

## 确认交互稿后的移动端实现

移动端正式工程已开始迁入确认后的布局和交互，继续位于 `apps/mobile`，复用原 SDK。实现范围、当前验证提交及原生连接缺口见 [移动端实施记录](mobile-app-implementation.md)。以上初始化阶段的结果保留为历史记录，不替代本轮验证。
