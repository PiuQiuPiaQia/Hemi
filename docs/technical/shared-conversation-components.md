# PC 与移动端共用组件

2026-10-24，基准提交 `aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e` 加当前工作区。保留工作区已有的 Bot 实时同步、模型配置、服务端及原生修改；本次未提交、推送、发布 npm 包或覆盖安装设备。

## 包与依赖

新增 `@hemi/ui`（`packages/ui`），提供 Button、Dialog、Menu、InfoPopover、ScrollArea、Sheet、IconButton、焦点管理、Portal 环境及共用设计令牌。令牌从原先字节相同的桌面/SDK副本收敛到一份源文件。

扩充 `@hemi/conversation-flow`，通过 `/composer`、`/controls`、`/navigation`、`/resources` 导出完整会话部件，保留原有根入口、`/core`、`/react`、`/parts`。`/core` 仍可在没有 React/DOM 的运行环境导入。依赖方向为应用 → conversation-flow → ui；共享包没有 Electron、Capacitor、应用目录别名或应用 IPC 依赖。

npm workspaces 统一锁文件，根目录 `npm ci`；`npm run build:sdk` 按顺序构建 ui 与 conversation-flow。SDK 使用 ui 的版本依赖，允许两个包分别打包。开发环境将一个会话包的所有入口统一映射到源码，构建环境统一消费公开构建，避免 Provider 与组件来自两份 React 上下文。

## 已迁移与适配边界

| 能力 | 共用实现 | 应用适配 |
| --- | --- | --- |
| 输入 | ConversationComposer；正文、IME、提交禁用、历史、标签、撤销/重做、候选 | PC 薄封装注入候选查询和文件路径；移动薄封装选择 touch 布局；语音和工具通过插槽传入 |
| 附件 | 附件卡、图标、移动紧凑列表与上传状态展示 | 选择/粘贴/拖放、实际上传和暂存由宿主负责；各端保留现有托盘布局 |
| 模型 | ModelOptions 与 ModelSelectorChip；选中/禁用/不可用原因 | PC 路由设置弹窗回调；移动 Sheet；应用提供目录和保存回执 |
| 思考强度 | 单一档位定义与 ThinkingOptions、ThinkingLevelStrip | PC 菜单、移动 Sheet；保留各端既有文案 |
| 用量 | 聚合、格式化、SessionUsage | 保留 PC 入口；没有给移动端新增无数据来源的入口 |
| 导航 | ConversationRow、运行/未读状态、标题/时间/分组/排序辅助、重命名编辑 | PC Sidebar 的数据订阅、拖拽、右键操作与历史弹窗；移动 Drawer 的手势、搜索和 Bot 底栏 |
| 目录 | DirectoryPicker；手动路径、导航、重试、取消和迟到响应保护 | 注入 Bot 目录读取/选择；PC 保留 BotDialog 外壳；本机系统选择器与 SSH 配置保留 |
| 资源 | ResourceContent、ResourcePreview、ResourceProgressView、进度契约 | PC 保留多标签缓存、文档/视频/过程预览及既有 Markdown 宿主；移动保留标准资源 Host 与系统操作 |
| 基础 UI | @hemi/ui；SDK Provider 注入 Portal/键盘作用域 | 应用保留主题、触达密度、安全区和布局样式 |

旧入口保留薄转发，实际实现只在包内维护。任务/设备授权、配对、凭据、SSH、麦克风、原生文件选择与后台连接仍留在各自平台边界。未将这些能力按设备类型强行合并。

## 验证

环境：macOS arm64、Node 22.22.3。所有应用验证使用新建临时数据目录，不读取个人凭据；浏览器原生桥验证仅替代平台边界，目录、上传、资源和事件来自实际 Bot Host。

验证结果与剩余范围见本文后续记录及忽略目录 `.visual/workflow/shared-ui/`。截图与详细应用报告沿用 `.visual/workflow/mobile-settings/`、`mobile-uploads/`、`mobile-resources/`、`vision/conversation-nav/`。源码清单记录本次最终工作区哈希。

### 已执行检查

