# Bot 模型同步与独立路由

2026-10-26（Asia/Shanghai）。首次初始化 Bot 时只同步本机可用模型；Bot 的主／角色／备用路由由用户在 Bot 中独立配置。后续从本机同步也不导入或覆盖路由。连接已有 Bot、重连、重启、轮询、选择模型和发送消息均使用 Host 已保存的配置，不上传本机变更。

## 设置与直接编辑

「设置 → Bot → 模型与路由」共用本机的供应商列表、详情及路由弹窗。列表按订阅、New API、API 配置、本机配置分组。API Key 模型无论首次来自本机还是在 Bot 新建，都可直接编辑名称、端点、协议、Key、型号、思考强度及图片能力；路由可直接选择 Bot 已有模型，角色留空跟随主模型，备用可不使用。

编辑只保存到 Bot，本机配置不变。已有供应商和型号保持稳定身份；Key 留空复用 Host 私有库中的原凭据，不回传输入框。账号模型由 Bot 独立登录管理，本机账号凭据不会通过配置同步上传。

## 从本机对比并选择同步

点击「从本机同步」才读取本机配置和 Host 当前配置。弹窗逐项列出模型新增、更新及仅在 Bot 存在的模型，展示 Bot／本机值和可公开的字段差异，不列路由同步项。默认不勾选任何项目；仅在 Bot 存在的 API Key 模型被明确勾选才移除。未选中的模型、凭据与 Bot 路由均保留。

本机回环地址、缺少 Key 的模型显示原因并禁用同步，不自动移除 Bot 的现存模型。本机订阅按账号合并显示「为 Bot 授权／重新授权」按钮，点击后进入共用授权弹窗；本机登录保持不变，Bot 独立保存凭据并续期，不复制本机现有登录。移除仍被 Bot 路由引用的模型前需在 Bot 中调整该路由。弹窗可重新对比，长列表滚动时保留操作区。

桌面服务的 `models.diff` 返回不含凭据的预览，并在内存中绑定实例、地址、本机模型摘要和 Host 配置版本；允许有界的并发预览，避免开发模式重复读取使仍有效的预览误过期。`models.sync` 只接受预览中勾选的模型，提交时重新读取本机模型。本机模型或 Host 配置有变化时拒绝覆盖，要求重新对比；单独修改本机路由不影响预览。

预览复用已成功接收的 Bot 模型目录和版本，不再为打开弹窗额外发起一次 SSH `snapshot`；提交时仍由 Host 检查保存版本，拒绝覆盖尚未看到的新配置。本机目录读取超过 15 秒返回明确错误，renderer 等待超过 20 秒也会结束加载并允许重新对比；旧请求的迟到结果不覆盖新预览，空回执显示错误。此主进程修复需要重启开发版应用后生效。

## 保存、验证与回执

初始化使用本机模型快照 `model.sync-local`，Host 忽略此接口的旧路由载荷并保留 Bot 自身路由。后续编辑、路由修改和选择性同步使用 `model.configure`，一次最多 1000 个模型、最多四路验证；模型同步不携带路由修改，明确删除项仍按 Bot 当前路由校验，任何失败均保留提交前配置。路由单独修改无需重新验证未变化的模型。

`modelConfigRevision` 仅由模型版本与路由计算，会话或流式输出不让预览失效。Host 在验证前后检查该版本，避免覆盖其它设备的新配置。同步结果落在同一持久化回执中，断线或重启后查询原操作，不重复上传凭据。最终回执始终向界面发布，即使实时事件已提前刷新模型目录，也不会把控件留在“正在同步”。

桌面服务没有模型后台任务、本机配置监听或自动重试。旧的分项同步协议继续兼容；不支持新接口的组件明确提示维护，不退回可能覆盖未选项目的整份同步。

## 共用执行策略

Host 使用本机相同的 `freezeModelPolicy` 与 `resolveModelPlan`，运行会话复用 `sessionModelOptions` 和 Hemi routing extension。自动模式中主 agent 使用主模型，四个角色使用各自模型，未设置的角色跟随主模型，共用备用。具体模型模式中主／子使用准确选择的模型，禁止切备用。图片等任务要求与候选能力求交集，不按型号名称猜能力。

