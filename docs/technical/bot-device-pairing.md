# Bot 设备连接：部署与协议

2026-10-23。首版面向自己的 iPhone，PC 继续用 SSH 管理云端 Bot，手机通过 Bot 内置的 TLS 入口直连。不需要中央账号、中转服务或手机 SSH 私钥。对话展示与草稿、排队、断线核对继续复用 `@hemi/conversation-flow`。

## 启用

1. 使用本轮 PC 构建，在 Bot 设置中维护云端组件，将新增的网关与 `jose` 依赖同步至 Bot。旧组件会明确报告不支持设备配对。
2. Bot 安装流程会准备 Node 22.19+（Node 22）及证书生成依赖；Windows 与 Linux 均无需另外安装 OpenSSL 命令。选择可用的非特权 TCP 端口，如 29421。
3. 在 PC 的 Bot → 连接新设备中直接查看当前 Bot 的连接二维码。首次打开时自动启用设备入口并生成一次性邀请，无需再次填写地址。PC 通过 OpenSSH 的有效 `HostName` 读取服务器地址（支持 SSH 别名、`user@host` 和 IPv6），设备入口默认使用 HTTPS 29421 端口，不使用 SSH 端口。已配置过的入口与证书保持不变。
4. 管理员在服务器防火墙／云安全组放行该 TCP 端口。Hemi 不自动修改防火墙。打开连接新设备之前，未配置的网关保持关闭；IP 地址应属于服务器或正确转发到该服务器。已有自定义入口仍可通过可信管理接口 `pairing.configure` 维护，只允许不含账号、路径、查询或片段的 HTTPS 源地址。
5. iPhone 打开 Hemi 扫码，预览地址后申请。对比双方六位码，在 PC 勾选一致并明确允许指定请求。邀请过期或取消后可手动重新生成，窗口不会循环签发新邀请。
6. 手机读取该 Bot 的真实模型、会话和对话流。设备表在实际 RPC 成功后更新最近连接时间，可在 PC 单独撤销。

云端 Bot 可公网访问时，手机使用流量或 Wi-Fi 均可，PC 和手机无需同网。用 Mac 本机作为临时 Bot 测试时，手机需要能访问 Mac 的局域网地址；这是测试环境条件。只有私网地址／NAT 且无端口映射的部署，仍需自行提供组网或可达入口。

## 无域名的 TLS

Bot 使用随组件分发的 `@peculiar/x509` 与 Node 原生 WebCrypto 生成有效期 365 天的 P-256 自签证书，包含准确的 IP／DNS SAN、serverAuth EKU 和 digitalSignature keyUsage。证书生成库仅在需要新证书时加载，不增加普通 RPC 的启动开销。证书及私钥保存在 Bot 数据目录的 `device-access/`，权限为 0600；设备表及管理回执使用原子文件写入。备份应按私密凭据管理。

PC 经已认证 SSH 取得二维码中的 SHA-256 DER 证书指纹。iOS 原生 Network.framework TLS 连接 先比对该确切指纹，再以该证书为限定信任锚执行系统 SSL 校验，仍校验地址／SAN、有效期和服务器用途；拒绝重定向。没有明文 HTTP、任意证书放行或 `NSAllowsArbitraryLoads`。浏览器 fetch 不承担此连接。

已有设备时不能静默更换入口或证书。证书过期／指纹变化需先撤销现有设备，再重新启用并逐台配对；没有活动设备时重新配置会生成到期证书的新版本。首版没有自动证书轮换或外部证书导入面板。服务器时钟与手机时钟需准确。

## 身份与接口

二维码是版本化 JSON：`type=hemi-bot-pair`、`version=1`、`endpoint`、`botInstanceId`、`inviteId`、`requestTicket`、`expiresAt`、`certificatePin`。邀请有效期 120 秒，ticket 为 256 位随机值，服务端只保存哈希。不包含原设备身份、SSH 密钥、模型密钥或长期登录令牌。不把 ticket 放进 URL、遥测或日志。