| 检查 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 通过；没有升级既有依赖版本 |
| `npm run build:sdk` | ui/SDK 的 ESM、声明、SDK 样式与许可生成通过 |
| 桌面/mobile/ui/SDK 类型检查 | 通过 |
| `npm run build:renderer`、`npm run build --workspace @hemi/mobile` | 通过；仍有既有的大 chunk 提示 |
| `node scripts/run-tests.mjs` | 1717 项中 1716 通过；1 项设备事件测试在清理临时目录时 ENOTEMPTY；随后 `node --test src/main/bot/device-gateway.test.mjs` 9/9 通过 |
| `npm test --workspace @hemi/mobile` | 23/23 通过 |
| 提取的 token、撤销、会话格式、用量逻辑 | 27/27 通过 |
| `node scripts/verify-shared-conversation-ui.mjs` | 开发/构建各 8 组，通过；IME、提交禁用、标签撤销、两级候选、迟到引用、模型禁用原因、目录迟到回执、关闭后释放资源、touch 换行/停止/队列编辑 |
| `node scripts/verify-shared-desktop.mjs` | 开发/构建各 6 组，通过；真实 Electron/preload/IPC，重命名落盘、打开历史、草稿跨页面保留、二次确认删除、375 抽屉、无渲染错误 |
| `node scripts/verify-mobile-settings.mjs` | 开发/构建各 7 组，通过；实际 Host 设置、目录、执行快照、失回执核对、键盘/容器/焦点、离线与多宽度 |
| `node scripts/verify-mobile-uploads.mjs` | 开发/构建各 5 组，通过；真实字节上传、进度、重试、纯附件发送、取消和 44px 控件 |
| `node scripts/verify-mobile-resources.mjs` | 开发/构建各 3 组，通过；实际登记资源、字节复用、Markdown/图片、系统操作边界、刷新和取消 |
| `node scripts/verify-conversation-sdk-package.mjs` | 两个真实 tarball 在仓库外安装，公开入口的类型/Vite/Node/SSR 检查通过 |
| core 运行边界 | 用拒绝 React 导入的 Node loader 导入 `/core`，通过；纯逻辑入口没有加载 React/DOM |
| 许可、spacing、diff | 桌面许可清单生成与 `--check` 均通过（156 项、无待审项）；移动清单 132 项无缺失；SDK 新增 ui 与既有 class-variance-authority 的完整通知；spacing 与 `git diff --check` 通过 |

移动设置/上传/资源浏览器夹具补齐了现有 Bot 事件桥：事件由真实 `host.watch()` 提供，未通过关闭生产实时通路回避测试。既有验证夹具在迁移前已因缺事件桥出现未实现日志和离线检查超时，基线日志保存在证据目录。

### 视觉与剩余范围

保留现有布局和主题，未重新设计。已检查 375 的思考面板、320 的资源进度、768/1440 的桌面列表与输入区截图。移动输入区在 320/375/390/768 的前后截图逐字节相同；1440 输入区仅 5 个像素不同。目录截图的随机临时路径不作为布局差异。

额外的 `verify-conversation-nav.mjs` 打包版完整检查通过。该脚本的开发版悬停/跨区域时序仍不稳定；以 HEAD 的原 sidebar、text-composer、menu、scroll-area 替换本轮对应实现后，也在窄屏跨区域悬停断言处复现。未改动产品导航 hook 或放宽断言。当前提取组件的 Vite/构建独立检查，以及真实桌面双入口点击/编辑/删除/草稿检查均通过；更广的开发版悬停问题单列为原有验证缺口。

没有重编译或覆盖安装 iOS/Android 应用，没有验证物理软键盘、照片选择、QuickLook/系统分享等真机动作。相关适配器没有本轮产品修改；浏览器夹具只证明桥边界，不能替代设备验收。没有新增发布或服务端部署。

## 工作目录入口对齐与真机安装（2026-10-24）

