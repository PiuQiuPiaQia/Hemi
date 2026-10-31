New API 站点登录导入新增首屏加载动画；本版起 macOS 与 Windows 统一版本号、同一发布页同时交付。

- 模型设置 → 添加供应商 → New API 站点登录：打开站点后先显示「正在加载站点页面…」加载动画，页面就绪后再显示站点内容，首次加载不再白屏等待；恢复未完成的导入时同样生效。
- 发布节奏调整：自 0.2.43 起 macOS 与 Windows 共用同一版本号、同时发布（此前 macOS 最新为 0.2.39、Windows 为 0.2.42）；两端「检查更新」将始终拿到同一版本。

---

The New API site sign-in import now shows a first-paint loading indicator; starting with this version, macOS and Windows ship together under one version number on a single release page.

- Settings → Models & routing → Add provider → New API site sign-in: after opening a site, a "loading site page" spinner is shown until the page is ready, replacing the blank wait on first load. Resuming an interrupted import gets the same treatment.
- Release cadence change: from 0.2.43 on, macOS and Windows share one version number and release simultaneously (previously macOS sat at 0.2.39 while Windows was at 0.2.42); check-for-updates on both platforms now always resolves to the same version.
