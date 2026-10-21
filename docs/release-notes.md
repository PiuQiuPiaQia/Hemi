本次更新简化首次设置，并修复对话界面的显示问题。

- 首次启动先连接模型，支持 New API 登录和手动配置，并验证模型的工具调用能力。
- 语音、桌面操控、浏览器控制和模型路由可按需配置；跳过语音即可开始文字对话，未完成的引导可继续。
- 修复流式回复中旧段落仍显示光标的问题，以及输入框调整高度时的布局循环。
- 开发模式的性能面板支持拖动和键盘移动。

下载：macOS Apple Silicon 使用 `.dmg`；Windows x64 使用 `-setup.exe`。
macOS 安装包尚未进行 Developer ID 签名和公证，首次打开可能需要在“系统设置 → 隐私与安全性”中允许。

Hemi 自有代码采用 MIT。第三方许可、原生库对应源码和重建说明随安装包提供；
`uiohook-napi-1.5.5-source.tar.gz` 也可单独下载。

---

This update simplifies first-run setup and fixes conversation display issues.

- Connect a model first through New API sign-in or manual configuration, with a tool-calling capability check.
- Configure voice, desktop control, browser control, and model routing as needed. Start chatting with text without voice setup, and resume unfinished onboarding.
- Fix stale streaming cursors on earlier reply segments and a layout loop when resizing the message input.
- Move the development performance monitor by dragging or using the keyboard.

Downloads: `.dmg` for macOS Apple Silicon; `-setup.exe` for Windows x64.
The macOS app is not Developer ID signed or notarized. First launch may require
approval in System Settings → Privacy & Security.

Hemi's own code is MIT licensed. Third-party licenses, native source references
and rebuilding instructions are included in the app. The libuiohook source
archive is also available as a separate download.