按用户后续要求，移动端工作目录入口通过共享 ConversationComposer 的 toolbar 插槽放到添加按钮右侧，与 PC 位于输入框内同一工具行；移除输入框外的目录行和顶栏重复入口。移动端保留目录 Sheet 和原有保存逻辑，关闭后返回新的工具栏入口。按用户进一步要求，各移动端宽度均使用共享 IconButton 只显示文件夹图标，清理目录文字及其专用样式；完整路径仍保留在可访问名称与 title 中，所有操作保留至少 44×44 的触摸区域。未修改 PC 布局。

基准提交 aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e 加当前工作区；Node v22.22.3、macOS 26.5.1、Xcode 26.6 / Build version 17F113。npm run build:mobile、verify-mobile-settings.mjs 开发/构建各 7 组（含 320/375/376/390/768/1440、长模型/目录名称、运行中停止按钮、键盘容器、离线、目录保存与焦点恢复）、spacing 和 diff 检查通过。浏览器原生事件使用边界夹具，实际目录与设置操作走隔离 Bot Host；物理软键盘由用户验收。

执行 cap sync ios、App scheme Debug 真机构建、严格签名验证；Web dist、原生工程资源和签名产物 7 个资源哈希一致。devicectl 覆盖安装到 iPhone 16 Pro（iOS 27.0.1）并启动成功，保留应用数据。命令、源码哈希、截图及回执见忽略目录 .visual/workflow/mobile-directory-toolbar/，视觉检查记录见 .visual/workflow/vision-report-mobile-directory-toolbar.md。

同日进一步收紧为各宽度的纯图标目录入口后，重新通过移动构建、开发/构建各 7 组设置与布局验证、spacing、diff、iOS 编译及严格签名检查，资源哈希一致，覆盖安装并启动成功。此次源码哈希、截图、命令与回执位于 .visual/workflow/mobile-directory-icon/；视觉检查记录为 .visual/workflow/vision-report-mobile-directory-icon.md。

## 公共样式与输入栏控制组（2026-10-24）

公共样式按唯一来源迁移：15 份原本完全一致的桌面/SDK 样式不再保留桌面副本；控件、信息浮层、Dialog 和原生交互样式归属 @hemi/ui，消息、输入、任务、工作流等归属 @hemi/conversation-flow。桌面按原有顺序引用包内公开 CSS；SDK 从同一来源编译作用域样式。原 globals.css 内容归属会话包，桌面只保留 Tailwind、令牌和来源扫描入口。移动端共有的输入、目录、附件、资源样式以及 Sheet/按钮样式也迁入各自包的 touch.css，应用保留布局、主题、安全区和原生键盘适配。源码声明对比确认 15 份桌面样式、全局/原生样式及移动原有 892 项声明没有遗漏。

输入栏通过 ComposerControlButton / DirectoryControlButton、ModelSelectorControl、ThinkingLevelStrip 复用触发器与交互；@hemi/ui 的 useControlDisclosure / SelectionSurface 管理受控或非受控开关、Menu/Sheet 与焦点返回。移动端旧 ModelPanel / ThinkingPanel 及手写工具栏控件删除，顶部模型入口由受控状态打开同一个共享模型控件；目录入口保持纯图标。PC 保留模型分组搜索、自动路由配置、来源/禁用提示、工作区搜索/默认空间/本地与 SSH 管理。目录数据读取、实际设置保存及路由导航继续通过宿主适配。

移动端选择面板经 UiProvider portal 挂到 inert 背景之外，并保持在原主题和键盘缩放容器内。异步选择失败返回 false 时面板与错误保留，保存期间禁用重复操作，成功关闭后返回原触发器。间距与原生交互门禁扩展到包目录，避免搬迁后漏检。验证日志、源码快照、CSS 声明对比和最终报告位于忽略目录 .visual/workflow/shared-styles-controls/；基准仍为 aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e 加工作区，保留其他进行中的改动。

