# 浏览器控制后端

开启「设置 → 电脑与浏览器 → 浏览器控制」后，原有 `browser_*` 工具自动选择后端：

- 扩展已连接时优先使用 Chrome 扩展，复用安装该扩展的 Chrome 配置中的登录状态。
- 首次调用短等约 1 秒仍未连接时，使用 Hemi 管理的独立无头浏览器；不再等待旧的 35 秒扩展连接超时。
- 无头任务保持其会话。扩展后来接入时，新任务及同一 SDK 会话的下一轮任务优先使用扩展。
- 扩展在任务中途断开时，在途命令报失败，结果可能未知，不自动重放。后续工具自动回退无头后端，并要求先重新导航、观察页面再继续操作。

设置页显示实际使用的通道。扩展未连接时，下载按钮旁提示「下载并安装 Chrome 扩展，可复用你已有的登录状态。」下载后的文件夹仍需在 Chrome 扩展页加载；下载本身不等于安装。

## 无头运行时

`playwright-core@1.64.1` 只负责启动和控制，不随应用分发浏览器程序。自动发现本机 Chrome、Edge 或 Chromium（macOS 也支持 Brave 和 Chrome Canary），以及 Playwright 已安装的 Chromium。非标准位置可通过 `HEMI_BROWSER_EXECUTABLE` 指定程序。

无头实例以临时配置启动，每个任务使用独立 BrowserContext，Cookie 和页面互相隔离，不读取或复制个人 Chrome 配置。主目标完成、取消或失败终止时回收其上下文；等待用户确认或手动操作期间保留页面。最后一个任务结束时关闭无头进程。Hemi 退出时统一清理。无头模式不会自动获得日常浏览器的登录状态。

扩展和无头后端共用 `extensions/chrome-extension/page-operations.js` 的 DOM 操作与 Jev v2 快照／引用动作。引用表位于隔离世界，导航撤销旧引用，相同 dispatchId 不重复执行。所有工具仍使用现有权限门控，未另开桌面控制路径。工作流能力检查接受任一浏览器后端。

## 任务窗口、标签组与虚拟鼠标（扩展 0.3.5）

扩展按任务建立后台窗口和 Chrome 原生标签组，组名使用任务摘要，颜色按任务稳定分配。占位页不进入标签组。导航及后续操作会选中任务窗口内正在操作的页面，不调用窗口聚焦；分组创建时显式指定任务窗口，避免 Chrome 默认把后台标签移到当前用户窗口。使用 [Chrome Tabs / Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)，扩展从 0.3.3 起需要 `tabGroups` 权限。

主目标完成、取消或失败终止时关闭整个任务窗口及占位页；等待用户确认、登录或手动完成人机验证时保留页面。网页自行打开的标签也在回收范围内。跨窗口弹出页按 opener 记账、单独关闭；主窗口被手动关闭后再打开任务，也保留旧弹出页的回收记录。并行任务和普通 Chrome 窗口不受影响。手动关闭最后一个任务内容页时，纯占位窗口立即关闭。关闭失败保留归属，供后续收尾重试。

不再保留旧版的两个空闲窗口。扩展重连时回收已登记的遗留任务和旧窗口池；存储记录缺失时仅凭占位页清理完全空闲的窗口，不认领包含普通页面的未知窗口。独立弹出窗口保留网站原有布局，不强制挪回主窗口；其中的任务页面仍随任务回收。

虚拟鼠标通过 CDP 的真实指针/输入坐标更新，显示移动位置和点击反馈，并保留最后操作位置供用户查看；导航或任务回收时释放。页面边缘翻转图标而不偏移动作坐标。装饰使用隔离世界与 closed Shadow DOM，`pointer-events:none` 且 `aria-hidden`，不拦截点击、不增加快照候选，也不进入提取的正文；支持减少动态效果与深浅色页面。

已安装扩展需要在 Chrome 扩展管理页重新加载 0.3.5；Hemi Dev 需重启以加载新工具参数与模型规则。应用本身没有在此次修改中发布新版本。

### 2026-10-28 等待用户时保留任务页面

