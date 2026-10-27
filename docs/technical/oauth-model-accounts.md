# 模型账号 OAuth

Bot 使用独立授权和服务器凭据，不自动复制本机登录；入口、实现和验证见 [Bot 订阅账号](bot-oauth.md)。下文为桌面账号流程。

入口：设置 → 模型与路由 → 添加供应商 → 账号登录。首启引导使用同一组件。支持 ChatGPT、Claude、GitHub Copilot，每家保留一个账号；重新登录替换该服务商的凭据，保留稳定的模型键、默认模型与角色配置。

点击登录后立即打开应用内授权弹窗，集中显示服务商、进度、设备验证码、登录方式和授权码输入。网页授权仍由系统浏览器完成；弹窗支持键盘焦点限制、回车提交授权码、失败重试，以及 Esc／关闭按钮取消登录。成功刷新模型列表后自动关闭；renderer 重载会恢复进行中的授权弹窗。窄屏复用现有底部弹层样式。

## 登录与模型调用

- ChatGPT 使用当前 Pi SDK 的 `openai` OAuth 流程，安装 UUID 作为稳定设备身份，应用名为 Hemi。授权后读取 `/v1/models` 的 `models` 数组，仅导入 `visibility: list` 且 SDK 已支持的型号，保留服务器顺序。推理走公开 Responses API。流程依据 [OpenAI 官方模型与推理文档](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。
- Claude 使用 SDK 的浏览器回调或复制授权码流程，型号能力来自 Anthropic 原生 SDK 目录，实际权限由服务端检查。
- Copilot 使用 SDK 的设备验证码流程，包括可选 Enterprise 域名。登录后的型号按 SDK 获取的账号可用目录过滤；请求保留 Copilot 的凭据端点、请求头和各型号的原生协议。同一个账号中的 Claude 与 GPT 型号可以使用不同协议。
- 登录成功后，账号型号进入原有供应商目录、会话选择器、角色路由及看图配置。主 agent、轻量请求、语音摘要、工具探活和图片问答均通过原生账号 transport 调用。每次请求由 SDK 解析和刷新凭据，不把 token 转成普通 API Key。

## 凭据与生命周期

`runtime-v2/oauth-credentials.json` 仅保存安装身份和应用本地 AES-256-GCM 密文，权限为 0600，以临时文件加 rename 替换。本地加密钥匙保存在应用数据根目录的 `secrets/`，需随整个应用数据目录一同备份。旧系统密文不再兼容，旧凭据显示为未登录，需要重新登录；保存、读取和刷新均不使用系统钥匙串。它实现 SDK 的 CredentialStore，读改写串行化，SDK 的刷新在该队列内重新核对到期状态。单个应用数据目录由现有单实例锁保护；隔离测试使用各自的临时数据目录。

设置和首启状态通过凭据索引报告连接状态，不读取或解密 token。模型配置中仅保存 `oauthProvider` 引用；供旧配置门槛使用的主进程 `apiKey: oauth` 是无敏感内容的标记，发送请求前会被移除。刷新 token、访问 token 和服务商原始授权错误不进入 renderer DTO、模型目录、冻结执行计划或日志。

登录状态在主进程保留，可在 renderer 重载后查询恢复。单次授权可取消，等待上限十分钟，过期 prompt 不可提交。OAuth IPC 校验主窗口、已登记 renderer 地址和顶层 frame。浏览器只打开对应授权域名；Copilot Enterprise 仅允许用户本次输入的域名。退出登录删除本机凭据并保留模型配置为未登录状态；删除 OAuth 供应商也删除其凭据。本地加密存储不可用时拒绝保存，不回退到明文。

## 验证记录

- 日期：2026-10-22。基准提交：`caacc59fd32dfb2f0ee55ca4e0c50c015b550021`，其上的未提交 OAuth 与应用本地凭据存储改动。
- 环境：macOS arm64，Node.js v22.22.3，Pi SDK 1.3.0，Electron 44.0.0。
- `npm test`：1572 项全部通过。包括真实三家 SDK 授权/回调、加密持久化、并发刷新、取消后释放回调端口、退出后冻结计划失效、重登保留选择、不同原生协议、工具探活、主 agent、路由和图片请求，以及本地凭据存储的篡改、密钥丢失和不支持格式保护。
- `npm run build`、`node scripts/check-spacing.mjs`、`git diff --check`：通过。
- `node scripts/verify-oauth.mjs --dev-url=http://127.0.0.1:5197` 和 `node scripts/verify-oauth.mjs`：各 23 项通过（首启 18 项、重启 5 项）。真实窗口、preload、生产 IPC、服务和原生 SDK 连接本地 HTTP 测试服务；三家均在真实对话选择器中选模并完成回复。Electron safeStorage 接口在两阶段均被强制阻断，覆盖账号保存、调用、进程重启恢复、首启工具验证、非主窗口拒绝、renderer 重载恢复、取消、退出后的请求拒绝与磁盘不含明文 token。
- `node scripts/verify-keychain-startup.mjs`（内置 renderer 和 Vite renderer）：各 22 项。全程阻断系统凭据接口，旧密文显示为未配置且保留模型名称与接口地址；重新填写后验证 API Key、OAuth、站点登录、导入 journal 和 SSH 密码，覆盖冷启动、设置保存不改写有效密文、更换 Key 及真实请求。
- `node scripts/verify-oauth-visual.mjs`：登录入口、设备码、授权失败三种场景在 1440/768/375 宽度的九组布局检查通过，无页面脚本错误和横向溢出。另采集系统 dark 偏好场景；应用使用自身皮肤颜色，系统偏好不会单独切换配色。截图已人工检查，复用原有排版与控件，新说明文字使用 muted token。
- 自动验证使用合成凭据和独立临时 userData，未读取个人账号、会话或录音，也不创建或读取系统钥匙串条目。

证据在 `.visual/workflow/vision/oauth-electron-{dev,built}.json`、`oauth-layout.json` 和对应 PNG。尚未验证真实订阅账号的服务端授权、地区限制、实际额度与真实推理响应，也未覆盖 Windows 实机或安装包。模型目录中已列出的型号仍受账号权限约束；SDK 尚未收录的型号需要更新适配后才能导入。

### 授权弹窗验证补充

2026-10-22，基准提交仍为 `caacc59fd32dfb2f0ee55ca4e0c50c015b550021`，验证包含其上的未提交弹窗与并行凭据存储改动。环境为 macOS arm64、Node.js v22.22.3、Electron 44.0.0。本次仅调整授权界面，未重复运行完整单元测试集。

- `npm run build`、`node scripts/check-spacing.mjs`、`git diff --check`：通过。
- `node scripts/verify-oauth.mjs --dev-url=http://127.0.0.1:5187` 与 `node scripts/verify-oauth.mjs`：开发 renderer 和构建 renderer 各 23 项通过。新增真实 Electron 弹窗显示／焦点、重载恢复、Esc 取消、关闭取消并恢复焦点、浏览器等待期间保留弹窗、成功关闭并更新模型列表检查。继续覆盖原有三家账号选模与实际生产请求通道，凭据接口阻断保护保持启用。
- `node scripts/verify-oauth-visual.mjs`：入口、设备码、失败重试、授权码四种场景，在 1440／768／375 宽度共 12 组通过。检查弹窗命名、视口边界、焦点限制、授权码回车、失败重试与关闭后焦点；页面脚本错误为零。另采集系统 dark 偏好截图，并人工复核桌面和窄屏布局。

最新证据为 `.visual/workflow/vision/oauth-modal-layout.json`、`oauth-modal-*.png`、`oauth-electron-{dev,built}.json`，视觉说明见 `.visual/workflow/vision-report-oauth-modal.md`。外部真实账号及平台验证缺口同上；此次使用合成授权服务和独立临时应用数据目录。