每条输入冻结完整公开策略与各候选的版本引用，密钥仅保留在 Host 的私有版本库。密钥轮换、模型删除和路由变更不改变在途或排队消息。旧版本只在最后一个排队／运行引用结束后回收。本机离线时 Bot 与手机继续使用最后验证成功的配置；本机变更仅在手动同步后生效。

云端角色复用角色定义、派单工具与子 agent 管理器，工具限定为云端可用文件／命令能力。只读角色保留硬边界；角色授权进入所属根运行的现有权限卡，云端等待不使用桌面 30 秒超时。根运行停止会等待所属角色停止；后台报告经隐藏宿主事件交回主 agent 验收后再完成。角色定义随 Bot 运行包分发。移动端从 Host 元数据展示同一自动路由与来源图标。

## 补充验证：Bot 路由弹窗（2026-10-27）

共享路由弹窗在保存任一槽位时等待该操作完成，再开放下一次选择，避免远端保存期间触发并发保护。失败行的重试保留该次失败的槽位和值，其他槽位随后成功保存也不会改写重试目标。读取时显示状态，读取失败或 20 秒未返回时提供「重新读取」，过期回执不能覆盖重新读取后的视图。

基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作区，macOS arm64、Node 22.22.3、Electron 44。`node scripts/verify-bot-model-sync.mjs --routing-only` 在 Vite 开发和构建 renderer 均通过，覆盖实际 IPC／SSH runner／CLI／socket／Host 的六个槽位保存、清空、重开、失败行重试、读取失败与超时恢复；本机配置保持原值。构建、spacing 和 diff 检查通过，页面和 console 错误为零。另对实际绑定的 Windows Bot 做了只读角色目录核验，未替用户选择线上路由，也未重跑完整套件或真实付费模型调用。证据见 `.visual/workflow/bot-routing/e2e/report.json` 和 `.visual/workflow/vision-report-bot-routing-save.md`。

## 当前验证：只同步模型与订阅独立授权（2026-10-26）

本机路由在首次初始化、差异预览及提交中均不导入；Host 兼容旧 `model.sync-local` 载荷时也保留自身路由。订阅按账号提供独立授权按钮，完成后本机登录和 Bot 路由保持不变。模型同步／桌面服务／路由定向 36 项，以及补充 Host 兼容测试后的模型同步／账号／New API 定向 21 项均通过（两组重叠）。两套 Electron 脚本在开发与构建 renderer 再次通过，构建、spacing 和 diff 检查通过。

基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作区，macOS arm64、Node 22.22.3、Electron 44。使用隔离临时数据和合成账号，未重复全量测试、真实付费订阅、远端系统服务或手机验收。证据见 `.visual/workflow/bot-oauth/models-only-validation.json` 和 `.visual/workflow/vision-report-bot-model-sync-models-only.md`。

## 历史验证：差异同步（2026-10-26）

基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加当前未提交工作区，macOS arm64、Node 22.22.3、Electron 44。61 项相关服务／Host／真实 SDK 测试通过，`npm run build`、spacing 和 diff 检查通过。`node scripts/verify-bot-model-sync.mjs` 在 Vite 开发及构建 renderer 各通过 8 项，覆盖实际 IPC、Bot 直接编辑、路由编辑、逐项同步、未选配置保留、明确移除、失败与过期预览，以及 375／768／1440 宽度；页面与 console 错误为零。

全部应用验证使用全新临时 `HEMI_USER_DATA_DIR`。本次未重跑全量套件、远程 SSH/Linux systemd、真实供应商、手机硬件或真实账号登录。命令、环境、源码哈希、截图及边界见 `.visual/workflow/bot-model-diff/validation.md`、`source-manifest.json`、`e2e/report.json` 和 `.visual/workflow/vision-report-bot-model-diff.md`。

## 历史验证：整份手动同步（2026-10-26）