主会话的 `agent_settled` 只表示 SDK 本段停止生成，不再触发浏览器回收。目标自动续跑及 `awaiting_user` 保留同一浏览器客户端和页面，由 `completeConversation` 在目标终态回收；独立子会话仍按原来的运行收口清理。浏览器规则和目标校验明确将用户确认、登录及手动人机验证归为等待用户操作。

桌面 IPC 在续接等待中的目标时跳过原先无条件的旧运行取消，避免用户刚回复就关掉原页面。空闲取消仍显式等待浏览器清理。收尾校对当前根身份，旧根的迟到收尾不能关闭新根页面；等待用户的驻留会话也不因 LRU 淘汰而提前关页。关闭整个会话时等待页面清理结束，避免同客户端重建与旧清理交错。

验证基于 `dcac29084a1d6c74bea53c2066f2619f966a1c23` 加本次及原有未提交工作区；macOS 26.5.1 arm64、Node 22.22.3、Electron 44.0.0（内置 Node 24.18.1）。使用全新 `HEMI_USER_DATA_DIR` 和 Chrome for Testing 配置，本机脚本化模型、本机合成人机验证页面，无个人账号和真实验证码。

```sh
node --test src/main/agent-runtime/browser-goal-lifecycle.test.mjs src/main/agent/hemi-session.test.mjs src/main/agent-runtime/root-goal.test.mjs src/main/agent-runtime/goal-driver.test.mjs src/main/agent/gate/pi-browser.test.mjs src/main/services/browser-bridge-service.test.mjs
node --test src/main/ipc/llm-ipc-scope.test.mjs src/main/ipc/llm-turn-deltas.test.mjs src/main/bot/goal-continuation.test.mjs src/main/services/conversation-controller.test.mjs src/main/services/conversation-controller.race.test.mjs
npm run build:renderer
node scripts/verify-browser-goal-lifecycle.mjs
node scripts/verify-browser-goal-lifecycle.mjs --dev
```

定向测试分别 75 项和 62 项通过，渲染器构建通过。构建版和 Vite 开发版分别通过 16 项真实联调：实际输入框发送 → 桌面 IPC → 目标校验 → Pi SDK → 浏览器桥 → 导出扩展 → Chrome 页面。覆盖确认等待、手动操作、保留原页面输入、回复后仅提取原页面（导航仅一次）、完成回收、等待时取消，以及其它等待任务和普通窗口保留。报告和截图位于 `.visual/workflow/vision/browser-goal-lifecycle/{built,dev}/`。

未执行全量测试、Windows/Linux 真机、真实网站验证码或安装版更新。本次没有发版；应用退出仍统一回收页面，不跨应用重启保留现场。

### 2026-10-26 验证

基于 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 的未提交工作区，保留已有其它改动。macOS 26.5.1 arm64，宿主 Node 22.22.3，Electron 44.0.0（其内置 Node 24.18.1 / Chromium 152），Chrome for Testing 155。浏览器与 `HEMI_USER_DATA_DIR` 均为新建隔离目录；仅使用本机测试网页及合成凭据。

定向命令：

```sh
node --test src/main/services/browser-extension-lifecycle.test.mjs src/main/services/browser-bridge-service.test.mjs src/main/services/headless-browser-service.test.mjs src/main/agent/gate/pi-browser.test.mjs src/main/agent/gate/page-logic.test.mjs src/main/agent/hemi-session.test.mjs
HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-task-lifecycle/built node scripts/verify-browser-backends.mjs
HEMI_DEV_PORT=5187 node scripts/dev-renderer.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5187 HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-task-lifecycle/dev node scripts/verify-browser-backends.mjs
```

定向测试 73 项通过。开发版和构建版的真实浏览器验证各 40 项通过，经过生产工具／桥服务／扩展，并覆盖任务分组、`target=_blank`、跨窗弹出页、其它任务／普通窗口保留、任务收尾、只剩占位页、同一客户端重开，以及旧空闲池迁移。报告和源文件 SHA-256 位于 `.visual/workflow/vision/browser-task-lifecycle/{built,dev}/report.json`。虚拟鼠标在 375／768／1440 宽度及 light／dark 页面截图检查，验证点击穿透、closed Shadow DOM 和快照摘要不变。

