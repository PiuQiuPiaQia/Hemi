# 对话流 SDK 首版实施记录

2026-10-23，Asia/Shanghai。实现位于独立 worktree `codex/conversation-flow-sdk`，当前改动留在工作树中供评审，未公开发布 npm 包。

## 交付内容

- [`packages/conversation-flow`](../../packages/conversation-flow/README.md)：`@hemi/conversation-flow@0.1.0`，React 19 组件、公开类型、预编译作用域 CSS、Web/原生桥适配器、声明文件、许可证和独立构建入口。
- [`DesktopConversationFlow`](../../src/renderer/src/windows/voice/conversation-flow.tsx)：将 Hemi 的时间线、任务、工作流详情和模型目录转成展示数据；统一处理业务动作。`VoiceScreen` 已改为消费 SDK，队列、主输入框、语音、侧栏和预览容器继续由桌面管理。运行摘要在原位置组合 SDK 同一部件。
- [`createDesktopFlowHost`](../../src/renderer/src/windows/voice/lib/conversation-flow-host.ts)：复制、链接、受控文件读取、打开程序和目录定位映射到现有生产 IPC。
- [`examples/conversation-flow`](../../examples/conversation-flow/README.md)：普通 React 消费示例和单文件离线 HTML，使用合成数据，支持 Web、触屏、多实例、表单与资源交互。iOS Swift 与 Android Kotlin 最小壳展示统一桥接方式。

SDK 不导入 Electron、Node、Hemi 服务、模型客户端、SSH、工作流引擎、应用别名或 `window.hemiVoice`。包根导入没有 DOM/网络副作用；虚拟列表在挂载后测量。前端依赖被明确声明，React 与 React DOM 为 peer dependencies。

## 关键实现

`ConversationFlow` 通过 props 接收累计展示数据，通过 `onAction` 发出业务意图，通过 `host` 使用环境能力；ref 只提供滚动和定位，不另设消息写入口。环境、会话、代次变化会重建展示作用域。局部状态和资源缓存不跨实例共享。

保留现有正文、思考/工具分组、子任务、错误重试、文件缩略图、工作流准备/人工输入、权限队列、回复复制和虚拟列表。桌面保留生产文件查证与预览，SDK 不扩大路径权限。消息行和纯展示逻辑复用现有实现，外围页面未重做。

资源使用 `ResourceRef(id, version)` 和租约；视口附近读取，相同作用域/版本/用途共享在途读取。最后一个使用者离开就取消读取并释放租约，迟到结果也释放。原生桥关联 scope/requestId，转发取消和超时，使用 releaseToken 回收原生资源。资源释放报错经诊断回调反馈。

有副作用的业务动作防重复提交。超时、无效回执或 needs-review 不自动重发；只有宿主传回的数据能改变正式任务状态。工作流草稿串行保存，提交先冲净草稿并使用确认后的 revision；保存失败不会继续提交。原有生产草稿服务新增可选 expectedRevision，旧版本保存返回 conflict，原有不传版本的调用仍兼容。

展示时钟独立于能力上下文，避免静态 Markdown/图片每秒重挂；隐藏时暂停展示计时和动画。菜单默认挂到实例 portal，键盘处理按当前菜单过滤，表单 radio 使用实例内唯一名称。工作流模型设置通过动作打开桌面原有路由弹窗。

## 验证环境和源码身份

- macOS 26.5.1 / arm64，Node.js 22.22.3，Electron 44.0.0，Chrome 155.0.8059.85。
- 基础提交 `4e6f51707269cd4152ed7da9cd4fc00c21ca12c1`；worktree 从包含用户当时未提交展示调整的本地快照 `52460a00bcc2ee5bf7b491a215527f29a155a847` 创建。
- 验证对象为该快照加当前工作树。完整源码 SHA256 清单位于 `.visual/workflow/vision/conversation-sdk/source-manifest.json`，当前生产源码指纹 `66c6de58afe0eb540196f6408c4ddc09b90aee253783bf0ad8de725c035acf92`。
- Electron 验证均使用新临时 userData 和生成的测试文件；仅外部模型端点受控，实际 renderer、IPC、工作流服务、文件/命令执行和系统打开路径均为生产实现。
- 原始 checkout 在实施过程中另有并行变更；本次实现没有将独立 worktree 的改动写回原目录，也没有覆盖这些后续变化。

## 已完成验证

