# macOS 自动更新的签名分流

`electron-updater` 6.8.10 的 `MacUpdater.updateDownloaded()` 在 `autoInstallOnAppQuit=true` 时就调用原生 Squirrel 下载，不会等到 Hemi 的安装分流。Squirrel 按旧包的指定要求验证新包；ad-hoc 指定要求绑定旧二进制摘要，因此新版本会在“下载完成”事件之后异步报签名错误。

Hemi 在更新器初始化时确定安装方式：

| 当前应用 | 下载及安装 |
| --- | --- |
| macOS Developer ID 证书 | 保留原生 Squirrel 更新流程 |
| macOS ad-hoc／未签名实例 | 设置 `autoInstallOnAppQuit=false`，保留库的 HTTP 下载与 SHA-512 校验；点击重启安装后由 Hemi 退出换包并重启 |
| Windows | 保留 NSIS 原生更新流程 |

`codesign -dv --verbose=2` 的身份信息写入标准错误，探测读取 stdout 和 stderr，成功退出后再识别 TeamIdentifier。默认不把缺失的 stdout 当作 ad-hoc 身份。

安装使用下载完成事件绑定的文件与版本，不再按缓存文件名字典序猜测安装包。换包前再次流式核验 SHA-512、包内版本和 `codesign --verify --deep --strict`。新包需要通过自身资源封印检查，无须匹配旧版 ad-hoc 二进制的 cdhash。失败不会退出或启动换包脚本；替换失败保留原有回滚路径。

已有旧版无法自行使用修复后的下载选项。本机验收先在备份保护下引入修复后的更新器组件，再从应用内执行真实发布版本的检查、下载和重启安装；最终应用必须与正式发布包完全一致。

验证：

- `node --test src/main/services/updater.test.mjs src/main/services/updater-error.test.mjs`：签名分流、完整流程、绑定下载回执、篡改拒装、版本拒装及新包签名失败拒装。
- `npx electron scripts/verify-updater-download.mjs`：隔离 userData、实际 MacUpdater、实际本地 HTTP 与校验链；合法下载成功，损坏下载拒绝，原生 Squirrel 检查调用数为零。
- 本机真实 `codesign` 探测正确区分 ad-hoc Hemi 与 Developer ID 签名的 Node。
- 发版与安装的最终提交、环境、命令和本机重启证据记录在 `.visual/workflow/release-v0.2.12/`。