iPhone 在原生层生成独立 P-256 签名密钥，Keychain 使用 `WhenUnlockedThisDeviceOnly`；私钥不传给 JS 或 PC。未完成申请与已批准身份分开保存，应用重开可只读核对原请求。申请中允许取消并中断旧连接，原生 HTTP 请求有 12 秒硬截止时间；取消结果未知时保留 pending 身份，显式“退出本机等待”才移除本机记录，并说明这不等于 Bot 已取消。原生桥关闭 Capacitor 调试调用日志。删除本机连接需要再次确认，删除后需重新配对；PC 撤销才取消服务器身份。

公网只开放以下 JSON POST 接口，拒绝浏览器 Origin、其他路由、查询和任意管理 RPC：

| 接口 | 用途 |
| --- | --- |
| `/v1/challenge` | 领取 30 秒单次 nonce 和 Bot 实例标识。 |
| `/v1/pair/request` | 有效 ticket 与本机签名提交一个待确认请求。 |
| `/v1/pair/status` | 只读核对本机申请；批准后将身份转为已连接。 |
| `/v1/pair/cancel` | 取消本机申请；与批准竞态时返回真实结果。 |
| `/v1/rpc` | 已登记且未撤销设备访问受限会话／文件 RPC。 |

每个受保护请求使用 ES256 JWS：公钥 JWK、RFC 7638 thumbprint 设备标识、Bot+路由 audience、签发时间、jti、单次 nonce 和确切 payload 字符串的 SHA-256 摘要。服务端用 `jose` 验证。原生 CryptoKit 产生符合 JOSE 的 64 字节签名。HTTP 仅实现本 Bot 的单次 JSON POST：TLS 1.2+、HTTP/1.1、明确 Content-Length、连接即用即关；拒绝分块编码、重定向、重复或超限长度及不完整回执。不自行实现签名算法；此证明不是 OAuth Device Grant 或标准 DPoP 实现。

`/v1/rpc` 白名单覆盖真实会话、flow 快照／命令、操作回执、权限决定以及现有受控读取接口；不含设备管理、组件维护、模型凭据管理、原始 socket 或任意 CLI 方法。每次请求前和完成后都检查设备撤销状态，撤销时销毁已跟踪的设备连接。已受理任务继续，不承诺收回缓存或回滚已执行操作。

可信 PC 通过原有 SSH → CLI → 0600 Unix socket 调用 `pairing.configure/status/create/approve/reject/cancel/operation` 与 `devices.list/revoke`。批准精确绑定邀请、请求、设备公钥标识、核对码和稳定操作 ID。登记、消费邀请及回执在同一原子状态更新内完成。收到第一个申请不会自动批准；关闭待确认请求仅收起详情。未扫码的自有二维码在关闭时请求服务端取消。

管理回执丢失后按原操作 ID 查询，不自动重复授权；手机发送结果未知时同样使用 SDK 的稳定操作 ID 与 `operation.get` 恢复。入口有请求大小、速率、nonce 数量、连接数和超时限制。限流不能代替网络防火墙或服务容量规划。

## 授权范围

这是自有设备的完整 Bot 权限。获准设备可查看该 Bot 的对话、读取文件并通过工具执行服务器账号权限内的任务。Bot 控制面与任务执行处于同一 UNIX 用户权限域；接口白名单不能隔离已获准的恶意设备。多人、只读权限及多租户沙箱需要独立设计。

二维码在有效期内外泄仍可能被抢先申请或骚扰，但没有 PC 核对并批准就不能进入会话。只凭设备名称不能判断可信；必须对比自己手机的六位码。批准后旧码不能注册第二个公钥；已登记设备使用独立密钥重连，无需重复扫码。

## 实现与验证入口