本轮最终验证：全量测试 1728/1728、移动单测 24/24；开发/构建共享组件 18 组、真实 Electron 12 组、移动设置 16 组、附件 10 组、资源 6 组、真实 Bot 模型链路 14 组，共 76 组应用检查通过。独立 tarball 的公开组件和 CSS 入口在仓库外安装、类型/Vite/SSR 检查通过。156 项渲染许可无待审项，原生/spacing/diff 门禁通过。390/768 移动输入区截图与此前纯图标版本逐字节相同。iOS 构建与严格签名、7 项资源哈希核对通过，覆盖安装并启动成功，应用数据保留；物理软键盘、照片选择和系统分享仍由用户真机验收。完整环境、命令和源码哈希见上述证据目录 report.json / source-manifest.json，视觉记录见 .visual/workflow/vision-report-shared-styles-controls.md。

## 授权确认卡与状态提示（2026-10-24）

授权卡统一为 `@hemi/conversation-flow/parts` 的 `PermissionRequestCard`。PC 本地通过 `PermissionCard` 适配任务快照与决定枚举；PC Bot 和 wise 传入服务端请求并原样提交选项。PC Bot 删除了伪造任务快照、空决定回调及旧 fieldset 外壳；`task-panel.tsx` 只保留档案读取和共享卡转发。wise 删除独立授权卡 JSX 与旧样式，共享包提供紧凑布局。

本地倒计时、停止、队列提示、完整命令、旧文案映射与旧卡 Esc 拒绝保留；现代授权卡/风险卡按 Esc 不作决定。过期/禁用请求不再响应决定键。Bot 没有虚构倒计时，持续等候明确决定。会话过滤、RPC/IPC、提交中禁用、离线、失回执待核对仍由宿主适配。

`@hemi/ui` 新增 `StatusNotice`、`Toast`、`TimedToast`、`useTransientMessage`。PC Bot 的模型配置、断连/停用、提交待核对提示与 wise 的断连、待核对、错误、发送/读文件/离线队列提示共用；PC 文件链接、SDK 复制及 wise 的 Toast 统一卡面和计时清理。PC 文件链接原 3000ms、复制/wise/模型保存原 2600ms 时长不变；模型保存提示仍按实例与请求身份核销回执。重复同文案会重新计时，旧计时器不会移除新提示。

通用桌面状态条样式迁到 `@hemi/ui/styles/status.css`，touch 状态条/Toast 迁到 ui touch 样式，授权卡样式归 conversation-flow；应用不再保留这些规则副本。连接延迟策略仍复用原 `useConnectionWarning`，配对、设备授权、凭据和原生能力保持原适配边界。

本轮验证基于 `aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e` 加工作区修改，环境 macOS 26.5.1 arm64、Node 22.22.3、Electron 44.0.0、Xcode 26.6。`npm test` 1728/1728、mobile 24/24；SDK/两端类型与构建通过。新增 `verify-shared-permission-status.mjs` 开发/构建共 16 组，`verify-permission-status-apps.mjs` 共 12 组：实际 Electron/preload/SSH/Host 与移动 workspace/Host，覆盖持续等待、会话过滤、原始选项、停止、提交中禁用、失回执提示、延迟离线与重连。组件覆盖现代/旧卡 Esc、覆盖弹窗、超时/禁用、队列/命令、相同 Toast 替换和旧回执计时清理。375/768/1440 及暗色系统偏好截图已审阅；本轮维持已有浅色主题。

仓库外真实 tarball 安装、TypeScript、Vite、Node/SSR 通过；原生/间距门禁与 `git diff --check` 通过。桌面许可证 156 项、无待核对条目；移动许可证随构建生成。证据与最终源码哈希位于忽略目录 `.visual/workflow/shared-permission-status/`，视觉记录为 `.visual/workflow/vision-report-shared-permission-status.md`。原生网络与模型执行为自动化测试的替代边界，未用个人凭据触发真实危险工具操作。

iPhone 16 Pro 上已覆盖安装并启动 `ai.hemi.mobile`（PID 35401），保留应用数据；Xcode Debug 设备构建及 codesign 校验通过，7 个 Web 资源在构建目录、原生资源目录和签名 App 中 SHA-256 一致。没有提交、推送、发布包或发版。

## 空态、加载、失败与会话列表（2026-10-24）

