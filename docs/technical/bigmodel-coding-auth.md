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