- Bot：`src/main/bot/device-gateway.mjs`，集成至 Host 与桌面 service；运行时 archive 包含 `jose`。
- PC：`src/renderer/src/windows/bot/pairing.tsx`，真实二维码、确认、管理与未知结果核对。
- iOS：`HemiDeviceClient.swift`、`HemiBotPlugin.swift`，由实际 scene 的 `HemiBridgeViewController` 注册。
- 移动端：`apps/mobile/src/bot/` 适配原生 RPC 与共用 SDK；真实权限选项来自 Bot。
- `node --test src/main/bot/device-gateway.test.mjs src/main/bot/cli.test.mjs src/main/bot/desktop-service.test.mjs`：实际 HTTPS、拒绝未批准访问、重放／篡改、稳定回执、过期、撤销及重启。
- `npm test --workspace @hemi/mobile`：真实 Host/controller、丢失发送回执恢复和 workspace 生命周期。
- `node scripts/verify-device-pairing.mjs`：实际 Electron/preload/IPC/CLI/socket/Host、真实 QR 像素解码、生产 Swift 客户端和 TLS；开发与构建均验证。仅 SSH 网络边界、模型执行与测试凭据存储使用替身。

自动化原生客户端在 macOS 运行，不能代替 iPhone 相机、权限、真实 Keychain、后台／锁屏恢复及真实公网部署验收。具体测试提交、环境、证据与剩余范围见 [移动端实施记录](mobile-app-implementation.md)。Android 的扫码／Keystore／设备 HTTPS 原生插件尚未实现；Web 预览没有原生连接能力。

## 2026-10-27：证书能力随 Bot 分发

移除生成设备证书时对系统 `openssl` 命令的依赖。运行包显式包含 `@peculiar/x509@2.2.0` 与 `reflect-metadata@0.2.2`，使用随 Bot 安装的 Node 原生 WebCrypto，适用于 Windows 与 Linux。已有证书与已批准设备继续复用；证书更新仍遵守原有撤销要求。

验证基线为 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加本轮未提交改动，macOS arm64／Node v22.22.3：

- `node --test src/main/bot/device-certificate.test.mjs src/main/bot/device-gateway.test.mjs src/main/bot/cli.test.mjs`：16 项通过，覆盖 IPv4／IPv6／DNS SAN、密钥匹配、清空 PATH 后的真实 HTTPS、已配对身份与证书重启复用。
- `node scripts/verify-bot-sharing.mjs`：全新隔离用户目录，开发与打包 renderer 各 5 项流程检查通过，均无页面错误；二维码像素与实际邀请一致，实际签名 HTTPS 申请仍需明确核对和批准。SSH 网络与模型执行使用本地替身，其余经过实际 Electron／IPC／CLI／Host／HTTPS 实现。
- `npm run typecheck` 通过；重新生成 renderer 许可清单，156 项组件、无待核对项；保留新增运行库的原始许可与版权声明。
- `node --test src/main/bot/component-version.test.mjs`：2 项通过，组件指纹、归档完整性及跨平台换行规则保持有效。
- 实际 Windows x64／Node v22.22.3：独立 release 使用锁定 npm 包及完整性核验，清空 PATH 后实际网关成功生成证书、通过 HTTPS 证书校验、创建和取消邀请、重启复用证书。验证仅绑定 loopback，未修改已有 Bot 数据、设备授权或防火墙。证据位于 `.visual/workflow/bot-device-certificates/`。
- 运行任务完成后，通过 `maintenance.begin` 核对空闲再切换到组件 `abc0a9892117a46364bcb3a75feb5bc285e5276a4431bb50ac216c9dd75af256`；会话元数据、模型配置、路由、设备表和证书指纹均与切换前一致，实例身份保持一致。保留上一 release 回滚，实际持久 RPC 握手样本为 30／29／28／28／28 ms。

此次 Windows 实机验证覆盖证书生成及网关，不替代 iPhone 真机扫码和公网端口连通性验收。
