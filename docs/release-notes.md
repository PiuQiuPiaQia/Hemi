本次修复 macOS 临时签名包的应用内更新，让“下载 → 重启安装”完整走通。

- 下载时按签名类型选择更新方式，临时签名包使用已校验的下载文件交给 Hemi 换包安装器，避免 Squirrel 提前按旧版身份拒绝新包。
- 安装前再次核对 SHA-512、目标版本和新包自身的代码签名，下载文件被修改或签名损坏时拒绝安装。
- 更新器自动退出、替换应用并重新启动，保留现有聊天和配置；替换失败时回滚旧应用。
- 修正签名探测读取 codesign 标准错误输出的方式，正确识别 Developer ID 证书。Windows 和证书签名的 macOS 应用使用各自原生安装器。

下载：macOS（Apple 芯片）用 `.dmg`，Windows（64 位）用 `-setup.exe`。

---

This patch fixes in-app updates for ad-hoc-signed macOS builds.

- Select the installation path before downloading, keeping verified downloads out of Squirrel's old-bundle identity checks for ad-hoc builds.
- Recheck SHA-512, target version and the new bundle's own code signature before installation. Modified downloads and invalid signatures are rejected.
- Quit, replace and relaunch the application automatically while retaining conversations and settings, with rollback if replacement fails.
- Read codesign identity information from stderr. Developer ID macOS builds and Windows retain their native installers.
