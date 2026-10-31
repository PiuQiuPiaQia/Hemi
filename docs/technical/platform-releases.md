# 双端同时发布

`npm run release -- patch` 自 2026-11 起默认**双端同 tag 同时发布**：同一版本号下，macOS job 生成 DMG、ZIP 和 `latest-mac.yml`，Windows job 生成 NSIS 安装包和 `latest.yml`，两个 job 并行构建、各自把资产上挂到同一草稿 Release，由收口 job（`publish-release`）确认双端更新清单齐备后统一转正式并标记 latest。

可显式使用 `--both`（与默认一致）或退回单平台 `--mac-only` / `--win-only`（两者互斥）。`npm run verify:release -- --fix` 在双端模式下按 Release 对象的双端完整性核验，本机打包冒烟按宿主平台执行；单平台选项沿用旧口径。Windows 的包体与冒烟由 Windows CI 执行；本地验收继续下载并核对安装包的 SHA-512。

发布提交保存 `[both]`、`[mac-only]` 或 `[win-only]` 标记，CI 的平台选择任务据此路由：`[both]` 双 job＋收口，`[win-only]` 仅 Windows job（自行建 Release 并发布），其余（含历史未标记标签与 `[mac-only]`）仅运行 macOS job。单平台发布时，为兼容现有应用使用的 `/releases/latest/download` 更新地址，新 Release 会保留另一个平台上一版的小型更新清单（版本、大小与校验值保持原样，下载 URL 改为原 Release 的绝对地址）；双端发布时两份原生清单都在本 Release，无需中继。

背景：2026-10 曾按平台分开发版（mac 止于 `v0.2.39`，Windows 连发至 `v0.2.42`），两端版本号与更新通道分叉；`v0.2.43` 起统一。

2026-10-27：`v0.2.18` 在发布资产前取消双平台 CI，已推送的提交与标签保留；首次按平台发布使用 `v0.2.19`，仅构建 macOS。（该分平台口径已于 2026-11 由双端同 tag 取代。）
