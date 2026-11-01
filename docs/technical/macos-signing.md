# macOS 固定自签名身份

Hemi 使用固定的自签名 Code Signing 证书，无需 Apple Developer Program。`build/macos-signing.cer` 是公开证书；私钥与密码不进入仓库。所有本地构建和 CI 发布必须复用同一份身份，不能每次构建生成新证书。同名的新证书也会改变身份。

默认 ad-hoc 签名的指定要求（DR）绑定某一版二进制的 cdhash。固定证书的 DR 则绑定应用标识与证书锚点，使不同版本可以满足原授权保存的要求。录屏、辅助功能、麦克风分别由 macOS 管理，仍需实际验证对应权限；签名检查通过不代表完成了权限验收。

这不会获得苹果公证或消除 Gatekeeper 的未识别开发者提示。首次从旧 ad-hoc 版本迁移到固定证书后，需要重新授予一次权限。

## 本地设置

首次建立整个项目的签名身份时运行一次 `npm run signing:mac:setup -- --create`。它生成十年有效期的代码签名证书，将公开证书写入仓库；在当前用户的代码签名信任域内信任该证书，使用专用钥匙串，不导入登录钥匙串。专用钥匙串追加到搜索列表，保留原有条目和顺序，不替换默认钥匙串。

本地私密备份默认位于 `~/Library/Application Support/Hemi Build Signing/`，目录权限为 0700，身份归档及密码文件为 0600：

- `identity.p12`：加密保存证书与私钥。
- `identity-password`：归档密码。备份时应与归档一起妥善保管。
- `hemi-signing.keychain-db`、`keychain-password`：本机专用钥匙串及解锁密码，可由原身份归档重新建立。

后续运行 `npm run signing:mac:setup` 只复用已有身份。换构建机时，恢复原来的 `identity.p12` 与 `identity-password` 到该目录，再运行同一命令；也可通过 `HEMI_MAC_SIGNING_P12`（归档的 Base64）和 `HEMI_MAC_SIGNING_PASSWORD` 导入。`HEMI_MAC_SIGNING_DIR` 可指定独立目录。

仓库已有公开证书后，`--create` 会拒绝生成替代身份。备份丢失、证书过期或主动轮换需要单独安排迁移；不能依靠保持证书名称相同延续授权。

`npm run pack`、`npm run dist:mac` 与直接执行 electron-builder 都通过 beforePack 解锁专用钥匙串、选择固定指纹，并在 afterSign 核对资源封印、签名证书及 DR。身份缺失、证书不符、ad-hoc 签名或仅标识符 DR 都会停止打包，不静默降级。

签名继续使用 electron-builder 自带的 osx-sign 及原有 entitlements，仅签署 Mach-O 原生代码和嵌套的应用／框架包。图片、字体、归档等资源由外层包封印覆盖，不逐个写入 detached signature，避免在 exFAT 上生成新的 AppleDouble 文件。自签名构建不请求苹果时间戳服务。

原生代码签名也可能写入 provenance 等扩展属性。打包目录若用 AppleDouble 保存扩展属性，会先将应用暂存到支持原生属性的系统临时目录完成签名，再用 `ditto --norsrc --noextattr` 复制回原目录、清理伴生文件并验证封印。暂存空间需足够容纳应用且额外保留 512 MiB；`HEMI_MAC_SIGNING_TEMP_DIR` 可指定其他 APFS／HFS+ 目录。CI 在原生文件系统上直接签署。

## CI 发布

在已有身份的本机运行 `npm run signing:mac:setup -- --upload-secrets`，通过 gh 的标准输入设置 Hemi 仓库的两个 Actions secrets：`HEMI_MAC_SIGNING_P12`、`HEMI_MAC_SIGNING_PASSWORD`。命令不打印密钥或密码，也不提交、打标签或发布版本。

macOS 发布 job 使用 `--ci` 导入同一身份到 runner 临时目录。CI 禁止生成证书，缺少 secrets 或不匹配公开证书就失败。签名完成后检查包体，并清理临时钥匙串与私密文件。Windows 构建流程不受此身份配置影响。

自签名证书没有苹果 TeamIdentifier，因此保持现有 HTTP 下载、SHA-512 核验与退出换包流程；不切换到 Squirrel。见 [更新签名分流](macos-updater-signing.md)。

## 验证

`npm run verify:mac-signing` 使用隔离的应用标识和实际 codesign，验证两个不同构建的 cdhash 不同、证书 DR 相同且彼此兼容；拒绝 ad-hoc 身份、仅标识符 DR 和资源篡改；调用实际更新器签名探测确认换包分支。它不修改已安装 Hemi，也不重置已有 TCC 授权。

完整权限验收需要在测试 Mac 上安装构建 A，手动授予录屏、辅助功能及麦克风权限，使用实际功能确认授权生效；再更新到同证书签名的不同构建 B，重启应用并再次验证实际功能。仅比较系统设置中的开关或签名字符串不够。

依据：[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Apple Code Signing Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html)。
