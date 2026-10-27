# 按平台发布

`npm run release -- patch` 只发布当前平台：macOS 生成 DMG、ZIP 和 `latest-mac.yml`；Windows 生成 NSIS 安装包和 `latest.yml`。每次发布使用一个新版本号，不再连跑两个平台。

可显式使用 `--mac-only` 或 `--win-only`。两者互斥；Linux 上须显式选择目标。`npm run verify:release -- --fix` 同样默认只验收当前平台，也支持这两个选项。Windows 的包体与冒烟由 Windows CI 执行；本地验收继续下载并核对安装包的 SHA-512。

发布提交保存 `[mac-only]` 或 `[win-only]` 标记。CI 的平台选择任务据此仅启动一个打包任务，Windows 不依赖 macOS。历史未标记标签默认仅运行 macOS。

为兼容现有应用使用的 `/releases/latest/download` 更新地址，新 Release 会保留另一个平台上一版的小型更新清单。清单的版本、大小与校验值保持原样，下载 URL 改为原 Release 的绝对地址；不重建、不复制另一个平台的安装包。因此 macOS 和 Windows 可以独立发布，现有用户仍能取得各自平台的最新版本。

2026-10-27：`v0.2.18` 在发布资产前取消双平台 CI，已推送的提交与标签保留；首次按平台发布使用 `v0.2.19`，仅构建 macOS。