另尝试 `HEMI_BROWSER_RECYCLING_EVIDENCE=.visual/workflow/vision/browser-task-lifecycle/agent-built node scripts/verify-browser-page-recycling.mjs`，以及带 `VITE_DEV_SERVER_URL=http://127.0.0.1:5187` 的 `agent-dev` 运行。旧 UI 全流程脚本均在首次发送 `RECYCLE_A` 后等待模型／浏览器调用时超时，本地 provider 请求数为 0；失败页面仍显示草稿，没有用户消息。该路径没有进入浏览器，不能算作本次通过的回归。证据位于 `agent-dev/failure-state.json` 和截图；不扩展修改现有消息发送工作。正常完成／停止／失败的 SDK 收口由定向会话测试覆盖，实际浏览器回收由生产桥联调覆盖。

未执行全量测试、Windows／Linux 真机、打包安装版及真实网站账号登录；扩展内容独立于 Vite 渲染器，开发版和构建版均接入相同生产扩展。

### 2026-10-26 导出文件缺失修复

实际导出路径的跟进反馈发现：`exportBrowserExtensionFiles` 原来只复制顶层文件，跳过整个 `icons/`，导致 Chrome 报 `Could not load icon 'icons/icon-16.png'`。此前浏览器脚本直接复制源码目录，未覆盖产品导出函数。现在导出递归复制子目录，逐层过滤隐藏文件，重复导出覆盖资源并保留普通附加文件；拒绝向源码目录内部导出，避免递归复制自身。导出回归脚本也改为加载生产函数导出的扩展。

测试仍基于 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作区，macOS 26.5.1 arm64、Node 22.22.3、Electron 44.0.0、Chrome for Testing 155。`node --test src/main/agent/permission-state.test.mjs` 的 4 项测试通过，检查实际 manifest 图标、后台依赖、嵌套更新、隐藏文件及重复导出。`HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-extension-export/built node scripts/verify-browser-backends.mjs` 的 42 项真实浏览器检查通过，确认导出目录中的扩展能加载并完成桥握手；报告保存导出目录、隔离 userData 与源码 SHA-256。

已用修复后的生产导出函数补齐用户现有下载目录中的扩展，确认全部 10 个资源文件与源码一致。扩展仍为 0.3.3，无需更改扩展代码或版本。此轮仅修改主进程导出文件操作，未修改 IPC／渲染器界面；未重跑全量测试或 Windows／Linux／打包安装版。

### 2026-10-26 Dev 通道与后台执行跟进（0.3.4）

用户在 Hemi Dev 的普通网页任务中仍看不到分组和指针。核对运行态后发现：0.3.3 扩展连着安装版，Dev 桥未启动。扩展现在同时连接本机端口段内的多个桥；任务、命令队列和回执按桥端口分桶，即使两个实例给出相同 taskId 也不会串台。新桥握手不会回收其它实例的活动页，断开一个实例仅回收它的任务。主进程在浏览器能力启用时预热回环桥（不会启动浏览器程序），不再等首次导航才监听。

另一个原因在模型请求：当前 SDK 1.3.0 在 `customPrompt` 非空时跳过工具的 `promptGuidelines`。原来写在 `browser_navigate` 上的“网页任务不另起 Chrome/Playwright”规则没有实际进入模型请求。现在 `BROWSER_TASK_GUIDANCE` 作为同一份规则显式加入 Hemi 自定义系统提示词，仅对本次实际声明了浏览器工具的会话生效；本地项目浏览器测试仍遵守项目规范。测试通过真实 Pi SDK 与本机 provider 检查请求体，确认规则存在及工具白名单匹配，不把提示词当成对任意脚本的硬拦截。

后台焦点验证复现了默认 `_blank` 链接会激活 Chrome。现在保留网页 click 处理器，只把尚未被页面取消的 `_blank` 默认导航改为由扩展创建后台标签并纳入任务分组。截图改用 `Page.captureScreenshot(fromSurface:true)`，不恢复最小化窗口；新版 Chrome 会拒绝原来的 `fromSurface:false`。普通导航、另开标签、点击、输入、截图和 `_blank` 由 macOS 前台应用 PID 观测检查，六项执行前后 PID 均保持一致。