`@hemi/ui` 新增 `StateView` / `EmptyState` / `LoadingState` / `ErrorState` 与 `ErrorBoundary`。状态视图共用插图、标题、说明和动作，继续使用宿主原有类名、标题层级与布局。状态由应用已有事实决定，未因断连清空缓存或把尚未读取的会话当成新对话。PC 欢迎页、Bot 加载页、文件读取/失败页，wise 连接恢复/失败、新建空态、欢迎页、目录和资源失败展示均接入。通用边界负责捕获、手动重试与 resetKey 重置；SDK 诊断、PC 工作流日志和 wise 返回连接页仍通过薄适配注入。SDK 按 runtime 身份重置失败，避免旧会话错误延续到新作用域。清理了重复边界类及已无调用的桌面对话边界文件。

`@hemi/conversation-flow/navigation` 新增 `ConversationList` / `ConversationGroup`，`ConversationRow` 增加 history 展示。PC 侧栏、历史弹窗与 wise 抽屉共用列表和条目；历史弹窗不再手写标题/状态/时间与重命名输入框。PC 的时间分组、DndContext/SortableContext、右键菜单、两步删除与落盘继续由宿主注入；wise 保留置顶/最近、标题搜索、抽屉手势、焦点与原有可用能力。共享编辑器处理中文组合输入、Enter/失焦单次提交、Esc 取消并阻止 Esc 继续关闭外层弹窗。损坏会话和操作中的条目保持禁用，右键清理损坏档案的端侧能力不变。

基准 `aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e` 加工作区，保留其他正在进行的主进程、模型、实时通信及原生修改。Node 22.22.3、macOS 26.5.1 arm64、Electron 44.0.0、Xcode 26.6。SDK、PC/mobile 类型及构建通过；全量测试 1729/1729，移动测试 24/24。开发/构建公共组件 14 组、真实桌面 IPC 20 组、移动状态/列表 10 组、设置/目录 16 组、资源 6 组，共 66 组检查通过。额外验证了失败隔离与作用域重置、wise 返回回调、真实重命名与删除落盘、键盘拖拽顺序、连接恢复重试、创建失败重试、搜索空态、草稿保留及目录/文件失败恢复。

仓库外 tarball 类型/Vite/Node/SSR 检查通过；156 项桌面渲染许可无待核对项，native/spacing/diff 门禁通过。截图覆盖 375/768/1440 和暗色系统偏好，维持原浅色主题。证据、环境、命令与源码哈希位于忽略目录 `.visual/workflow/shared-states-lists/`，视觉记录为 `.visual/workflow/vision-report-shared-states-lists.md`。模型执行、原生网络、OS 文件面板仍是浏览器验收的明确替代边界；没有用个人凭据触发真实任务或强制制造已安装应用的渲染崩溃。

iOS Debug 构建、严格签名和 7 个 Web 资源的三处 SHA-256 一致性核对通过，已覆盖安装并启动 iPhone 16 Pro 上的 `ai.hemi.mobile`，保留数据。未提交、推送、发布 npm 包或发版。

## wise 会话操作入口（2026-10-24）

此前列表抽离复用了条目展示，wise 尚未接入 PC 已有的重命名、删除能力。本轮在每条 wise 会话右侧增加常驻「⋯」，保持至少 44×44 的触摸区域。共享 `ConversationRow.actions` 使用兄弟控件，避免把操作按钮嵌套到打开会话的按钮里；共享 `ConversationActionsSheet` 提供重命名、明确的删除二次确认、提交中禁用、离线说明及可重试的错误。操作菜单不会切换当前会话。关闭后回到原触发器，删除该触发器所在条目后回到抽屉；动作面板打开时背景抽屉 inert，抽屉滑动关闭暂停。PC 继续使用既有双击、右键和历史列表操作。

wise 的 workspace 适配实际 `session.rename` / `session.remove`，没有修改服务端协议。按点击时的会话 ID 提交；删除成功后释放 SDK 客户端、移除该会话草稿/操作/快照缓存并阻止迟到写回，保留其他会话和草稿，当前会话被删时选择剩余会话，最后一条被删时回到空态。Host 现有删除实现会停止正在运行的任务并移除会话附件。管理操作使用持久化 requestId 与 `operation.get` 核对丢失的回执，重载后仍核对原操作；只有用户明确重试且服务端回执缺失时才重用同一 requestId 提交，避免静默重复执行。