| 命令/场景 | 结果 |
| --- | --- |
| `npm ci` | Node 22 环境安装完成 |
| `npm test` | 1590 项通过，包括 SDK 的 16 项契约/分组测试及生产草稿版本校验 |
| `npm run build` | SDK 声明、ESM、CSS、桌面类型检查和 renderer 构建通过 |
| `node scripts/check-spacing.mjs` | 通过 |
| `node scripts/generate-renderer-notices.mjs` / `--check` | 154 项前端清单，无 unresolved notice；SDK 另外包含完整前端依赖闭包、Tailwind 与 Material Icon Theme 声明 |
| `node scripts/verify-conversation-sdk-package.mjs` | 实际 tarball 在仓库外安装；普通消费者类型检查、Vite/离线构建、所有公开入口与无 DOM SSR 导入通过 |
| `node scripts/verify-conversation-sdk.mjs`，并对 tarball 消费构建重复执行 | 8 组交互通过；无 Hemi 全局、无应用服务、无外部网络请求 |
| `scripts/verify-turn-stage-flow.mjs`，Vite 与 built 两入口 | 各 8 项通过：真实 read/bash、流式顺序、耗时、停止、重载、150 条历史展开状态恢复 |
| `scripts/verify-deliverable-cards.mjs`，Vite 与 built 两入口 | 各 10 项通过：真实文件、别名去重、图片比例、应用菜单、系统程序打开、Finder 定位、缺失恢复、版本更新和重启 |
| `scripts/verify-059-human-input-ui.mjs`，Vite 与 built 两入口 | 各 19 项通过：真实编辑器、模型工具、人工输入、文件校验、只读记录、队列满后恢复、宿主模型弹窗、旧草稿 IPC conflict 与完成路径 |

实际 Electron 命令如下，第二轮省略 `VITE_DEV_SERVER_URL` 即消费构建 renderer。GUI 检查串行执行。

```sh
HEMI_UI_TIMEOUT_MS=45000 VITE_DEV_SERVER_URL=http://127.0.0.1:5197 HEMI_PLAYWRIGHT_MODULE=./node_modules/playwright-core/index.mjs node scripts/verify-turn-stage-flow.mjs
HEMI_UI_TIMEOUT_MS=45000 VITE_DEV_SERVER_URL=http://127.0.0.1:5197 HEMI_PLAYWRIGHT_MODULE=./node_modules/playwright-core/index.mjs node scripts/verify-deliverable-cards.mjs
HEMI_SMOKE_TEST=1 VITE_DEV_SERVER_URL=http://127.0.0.1:5197 node_modules/.bin/electron scripts/verify-059-human-input-ui.mjs
HEMI_SDK_STANDALONE_PATH=.visual/workflow/vision/conversation-sdk/package/consumer.html node scripts/verify-conversation-sdk.mjs
```

独立消费者交互覆盖 320、375、390、768、1180、1440 宽度、编辑、150 条历史、表单定位、自动保存与提交并发、触屏 44px 操作、文件菜单、portal、双实例同 ID 隔离、radio 分组、换代次清理、授权超时和只读能力缺失。导入、构建与浏览器检查使用实际打包产物，未依赖仓库路径别名。

视觉基线为抽离前固定时间的 6 场景 × 3 宽度共 18 张图。15 张像素完全一致；另外 3 张仅有原有侧栏 spinner/通话活动条的动画差异，每张 41–63 个像素。消息结构、间距、文字和颜色未发现漂移，三档均无页面横向溢出。旧的独立 WorkflowCard fixture 只作基线参考；真正 SDK 工作流由独立消费者和实际 Electron 流程验证。现有系统只提供浅色，未把深色主题标为新增能力。

原始截图、差异、日志和结果位于 `.visual/workflow/vision/conversation-sdk/`；另有 `turn-stage-flow/{dev,built}`、`deliverable-cards/{dev,built}` 和 `059-human-input-fix` 证据目录。初次回归遇到 Vite 冷加载、隐藏烟测窗口及并行窗口焦点干扰，最终验证使用可配置加载超时、DOM-ready 重载和串行 UI 检查；普通生产行为未为测试做替换。

## 接入与后续边界

在仓库执行 `npm run build:sdk`。包目录 `npm pack` 会先构建；使用生成 tarball 即可在其他项目安装。示例目录 `npm ci && npm run build` 生成 `dist/standalone.html`，可直接打开，无须启动应用服务。当前验证产生的 tarball 保存在 `.visual/workflow/vision/conversation-sdk/package/`。

iOS/Android 交付为相同 SDK 的 JSON 桥与最小 Swift/Kotlin 宿主示例。本机没有完整 Xcode、Android 工程或移动设备，未进行真机编译、原生剪贴板/文件分享与保存、系统返回、键盘/安全区、前后台恢复的完整验收。浏览器触屏结果不能代替真机验证，因此不将 A15 标为通过。完整移动应用、Bot 连接与会话管理、应用上架和公开 npm 发布不在本次 SDK 抽离中实现。

远端 SSH 主机、屏幕阅读器人工巡检、全部皮肤和全部字体缩放组合未重跑专项矩阵；既有数据和能力仍由宿主提供，不能将本次局部检查扩大表述为全部设备或全部平台验收。