基于提交 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加当前未提交工作区，macOS arm64、Node 22.22.3、Electron 44。55 项相关服务／Host／真实 SDK 测试通过，`npm run build`、typecheck、spacing 和 diff 检查通过。`node scripts/verify-bot-model-sync.mjs` 在 Vite 开发及构建 renderer 各通过 8 项，覆盖实际 IPC、初始化、手动同步、失败保留、云端独立配置，以及 375／768／1440 宽度；页面与 console 错误为零。

全部应用验证使用全新临时 `HEMI_USER_DATA_DIR`。本次未重跑全量套件、远程 SSH/Linux systemd、真实供应商或手机硬件；SSH 远端系统边界与 HTTP 模型服务为隔离夹具。命令、环境、源码哈希、截图及剩余边界见 `.visual/workflow/bot-model-sync/validation.md`、`source-manifest.json`、`e2e/report.json` 和 `.visual/workflow/vision-report-bot-model-sync.md`。

## 历史验证记录（2026-10-24，旧自动同步策略）

基于提交 `aee7b5e6ef9e08b3d22caf3a85abfee3db3b515e` 加当前未提交工作区，macOS arm64、Node 22.22.3。任务开始时已有多项并行改动，本次增量修改，没有提交、推送或发版。所有 Electron 验证使用全新临时 `HEMI_USER_DATA_DIR`。

检查入口包括 `npm test`、`npm run build`、移动端测试／构建、`node scripts/check-spacing.mjs`、`git diff --check`、`node scripts/verify-bot-auto-models.mjs`，以及 `src/main/bot/model-routing.test.mjs` 的真实 Hemi SDK 测试。最终主套件 1728/1728、移动端 24/24 通过；桌面开发／构建界面共 14 项、移动端开发／构建界面共 16 项通过，页面与 console 错误为零。构建、spacing、diff 和运行包核对通过，renderer 许可清单 156 项且无待审查项。证据见 `.visual/workflow/bot-routing/validation.md` 和 `e2e/report.json`。

执行层验证覆盖四个角色的实际模型、主／角色备用切换、具体模型不切备用、冻结版本及旧凭据回收、来源保护、云端 Key 保留、本机配置自动更新。界面脚本经过真实 Electron → preload／IPC → SSH runner → CLI／Unix socket → Host → Hemi SDK → 隔离 HTTP 模型服务，分别检查开发与构建 renderer 的初始化、更新、失败恢复、云端新增／编辑、来源图标和本机修改跳转，覆盖 375／768／1440 宽度及系统深色／减少动态偏好。

上述界面验收中的 SSH 可执行文件与 Linux/systemd 边界使用隔离夹具。手机硬件仍未验收；重连提示的延迟展示仍按用户要求暂不处理。

2026-10-24 补充真实云端验收：通过当前绑定主机的真实 SSH、Linux x64、systemd 用户服务、Node 22.22.3 和 Pi SDK 1.3.0，部署当前工作区的运行包。6 个本机 API Key 模型均通过真实供应商调用验证。主模型、explorer、fixer 使用 `deepseek-v4.1-flash`，oracle、designer 使用 `gpt-6-astra`，备用为 `deepseek-flash`，四角色派单与最终回复均成功。

在同一云主机的隔离验收实例中，网络请求包装器分别对主模型、oracle 注入 HTTP 503，实际备用请求访问真实供应商并完成回复。本机配置使用绑定配置的私有副本，通过生产 profile store 的保存通知和 desktop service 自动更新；新增模型、修改主／角色／备用槽位约 6.2 秒后在云端生效，下一次真实运行使用新模型，并验证删除和恢复自动传播。原本机配置文件保持不变。

随后通过生产 transport 安装器更新原 Bot，自动配置同一组本机模型与路由，并在原 Bot 上再次完成四角色真实调用。实例身份保持一致，原有 12 个会话的标题、目录、模型、草稿、附件、文件、时间线和用量摘要通过更新前后哈希比对；临时验收会话已删除。运行包和云端源码逐文件比对，脱敏证据及命令记录见 `.visual/workflow/bot-routing-cloud/validation.md`、`report.json` 和 `source-manifest.json`。
