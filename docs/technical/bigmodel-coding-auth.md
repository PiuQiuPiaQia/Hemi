# GLM Coding Plan 登录与项目令牌刷新

2026-10-28（Asia/Shanghai）。桌面与 Bot 共用 `src/main/services/bigmodel-coding*.mjs`。

## 协议对照

对照 [TriDefender/zcode-api 的提交 0e0968abe7385560e044a8f1ea6c1c536495edc0](https://github.com/TriDefender/zcode-api/commit/0e0968abe7385560e044a8f1ea6c1c536495edc0)：

- 客户端版本统一从 `3.16.2` 更新到 `3.16.3`，用于授权跳转、项目令牌签发、身份头和请求签名。
- BigModel 账号授权用于签发短期 `project_access` JWT；每次项目令牌更新后，签名私钥也需要重新握手。
- 签名握手仍发到原始模型提供方 `open.bigmodel.cn`，推理按配置路由到 `zcode.z.ai`，保留双认证头与 `X-ZCode-Authorization`。
- 该仓库的 3.16.3 验证码开关针对 start-plan 相关路径；Hemi 当前这里实现的是国内个人 Coding Plan。

Hemi 独立实现这些协议行为，没有复制或引入该仓库源码、运行时或依赖。

## 本地 401 与修复

旧实现将 Pi 请求持有的 `apiKey` 与最新存储中的短期项目令牌直接比较。请求创建后或签名预检期间，另一个请求刷新了同一次登录的项目令牌，也会触发本地 `GLM 编程套餐登录已更新，请重新发送或重新登录。`。这段 401 由 Hemi 构造，不能作为上游风控或封禁的证据。

Pi 现在持有与本次登录绑定的内部认证引用，传输层在发送时读取当前项目令牌。引用不包含短期项目令牌或其过期时间，因此正常续签不会改变引用。新登录生成 `authSessionId`；旧格式凭据根据原有登录字段派生引用，保持续签前后一致，无需迁移或强制重登。

退出后凭据不存在，重新登录后认证引用变化，两者都会阻止旧请求。若项目令牌在预检期间变化，传输层最多重建一次路由、认证头与签名；重建发生在推理发送之前。明确的签名拒绝仍最多重新握手、重发一次，不发送无签名回退请求。

这两类刷新竞争在旧实现上均复现为 401，修复后通过。历史故障的完整进程内时序未被记录，因此只能确认修复了同类缺陷，不能据此断言每次历史失败的具体原因。

## 验证记录

基线提交：`1e1697b84fc2099a1b1165d163c5f4cd5bcbf6c9` 加本次未提交改动；环境为 macOS arm64、Node.js `22.22.3`、Pi SDK `1.3.0`。已有移动端和 Bot 实时同步改动保持原状。

执行：

```sh
node --test src/main/services/bigmodel-coding.test.mjs src/main/services/oauth.test.mjs src/main/bot/oauth.test.mjs src/main/bot/oauth-errors.test.mjs src/main/lib/pi-model.test.mjs
node --check src/main/services/bigmodel-coding-auth.mjs
node --check src/main/services/bigmodel-coding-transport.mjs
node --check src/main/services/bigmodel-coding.mjs
node --check scripts/verify-bigmodel-live.mjs
git diff --check
node scripts/verify-bigmodel-live.mjs --user-data=<已授权账号目录> --refresh
node scripts/verify-bigmodel-live.mjs --user-data=<已授权账号目录> --model=glm-5.3
```

- 24 项定向测试全部通过，覆盖四家账号的桌面与 Bot 真实实现路径、主会话复用、并发续签、旧格式凭据、预检期间续签、退出与重新登录、真实密码学签名校验、取消和有界重试。模拟上游仅验证协议边界。
- 使用已有真实账号、内存凭据副本验证：项目令牌签发、路由配置、签名握手和推理均返回 HTTP 200。`glm-5.3-flash` 续签后和 `glm-5.3` 普通请求均回复 `OK`，终态为 `stop`。
- 另以 `node --input-type=module` 运行一次隔离主会话脚本：新的临时 `HEMI_USER_DATA_DIR`、临时工作区、`createHemiSession` 的路由入口、`glm-5.3`、无工具和记忆插件；第一轮成功后只将内存凭据标记过期，第二轮在同一主会话内续签并成功回复 `OK`。两轮的 `modelError` 均为 null，所有远端阶段均为 HTTP 200。临时目录在结束后删除。
- 最初主模型探针使用 128 输出 token，收到 HTTP 200 但以 `length` 结束；诊断脚本默认预算调整为 512 后得到 `stop`。产品输出预算没有修改。脚本日志中的机构、项目、密钥标识路径统一替换为占位符。

生产账号文件仅用于读取，续签结果只保存在验证进程内；没有回放个人会话。没有修改已安装应用、发布版本或更新生产 Bot。未运行全量测试、渲染器构建或设备回归；本次修改不涉及渲染器、IPC 或 UI 生命周期。

## 2026-10-30：请求内到期与上游令牌拒绝

新增回归先在原实现上失败：真实 Pi SDK 完成认证后，在 `onPayload` 中将测试凭据标记到期，原请求返回本地 `项目令牌已过期` 401；签名预检期间到期也有相同结果。另一个回归确认，`VERIFY_APIKEY_EXPIRED` 原来只清签名私钥并重新握手，没有签发新项目令牌。这些复现确认了具体缺口，历史会话中上层未提前续签的完整时序仍不能从已有日志还原。

修复位于桌面和 Bot 共用的认证与传输模块：

- `ensureCodingCredential` 在签名前和发送前获取有效凭据，沿用 SDK 的五分钟有效期窗口。需要续签时进入同一凭据存储的 `modify` 锁，在锁内再次核对登录引用与有效期，复用其他请求已签发的令牌。
- 签发仍使用 `projectCredential`，不在已持有存储锁的 SDK `oauth.refresh` 中再次获取锁。已开始的签发最多等待 15 秒；单个请求取消只结束自己的等待，签发结果仍可保存供其他请求使用。
- 签发后重新读取凭据，因此续签期间排队的退出或重登会阻止旧请求。令牌变化后重建路由、认证头、握手和签名，沿用最多两次预检的上限；本地到期不会直接结束原任务。
- 第一次明确的 `VERIFY_APIKEY_EXPIRED` 拒绝会换发令牌；如果其他请求已更换被拒绝的令牌则直接复用。`VERIFY_SIGNATURE_INVALID` 只重建签名私钥。两者共用最多一次推理重发的上限；普通 401、HTTP 200 后的流错误不进入该认证恢复分支，不发送无签名回退请求。
- 无效或已过期的签发结果不写入凭据存储，返回可重试的受控错误；账号授权被拒绝才提示重新登录。仍有效的短期签发结果按下述 2026-11-02 规则处理。错误消息与诊断输出不包含令牌或上游原始正文。

本次基线为 `de447c7f603b1e4cda00fa50a833cafe1b717532` 加工作区原有改动及本次未提交修改。环境：macOS arm64、Node.js `22.22.3`、Pi SDK `1.3.0`。

验证命令：

```sh
HEMI_USER_DATA_DIR=<新临时目录> node --test src/main/services/bigmodel-coding.test.mjs src/main/services/oauth.test.mjs src/main/bot/oauth.test.mjs src/main/bot/oauth-errors.test.mjs src/main/lib/pi-model.test.mjs
node --check src/main/services/bigmodel-coding-auth.mjs
node --check src/main/services/bigmodel-coding-transport.mjs
node --check scripts/verify-bigmodel-live.mjs
git diff --check -- src/main/services/bigmodel-coding-auth.mjs src/main/services/bigmodel-coding-transport.mjs src/main/services/bigmodel-coding.test.mjs src/main/bot/oauth.test.mjs scripts/verify-bigmodel-live.mjs docs/technical/bigmodel-coding-auth.md
HEMI_USER_DATA_DIR=<新临时目录> node scripts/verify-bigmodel-live.mjs --user-data=<已有授权账号目录> --expire-after-auth
```

- 50 项定向检查通过，覆盖真实 SDK 的认证后到期、签名期间到期、复用 Hemi 会话处理追加指令、SDK 与传输层并发续签、取消、退出和重登、无效续签结果、有界拒绝恢复、流错误，以及四家账号原有路径。Bot 的真实 Host API → 执行器 → SDK → 签名传输路径通过受控时钟跨越有效期；独立目标验收请求与业务推理分别计数，业务推理只提交一次。模拟上游验证协议和真实密码学边界，不等同于 Windows 生产 Bot 验证。
- 真实 `glm-5.3-flash` 请求中，在 SDK 认证后仅将内存凭据标记到期；项目令牌签发、路由、签名握手和推理均为 HTTP 200，返回 `OK`，终态为 `stop`。账号凭据文件前后 SHA-256 相同，没有回放个人会话或将新凭据写回账号文件。
- 语法和所改文件的空白检查通过。Git 仍报告工作区原有 AppleDouble `._*.idx` 索引错误；未修改 Git 对象文件。

未等待真实五小时自然到期，未运行全量测试、构建或渲染器回归；本次没有 UI 生命周期或依赖变更。未提交、发版、替换已安装应用或部署生产 Bot，未进行 Windows 或移动真机测试。

## 2026-11-02：仍有效的短期续签结果

安装版 0.2.54 的认证模块与本次修改前的源码一致，已包含此前的请求内续签修复。现场错误发生在正文生成后的独立目标校验：SDK 的 OAuth 续签调用触发本地“有效期不足”检查。该检查先确认令牌仍有效，再因为剩余有效期不超过两分钟而拒绝，因此这条错误不表示账号授权失效。现场只读探测已恢复正常；没有保存历史签发响应，无法追溯当时的精确剩余秒数或缓存时序。

共享认证模块现将真实到期时间 `expires` 与提前续签时间 `refreshAt` 分开：

- `expires` 取响应绝对到期时间、请求发出时加 `expiresIn`、JWT `exp` 三者的最小值，不再人为扣除两分钟。网络耗时不能延长有效期。
- `refreshAt` 最多提前五分钟，短期结果最多提前剩余寿命的一半，避免签名前后检查反复换发刚取得的有效令牌。旧凭据缺少该字段时沿用五分钟窗口；真正到期或上游明确拒绝仍会立即续签。
- 仍校验令牌用途、账号项目标识和实际有效期；退出、重登、取消、签名与有界重试规则不变。没有把 OAuth 错误一概当作目标完成，也不重放历史任务。

验证基线 `3e43b6b52653bff58b71f5fd0286718c4ab64a3c` 加本次工作树差异；macOS arm64 / Node 22.22.3 / Pi SDK 1.3.0。各测试夹具创建独立临时目录。

```sh
node --test src/main/services/bigmodel-coding.test.mjs src/main/services/oauth.test.mjs src/main/bot/oauth.test.mjs src/main/bot/oauth-errors.test.mjs src/main/agent-runtime/goal-verification.test.mjs
node --check src/main/services/bigmodel-coding-auth.mjs
git diff --check -- src/main/services/bigmodel-coding-auth.mjs src/main/services/bigmodel-coding.test.mjs scripts/bigmodel-test-fixture.mjs docs/technical/bigmodel-coding-auth.md
```

73 项通过。新增 SDK 与签名传输回归在修复前均失败，修复后剩余 60 秒的令牌可完成同一请求，签名前后只续签一次、推理只提交一次；目标校验场景正常完成而无需故障放行。既有并发、退出、重登、过期与无效令牌、HTTP/网络故障和其他账号路径通过。

真实 `glm-5.3-flash` 探针只使用内存凭据副本，并在续签响应的内存副本中将 `expiresIn` 上限设为 60 秒；续签、路由、签名和推理均 HTTP 200，回复 `OK`、终态 `stop`，原账号文件 SHA-256 未改变。该探针验证真实服务链路，但不代表等待真实令牌自然到期。脱敏结果位于忽略目录 `.visual/workflow/bigmodel-short-token/live.json`。

未运行全量测试、构建或 UI 回归；本次只修改认证服务、协议夹具及测试和文档，没有 IPC、渲染器或依赖变更。未提交、发版、更新安装版、部署生产 Bot、修改正式会话状态或操作实体设备；无关工作树改动保持原状。

## 2026-11-02：同步 3.17.1 协议版本与发布通道

参照 [zcode-api `0329b309`](https://github.com/TriDefender/zcode-api/commit/0329b309709ec66fa4ab0e39f6c09febf4cfdcd7) 的版本更新，将共享 `ZCODE_VERSION` 从 `3.16.3` 升到 `3.17.1`，覆盖授权跳转 `app_version`、项目令牌签发 `clientVersion`、User-Agent、身份头、签名内容与 `X-Client-Version`。同时对齐[上游身份头](https://github.com/TriDefender/zcode-api/blob/158e7653b738cbed0996243eeabd26f816638e81/src/proxy/identity.ts)中已存在的通道差异，改为 `X-Release-Channel: production`。桌面与 Bot 使用同一实现，保留本轮短期令牌续签修复；没有引入上游源码、运行时、依赖或不适用于当前 Coding Plan 的功能。

协议夹具独立固定预期版本和通道，验证签发请求、配置请求、推理请求及真实 Ed25519 签名；既有授权测试同时核验跳转版本。更新夹具后，旧版本实现的授权链路先失败，修改共享常量后通过。

验证基线仍为 `3e43b6b52653bff58b71f5fd0286718c4ab64a3c` 加本轮工作树差异；macOS arm64 / Node 22.22.3 / Pi SDK 1.3.0。上述五个测试文件再次运行，73 项通过；认证和传输模块 `node --check` 及本次文件 `git diff --check` 通过。

真实服务验证使用新临时 `HEMI_USER_DATA_DIR`，只读取已有账号并在内存中续签：

```sh
HEMI_USER_DATA_DIR=<新临时目录> node scripts/verify-bigmodel-live.mjs --user-data=<已有授权账号目录> --model=glm-5.3-flash --refresh --expire-after-auth
HEMI_USER_DATA_DIR=<新临时目录> node scripts/verify-bigmodel-live.mjs --user-data=<已有授权账号目录> --model=glm-5.3 --refresh
```

两种型号的续签、路由与签名握手均 HTTP 200；推理阶段均返回 HTTP 429，未重试或重放，不能宣称本轮真实推理成功。`glm-5.3` 探针前后账号文件 SHA-256 相同。此前评估使用 `3.17.1 + production` 临时副本已取得 `glm-5.3-flash` 的 `OK/stop`；归一化本地导入路径后，产品认证和传输模块与该成功副本逐字一致。脱敏结果位于忽略目录 `.visual/workflow/zcode-api-update-review/{compatibility,product-live}.json`。

本次未运行全量测试、构建或 UI 回归，没有 IPC、渲染器或依赖变更。未提交、发版、更新安装版或部署生产 Bot；Windows 与实体移动设备未复验，无关工作树改动保持原状。