验证仍基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加工作区改动，macOS 26.5.1 arm64 / Node 22.22.3 / Electron 44.0.0 / Chrome for Testing 155。命令与证据：

```sh
node --test src/main/services/browser-extension-lifecycle.test.mjs src/main/agent/permission-state.test.mjs
node --test src/main/services/browser-bridge-service.test.mjs src/main/agent/gate/pi-browser.test.mjs src/main/agent/gate/pi-browser-read.test.mjs
node --test src/main/agent/hemi-session.test.mjs
node scripts/verify-browser-background.mjs
HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-background/built node scripts/verify-browser-backends.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5187 HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-background/dev node scripts/verify-browser-backends.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5187 HEMI_BROWSER_RECYCLING_EVIDENCE=.visual/workflow/vision/browser-background/agent-dev node scripts/verify-browser-page-recycling.mjs
HEMI_BROWSER_RECYCLING_EVIDENCE=.visual/workflow/vision/browser-background/agent-built node scripts/verify-browser-page-recycling.mjs
```

定向测试分别为 10、49、13 项通过。开发版和构建版的生产导出／浏览器联调各 42 项通过。双桥验证确认 Dev 有独立标签组、虚拟鼠标在点击 2.7 秒后仍可见，以及一个实例结束或断开后另一个实例的页面存活。开发版与构建版完整 UI→IPC→模型→浏览器流程各 9 项检查通过，覆盖完成／停止／失败与占位窗清理。此前完整 UI 脚本的零请求超时，原因是测试用 Electron safeStorage 写入了不兼容 Hemi secretStorage 的合成密钥；现改走生产 `saveModelProfile` IPC，未改动消息发送逻辑。

证据位于 `.visual/workflow/vision/browser-background/`（`report.json`、`dev-cursor.png`、`{built,dev}/report.json`、`agent-dev/summary.json`）。测试只使用隔离 userData、浏览器配置、本机页面和合成凭据。

已知限制：网页脚本主动调用 `window.open` 创建独立窗口，仍可能激活 Chrome；此处保留网站原生 WindowProxy／弹窗语义，没有伪造返回值。后台焦点通过结论限定于上述六种路径，不能泛化成任意网站脚本绝不抢焦点。没有覆盖 Windows／Linux 真机、真实网站登录或任意外部 Playwright 脚本；分组和指针属于受管的 `browser_*` 通道。未跑全量测试或重新发布安装包。

### 2026-10-26 任务摘要与指针可见性跟进（0.3.5）

分组不再使用角色名或随机任务编号。执行模型在当前任务首次 `browser_navigate` 时通过 `taskTitle` 给出简短摘要，例如“查询周末杭州天气”，同一任务的后续页面沿用；不增加单独的模型请求。工具面与实际系统提示词均包含这个约定。标题按空白净化、最多 24 个 Unicode 字符；旧客户端未提供摘要时回退到页面标题或站点域名。

此前指针只在 CDP 点击／输入时创建：仅导航、提取正文的任务没有指针，页面导航又会销毁它。现在导航完成、读取／快照、滚动及 DOM 选择都会更新指针；显示“Hemi · 浏览／读取／点击”等状态，并在任务页保留。任务页在本窗口内被选中，避免用户打开任务窗口时仍只看到占位页；不激活 Chrome 应用。窗口变窄时，读取状态下的指针和标识回到可见范围。旧指针状态缺少新标识时自动重建，不重复添加浮层。

指针改为 DOM／SVG 节点与 CSSOM 样式直接创建，不再赋值 `innerHTML` 或注入 style 元素。严格 CSP 与 Trusted Types 测试页确认旧的 HTML 赋值在主世界、CDP 隔离世界均被拒绝，而新指针能够显示并保持输入／点击可用。CDP 返回的页面脚本异常现在由正常求值路径检查，显示失败会通过桥日志记录，不再默默吞掉。

验证基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作区；环境仍为 macOS 26.5.1 arm64、Node 22.22.3、Electron 44.0.0、Chrome for Testing 155。使用新建隔离 userData／浏览器配置和本机页面，无真实账号。定向验证：

