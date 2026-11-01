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

macOS 发布 job 使用 `--ci` 导入同一身份到 runner 临时目录。CI 禁止生成证书，缺少 secrets 或不匹配公开证书就失败。改写用户信任域需要 GUI 认证代理，无头会话会阻塞到超时，因此只有 `--ci` 且明确处于 GitHub Actions 托管 runner（`GITHUB_ACTIONS=true` 且 `RUNNER_ENVIRONMENT=github-hosted`）时，才通过免密 `sudo -n security add-trusted-cert -d -r trustRoot -p codeSign -k <临时钥匙串>` 在管理员域一次性信任该证书。本地运行（包括 `npm run verify:mac-signing` 本地调用 `--ci` 的场景）与 self-hosted runner 仍在当前用户信任域内信任，不触发 sudo。

发布 job 无论成败都经 `scripts/cleanup-macos-signing.mjs` 清理，拆为三个独立的有界步骤（撤销信任、删除临时钥匙串、删除临时签名身份目录），各自 `if: always()` 加 step 上限：单阶段失败会使发布失败，但不阻断其余清理。脚本在一切副作用之前校验运行上下文：必须显式提供 `HEMI_MAC_SIGNING_DIR` 与 `RUNNER_TEMP`，目录在路径规范化后严格等于 `<RUNNER_TEMP>/hemi-build-signing`；非托管 runner、缺参或目录不符一律零副作用拒绝，绝不回退到默认目录（本机长期签名身份所在）。外部命令由 python3 watchdog 包装：到 deadline 由执行者自身权限对目标进程 SIGKILL（sudo 场景由 root 侧 watchdog 杀它的直接 child），Node 侧兜底超时后如实报失败，不声称已终止无法确认的后代。

撤销信任不用 `remove-trusted-cert`：macOS 14.7.5+／15 的 GitHub Actions runner 上它对管理员域记录会无限挂（见 [actions/runner-images#12116](https://github.com/actions/runner-images/issues/12116)、[rustls/rustls-native-certs#179](https://github.com/rustls/rustls-native-certs/issues/179)；Apple SecurityTool 的 `trusted_cert_add.c` 显示 remove 直接调用 `SecTrustSettingsRemoveTrustSettings`，无 CLI 交互可绕过）。改用同证书 codeSign 规则显式覆盖为 deny（`sudo -n security add-trusted-cert -d -r deny -p codeSign -k <临时钥匙串> <公证书>`），并要求双证据才算撤销成功：一是 `security trust-settings-export -d` 导出管理员域后用 python3 plistlib 只提取目标证书（SHA1）记录，断言 codeSign 规则为 deny（枚举值 3）且无 allow（1/2）；二是普通用户 `security verify-cert -c <公证书> -p codeSign -N -L` 以预期信任拒绝失败（CSSMERR_TP_CERT_TRUST），超时、工具缺失或其它执行失败都不得算作撤销成功。临时钥匙串不存在时不能据此断言未曾授信，撤销阶段仍如实失败；后续钥匙串和目录清理步骤继续执行。这是「撤销本次授信」而非恢复原始基线：deny 记录会留在一次性 runner 的管理员域直到 VM 回收。Windows 构建流程不受此身份配置影响。

发 tag 前可手动运行 `.github/workflows/macos-signing-preflight.yml`（`workflow_dispatch`，仅 `contents: read`）做无私钥 preflight：`scripts/verify-macos-trust-revocation.mjs` 只用仓库公开 `.cer`，在同一受控临时目录创建只含公证书的临时 keychain（密码为公开占位 `fake-public-probe`，无任何私钥材料），按生产相同路径授予 trustRoot，先验证普通用户 `verify-cert` 信任成功且管理员域有 allow 记录，再调用生产 `revoke-trust` 阶段验证 deny 覆盖与实际拒绝，并重复一次确认幂等；无论成败都在 `finally` 中清理临时钥匙串与目录，workflow 另有独立 `always()` 兜底清理步骤。

自签名证书没有苹果 TeamIdentifier，因此保持现有 HTTP 下载、SHA-512 核验与退出换包流程；不切换到 Squirrel。见 [更新签名分流](macos-updater-signing.md)。

## 验证

`npm run verify:mac-signing` 使用隔离的应用标识和实际 codesign，验证两个不同构建的 cdhash 不同、证书 DR 相同且彼此兼容；拒绝 ad-hoc 身份、仅标识符 DR 和资源篡改；调用实际更新器签名探测确认换包分支。它不修改已安装 Hemi，也不重置已有 TCC 授权。

完整权限验收需要在测试 Mac 上安装构建 A，手动授予录屏、辅助功能及麦克风权限，使用实际功能确认授权生效；再更新到同证书签名的不同构建 B，重启应用并再次验证实际功能。仅比较系统设置中的开关或签名字符串不够。

依据：[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Apple Code Signing Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html)。
