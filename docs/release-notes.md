本次更新加入 PDF 与 Office 文档附件、无头浏览器后端和后台命令，并把皮肤定义集中到一份配置。

- 文档附件：对话支持 `.pdf`、`.docx`、`.xlsx`、`.pptx`，单份 20 MiB 以内，单条消息最多 3 个。文字在本机提取后随消息发送；附件以卡片显示，点击在预览面板打开，PDF 与演示文稿按页翻阅，表格按工作表查看。
- 浏览器控制：原有浏览器工具自动选择后端。Chrome 扩展已连接时用扩展并复用其中的登录状态；首次调用约 1 秒内没等到扩展，就用 Hemi 管理的独立无头浏览器，不再空等 35 秒。无头任务以临时配置启动，每个任务独立上下文，不读取你的 Chrome 配置，也不继承日常登录状态。扩展在任务中途断开时，在途命令报失败、不自动重放，后续调用回退无头并要求重新导航。设置页显示当前通道，并给出扩展下载入口。
- 后台命令：本机命令可后台运行，前台等待时间可调，超时与前等待分开设定。对话区显示运行中的命令与正在等待的资源，可随时停止；应用退出时统一回收。
- 对话阶段：模型在工具之间输出的说明直接成为正文分段；相邻的思考和工具收进默认收起的过程组，组头显示操作摘要、次数与失败数，展开后按原始顺序查看。
- 皮肤：所有皮肤定义集中到 `src/shared/appearance/skins.config.json`，新增皮肤只改配置和素材，开发与构建自动生成类型、首屏配色和素材清单，不用再手改组件或样式。
- 更新：检查与下载改由 electron-updater 直连公开 Release，发布流程不再需要内置 token。失败提示按原因说明（磁盘空间、写入权限、安装包校验、请求频繁、网络连接等），并保留前往发布页手动下载的入口。
- 修复：对话过程组的键盘焦点环只在键盘操作时绘制。

下载：macOS Apple Silicon 使用 `.dmg`；Windows x64 使用 `-setup.exe`。
macOS 安装包尚未进行 Developer ID 签名和公证，首次打开可能需要在“系统设置 → 隐私与安全性”中允许。

Hemi 自有代码采用 MIT。第三方许可、原生库对应源码和重建说明随安装包提供；
`uiohook-napi-1.5.5-source.tar.gz` 也可单独下载。

---

This update adds PDF and Office attachments, a headless browser backend and
background commands, and moves every skin definition into one config file.

- Document attachments: conversations accept `.pdf`, `.docx`, `.xlsx` and
  `.pptx`, up to 20 MiB each and 3 per message. Text is extracted locally and
  sent with the message; attachments appear as cards and open in the preview
  panel, with page-by-page reading for PDFs and slide decks and per-sheet
  tables.
- Browser control: the existing browser tools pick a backend automatically.
  When the Chrome extension is connected it is used and its sign-in state is
  reused; if it does not connect within about a second on the first call, Hemi
  starts its own headless browser instead of waiting out the old 35-second
  timeout. Headless tasks run on a temporary profile with one isolated context
  per task, so your Chrome profile and sessions are never read or copied. If
  the extension drops mid-task, the in-flight command fails and is not replayed;
  later calls fall back to headless and ask for a fresh navigation first. The
  settings page shows which channel is in use and links to the extension
  download.
- Background commands: shell commands can run in the background with a
  configurable foreground wait, separate from the hard timeout. The conversation
  shows running commands and awaited resources, can stop them at any time, and
  cleans them up when the app quits.
- Conversation stages: text the model writes between tool calls becomes its own
  stage; adjacent reasoning and tools collapse into one quiet group showing an
  action summary, count and failure count, expanding back to the original order.
- Skins: every skin definition now lives in
  `src/shared/appearance/skins.config.json`. Adding a skin means editing that
  config and dropping in assets; dev and build generate types, first-paint
  colors and the asset manifest, with no component or stylesheet edits.
- Updates: checking and downloading go straight to the public release through
  electron-updater, so the release workflow no longer needs a built-in token.
  Failures explain the cause (disk space, write permission, package checksum,
  rate limiting, network) and keep a link to download manually from the release
  page.
- Fix: the keyboard focus ring on conversation process groups is now drawn only
  while navigating by keyboard.

Downloads: `.dmg` for macOS Apple Silicon; `-setup.exe` for Windows x64.
The macOS app is not Developer ID signed or notarized. First launch may require
approval in System Settings → Privacy & Security.

Hemi's own code is MIT licensed. Third-party licenses, native source references
and rebuilding instructions are included in the app. The libuiohook source
archive is also available as a separate download.