```sh
node --test src/main/services/browser-extension-lifecycle.test.mjs src/main/agent/permission-state.test.mjs
node --test src/main/agent/gate/pi-browser.test.mjs src/main/agent/gate/pi-browser-read.test.mjs src/main/agent/gate/page-logic.test.mjs src/main/services/headless-browser-service.test.mjs src/main/agent/hemi-session.test.mjs
node --test src/main/services/browser-bridge-service.test.mjs
HEMI_BROWSER_BACKGROUND_EVIDENCE=.visual/workflow/vision/browser-cursor-title/background node scripts/verify-browser-background.mjs
HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-cursor-title/built node scripts/verify-browser-backends.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5187 HEMI_BROWSER_EVIDENCE=.visual/workflow/vision/browser-cursor-title/dev node scripts/verify-browser-backends.mjs
```

定向测试分别为 11、65、11 项通过。构建版与 Vite 开发版真实联调各 49 项通过，新增仅导航／读取、旧状态恢复、换页重建、缩窄窗口、严格 CSP、任务摘要稳定沿用的检查。后台观测在七种操作前后保持同一前台 PID。截图与源码 SHA-256 报告位于 `.visual/workflow/vision/browser-cursor-title/`；已检查导航后、严格策略页及深浅色不同视口截图。未重新运行全量测试、Windows／Linux 真机或真实网站登录；脚本主动独立弹窗的焦点限制仍沿用 0.3.4 记录。

## 验证记录

2026-10-21，基于 `e0b97054cf2845736c52dd434422a2d9430cd890` 的未提交工作区；保留工作区原有改动。环境为 macOS 26.5.1 arm64、Node 22.22.3。联调报告记录 Electron 版本、实际渲染器 URL、隔离 userData 目录，以及相关生产源文件的 SHA-256。

运行命令：

```sh
npm ci
npm run build
node --test src/main/services/browser-bridge-service.test.mjs src/main/services/headless-browser-service.test.mjs src/main/agent/gate/pi-browser.test.mjs src/main/agent/gate/pi-browser-read.test.mjs src/main/agent/gate/page-logic.test.mjs
npm test
node scripts/check-spacing.mjs
node scripts/generate-renderer-notices.mjs --check
node scripts/verify-release-materials.mjs
node scripts/verify-browser-backends.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5173 node scripts/verify-browser-backends.mjs
```

最后一条需先启动 `npm run dev:renderer`。真实扩展联调使用 Chrome for Testing；其它安装位置可设置 `HEMI_TEST_CHROME`。脚本为每次运行创建新的 `HEMI_USER_DATA_DIR` 和扩展配置，不读取个人会话或模型凭据。仅在复制的扩展中替换桥端口，以免连接正在运行的 Hemi。

相关单元及协议测试 63 项通过。全量测试为 1536 通过、1 失败：启动任务前已有的未跟踪文件 `src/renderer/src/styles/turn-activity.css:26` 中，`:focus-visible` 未挂 `html.kb-nav`，导致 `native-gate.test.mjs` 失败。本次不修改该文件。

真实联调经过生产工具定义、桥服务、浏览器程序与页面；设置状态通过实际 preload／IPC 获取，未用 mock 替代生产服务。覆盖无扩展回退、扩展优先、迟到扩展、运行中断连、DOM 输入与点击、JPEG 截图、v2 快照、隔离世界引用、动作去重、精确／歧义下拉选择、导航撤销引用、并发 Cookie 隔离、任务结束／停止／超时及应用退出后的实际进程消失。

构建版和 Vite 开发版报告位于 `.visual/workflow/vision/browser-backends/{built,dev}/report.json`。设置页在 1440、768、560 像素窗口截图并检查溢出；应用最小窗口宽度为 560，当前仅支持 light 主题，不适用手机宽度及 dark 主题验收。

许可证检查保留 Playwright、内嵌 npm 组件及 WebP WASM 的原始声明与来源；渲染器清单为 154 个组件，无待审声明。

未覆盖 Windows／Linux 真机、打包后安装应用、真实账号登录与验证码、外部 Jev 服务；Jev 的快照和引用动作已对真实页面验证，决策请求沿现有协议测试覆盖。此轮不创建提交或发布版本。
