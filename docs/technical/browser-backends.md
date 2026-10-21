# 浏览器控制后端

开启「设置 → 电脑与浏览器 → 浏览器控制」后，原有 `browser_*` 工具自动选择后端：

- 扩展已连接时优先使用 Chrome 扩展，复用安装该扩展的 Chrome 配置中的登录状态。
- 首次调用短等约 1 秒仍未连接时，使用 Hemi 管理的独立无头浏览器；不再等待旧的 35 秒扩展连接超时。
- 无头任务保持其会话。扩展后来接入时，新任务及同一 SDK 会话的下一轮任务优先使用扩展。
- 扩展在任务中途断开时，在途命令报失败，结果可能未知，不自动重放。后续工具自动回退无头后端，并要求先重新导航、观察页面再继续操作。

设置页显示实际使用的通道。扩展未连接时，下载按钮旁提示「下载并安装 Chrome 扩展，可复用你已有的登录状态。」下载后的文件夹仍需在 Chrome 扩展页加载；下载本身不等于安装。

## 无头运行时

`playwright-core@1.64.1` 只负责启动和控制，不随应用分发浏览器程序。自动发现本机 Chrome、Edge 或 Chromium（macOS 也支持 Brave 和 Chrome Canary），以及 Playwright 已安装的 Chromium。非标准位置可通过 `HEMI_BROWSER_EXECUTABLE` 指定程序。

无头实例以临时配置启动，每个任务使用独立 BrowserContext，Cookie 和页面互相隔离，不读取或复制个人 Chrome 配置。任务完成、停止或超时会回收其上下文；最后一个任务结束时关闭无头进程。Hemi 退出时统一清理。无头模式不会自动获得日常浏览器的登录状态。

扩展和无头后端共用 `extensions/chrome-extension/page-operations.js` 的 DOM 操作与 Jev v2 快照／引用动作。引用表位于隔离世界，导航撤销旧引用，相同 dispatchId 不重复执行。所有工具仍使用现有权限门控，未另开桌面控制路径。工作流能力检查接受任一浏览器后端。

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