基准仍为 `aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e` 加工作区；Node 22.22.3、macOS 26.5.1 arm64、Electron 44.0.0、Xcode 26.6。保留已有实时通信、模型和原生修改；构建发现现有 `ModelSelectorChip` 传入的 automatic 参数未在共享控件声明，补齐其类型和桌面自动路由图标。最终门禁复查还为并行模型设置样式新增的焦点环补上已有规范要求的 `html.kb-nav` 前缀，未更改模型设置逻辑。SDK、PC/mobile 类型及构建通过；mobile 测试 28/28（新增 4 项真实 Host 管理集成），新增 `verify-mobile-conversation-actions.mjs` 开发/构建共 12 组，既有真实 Electron/preload/IPC 检查共 20 组通过。覆盖正确会话身份、草稿保留、取消、失败重试、提交中禁用、丢失回执、跨重载核对、运行中删除、附件与缓存清理、焦点恢复、离线和最后一条会话删除。未预跑完整仓库测试集。

截图检查覆盖 375/768/1440 与系统暗色偏好，沿用现有浅色主题。许可清单 156 项无待审项，native/spacing/diff 检查通过。证据与源码哈希位于忽略目录 `.visual/workflow/mobile-conversation-actions/`，视觉记录为 `.visual/workflow/vision-report-mobile-conversation-actions.md`。浏览器使用真实 workspace 和 Host，原生网络/事件桥是传输夹具，模型执行是隔离执行器；物理键盘弹出仍由用户真机验收。

iOS Debug 编译、严格签名与 7 个 Web 资源三处哈希核对通过；原生工程与签名应用额外包含 Capacitor 自动生成的两个空 Cordova 文件。19:09 覆盖安装，19:10 已启动 iPhone 16 Pro 上的 `ai.hemi.mobile`，保留原应用数据。没有提交、推送、发布 npm 包或发版。

## 去除聚焦高亮边框（2026-10-24）

按用户要求，从共享样式源头移除按钮、输入控件及对话框的额外焦点描边、光晕和聚焦边框变色。`@hemi/ui` Button 与桌面 Input 删除 focus ring/border 工具类；controls/touch 样式统一抑制浏览器默认 outline；wise 应用删除全局绿色 focus-visible 描边。PC 输入栏、原位重命名及各页面按钮同步清理旧的焦点视觉规则，重命名输入沿用普通灰色边框。普通边框、面板阴影、悬停、选中、错误提示及拖入附件提示保持原样。内容阅读区和链接既有的键盘定位提示保留，焦点捕获、返回、Tab/Esc 和业务回调未修改。

验证基于 `aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e` 加工作区，Node 22.22.3、macOS 26.5.1 arm64、Electron 44.0.0、Xcode 26.6。SDK、PC/mobile 类型和构建通过；native 门禁 2/2、spacing、diff 通过。本轮为纯视觉调整，未运行全量测试。复用既有应用验证脚本，在忽略目录追加计算样式断言：wise 开发/构建 14 组、实际 Electron/preload/IPC 24 组通过。鼠标/键盘聚焦前后，输入框和按钮的 border/shadow 不变，对话框保留普通阴影且没有 outline；实际重命名、删除二次确认、草稿、离线恢复和键盘拖拽继续通过。

截图覆盖 375/768/1440 和系统暗色偏好，保持既有浅色主题。源码前后对比、命令、哈希与截图见忽略目录 `.visual/workflow/focus-appearance/`；视觉记录为 `.visual/workflow/vision-report-focus-appearance.md`。浏览器原生传输和模型执行仍使用隔离夹具，真实 workspace/Host 被覆盖；软键盘实机外观由用户验收。iOS Debug 编译、严格签名及 7 个 Web 资源三处哈希核对通过，手机已覆盖安装并启动，保留应用数据；未覆盖安装桌面发布版，未提交、推送或发版。
