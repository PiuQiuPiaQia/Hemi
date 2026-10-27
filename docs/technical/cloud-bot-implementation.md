# 云端 Bot 实现与验收

已实现单 Bot 首版，依据 [需求文档](../requirements/cloud-bot.md) 和共用普通对话页面的 v3 交互方案。入口在左侧 Bot 导航。首次连接 Linux 或 Windows x64 SSH 主机后安装常驻 Host，远端持有模型、会话和执行状态；普通 SSH 工作区仍由桌面应用管理运行。Windows 的计划任务、命名管道、安装与验收边界见 [Windows Bot](bot-windows.md)。

桌面和 Bot 共用 VoiceScreen、侧栏、历史、输入、排队、编辑、模型菜单、权限卡、附件及文件阅读器。作用域内的 conversation bridge 适配数据来源，不替换全局 window.hemiVoice。Bot 的语音入口隐藏，ASR、duplex、TTS 和全局语音快捷键同时在主进程拦截。切回普通对话后使用原数据与执行流程。

## 运行与数据

| 部分 | 实现 |
| --- | --- |
| Host | Node 22，与桌面共用 agent-runtime/core.mjs、主／角色 Agent、Pi SDK 1.3.0、工具门控及 conversation controller；桌面 index.mjs 和 Bot runtime.mjs 只提供各自宿主依赖 |
| 常驻 | systemd 用户服务；要求该账号启用 linger。服务不依赖 SSH 会话或桌面进程 |
| 控制通道 | 严格核对主机密钥的 SSH，RPC 连接云端 0600 Unix socket；不开放公网控制端口 |
| 绑定 | 一台桌面绑定一个实例；稳定 instanceId 与每次进程 bootId 分开核对 |
| 任务 | Host 启动各会话独立执行，公共运行时在工具边界协调资源冲突；受理时冻结模型版本、目录、附件与技能身份；关闭客户端不取消任务 |
| 模型 | 初始化自动配置本机 API Key 模型及主／角色／备用路由，后续变更自动更新；电脑／服务器图标区分本机只读来源与云端可编辑来源；Host 实际请求验证，密钥不回传 renderer |
| 会话 | 独立草稿、模型、思考强度、目录、附件、权限及历史；新会话沿用最近打开或选择的模型，目录使用内置默认空间；初始化与设置不再要求配置默认模型或默认目录 |
| 文件夹 | 读取服务器真实子目录；安装 Node 前也可通过 SSH 浏览；服务器确认后更新会话目录 |
| 文件 | 实际上传与受控预览／下载。交付限定生产运行的目录，按会话和 artifact 身份读取 |
| 中断 | 稳定操作 ID 与持久回执；结果不明先核对；Host 重启不自动重放有副作用的任务 |

交付卡片只展示当前会话保留的正式登记记录；正文路径、Markdown 链接和成功读写工具调用不会自动成为交付物。正文路径仍可点击：Bot Host 按当前会话解析相对路径、`~/` 与 file URL，在家目录或当前工作目录内检查真实普通文件、敏感路径和 20 MB 上限；预览时重新检查。未登记链接的身份绑定会话，不写入交付表或持久化状态，下载入口仍只接受正式登记的文件。

每个会话可选择同一默认目录，也可选择其他云端目录。会话独立不代表文件系统隔离。Linux 文件及命令沿用 Hemi 门控；这里没有额外的容器沙箱。需要确认的操作只等待所属任务，不阻止其他会话。公共 resourceGateway 协调显式文件工具目标的冲突读写；普通 Shell 不申请工作目录锁，后台命令也不会阻塞同目录的其他会话。后台进程仍由原目标跟踪、取消并在结束后交回结果。停止资源等待不执行该操作，也不停止资源持有者；需要隔离任意 Shell 的并发写入时使用独立工作目录。

Host 工具包括文件读写、检索、bash、交付登记、完整会话历史读取、主机浏览器和技能库；配置 Tavily 后提供联网检索与正文提取。Windows 另提供交互桌面助手，Linux 不提供桌面控制。能力配置、密钥和技能库存于 Bot，显式技能选择复用普通对话的指令装配；本机配置不会自动复制过去。主 Agent 与四种角色的委派、路由、预算及后台结果验收复用公共运行时，详见 [Bot 主机能力](bot-capabilities.md)。

## 安装与维护

支持有 systemd 用户服务的 Linux arm64／x64，账号主目录须可写、至少 512 MB 可用空间，并可访问 Node 官方分发和 npm registry。沿用系统 SSH 配置、密钥／agent、密码保存方式。未知或变化的指纹阻止连接；linger 未启用时给出管理员处理说明，不自动提权。

Windows x64 使用同一 SSH 入口，要求 PowerShell 5.1、OpenSSH Server、tar 和可用的 Task Scheduler。专用目录仍在账号主目录的 `.local/share/hemi-bot` 下，通过 S4U 计划任务以当前账号的有限权限常驻；停止操作同时禁用计划任务。Windows 每次 npm 安装等待上限为 300 秒，Linux 保持 90 秒。详见 [Windows Bot](bot-windows.md)。

服务器有合格 Node 22 与 npm 时复用；缺少时在 Bot 专用目录部署固定 Node 22.22.3，并核验官方 SHA-256，不改全局 Node。安装上传版本化源码包，核验摘要，按锁文件 npm ci，启用服务，验证模型、文件和命令，再断开 SSH 核对同一常驻进程。

依赖安装由选定的 Node 运行 npm 的 JS 入口，使用 Bot 专用 npm-cache，不清理或修改账号的全局 npm 配置与缓存。关闭依赖安装脚本，限制下载并发和请求超时，每次安装最多等待 90 秒。首先沿用服务器 npm 源及代理配置；遇到下载或 npm 退出异常时，尝试通过服务器的交互式登录 shell 读取代理环境变量（探测最多 5 秒，只取 HTTP_PROXY／HTTPS_PROXY／ALL_PROXY／NO_PROXY 及 npm 对应变量，兼容大小写），在尚未启用的新组件目录中用新缓存再尝试一次。ALL_PROXY 会映射到 npm 支持的 HTTP(S) 代理变量，包含 SOCKS 代理。仍出现下载或 npm 异常时，最后使用 https://registry.npmmirror.com/ 直连兜底，仅本次 npm 子进程切源并绕过代理，只替换锁文件中官方 npm 源的下载地址，保留锁定版本、integrity 校验和 TLS 校验，不改全局 npmrc 或锁文件。

包校验失败只重试一次新缓存；权限不足、磁盘不足、依赖清单错误、鉴权/包不存在错误和安装进程超时不自动重试。最多三次仍失败时不切换当前组件，界面显示错误类别及服务器上的私有安装日志路径（~/.local/share/hemi-bot/install-logs/）。日志记录尝试策略，不在返回界面的诊断信息中包含代理地址或凭据。

| 路径 | 用途 |
| --- | --- |
| ~/.local/share/hemi-bot/current | 当前组件 |
| ~/.local/share/hemi-bot/releases | 当前与上一组件；成功安装后清理更早版本 |
| ~/.local/share/hemi-bot/runtime | 私有 Node（需要时） |
| ~/.local/share/hemi-bot/data | 0700 数据目录；state.json、附件和授权，文件限定运行账号访问 |
| ~/.config/systemd/user/hemi-bot.service | 常驻服务定义 |
| 桌面 userData/bot | 本机绑定、展示缓存、离线草稿和不含密钥的结构化诊断 |

维护要求云端空闲，有任务时提示等待完成后重试；握手失败自动切回上一组件，保留数据。断开连接不停止任务；停止 Bot 先等云端取消完成，再 disable --now，收到系统回执后才确认常驻已停止。重启后保留暂停队列，由用户明确继续。

组件自动维护由桌面后台服务调度：首次恢复连接后延迟 30 秒检查，此后每 6 小时检查一次，失败后同样退避 6 小时；有任务或其他维护操作时，每分钟确认一次是否空闲。切换对话、Bot 与设置页面不触发额外检查，也不停止后台更新。主动断开、停止或移除绑定后取消检查。检查、更新、失败及最后检查时间仅在「设置 → Bot → 通用」展示，聊天页面不显示组件维护横幅；设置中可立即手动检查或重试。

“仅移除本机绑定”保留云端服务、数据及凭据；“停止并移除”以停止确认成功为前提。重新连接同一服务器识别原实例，恢复原记录，不重复安装。新地址必须核对同一实例身份。

模型选择器读取 Host 已保存的配置。首次初始化同步本机可用模型及主／角色／备用路由。Bot 模型设置统一展示当前模型与路由，支持直接编辑；修改只写入 Bot，本机配置不变，Key 留空保留 Host 原凭据。点击「从本机同步」后才读取本机配置并逐项对比，默认不勾选，仅同步选中的模型和路由，删除项需明确勾选。重连、轮询和发送消息均不上传本机变更。

Host 受理输入时复用 `freezeModelPolicy` 冻结完整策略，并记录所有候选的版本引用；运行时复用 `resolveModelPlan`、`sessionModelOptions`、Hemi 的 routing extension 和角色管理器，主模型、角色模型及备用切换遵循相同规则。具体模型模式不借用备用。排队版本在模型更改、删除和密钥轮换后继续保留，到最后一个引用任务结束后回收。公开快照不包含 Key。

云端角色工具白名单与已启用的主机能力共同决定可用工具。只读角色保持硬边界，权限请求交回所属运行的现有确认卡且不使用桌面的 30 秒超时；停止根运行会等待所属角色收口，后台角色结果交回主 agent 后才完成。角色定义 Markdown 必须随运行包分发。手机从 Host 目录取得自动路由入口及来源，不提供独立路由配置。

编辑与差异同步使用带配置版本校验的 `model.configure`，一次验证、保存选中的变更，未选项目保留。任何验证失败保留原配置，断线先核对持久化回执；本机或 Bot 配置在预览后变化时要求重新对比。回环地址、缺少 Key 及本机账号模型列出原因并禁用同步，不隐式删除 Bot 原配置。详情及验证记录见 [Bot 模型与路由同步](bot-model-auto-config.md)。

彻底清理时，在服务器执行 systemctl --user disable --now hemi-bot，删除服务文件与 ~/.local/share/hemi-bot，再执行 systemctl --user daemon-reload。删除安装目录会永久删除云端会话、附件和凭据；默认空间与用户工作目录保留。模型密钥需要在供应商后台另行撤销。设置的移除确认中也包含该说明。

## 验证方式

使用 macOS arm64、Node 22.22.3、Electron 44、Docker Desktop 中 Debian Bookworm arm64 / Node 22.22.3。所有 Electron 验证均设置独立 HEMI_USER_DATA_DIR；Linux 容器不挂载宿主目录，只向 127.0.0.1 发布 SSH。

模型端使用本地隔离的 OpenAI SSE 替身；实际执行 Hemi SDK、SSH、systemd、IPC、控制器、目录读取、权限和文件传输。原生选文件与保存对话框仅在验证中指定临时路径，未替换业务 IPC 或云端服务。

可复跑：

```sh
npm test
npm run build
node scripts/check-spacing.mjs
HEMI_KEEP_BOT_TEST_CONTAINER=1 node scripts/verify-bot-linux.mjs
node scripts/verify-bot-maintenance.mjs
# 在另一终端启动项目的 Vite renderer，以下示例使用 5193
VITE_DEV_SERVER_URL=http://127.0.0.1:5193 node scripts/verify-bot-ui.mjs
node scripts/verify-bot-ui.mjs
```

验证脚本输出位于忽略目录 .visual/workflow/bot-implementation。Linux 环境的元数据保留在 linux-validation.json，UI 两种模式分别记录 report.json 与截图。脚本默认关闭 Electron；Linux 测试设置 KEEP 时保留容器供后续 UI 验证，完成后应移除该命名容器及临时 SSH 密钥。

已验证：真实严格 SSH 探测、私有 Node 首次部署、SDK 模型验证、文件命令及下载字节、SSH 断开与完全退出 Electron 后续跑、同实例恢复、多会话草稿／目录隔离、离线草稿、附件上传及预览、排队编辑／撤回、/model、手动勾选同步、权限等待超过 35 秒及拒绝、PDF 阅读、诊断脱敏、删除当前及运行中会话、停止／启动、移除后重新绑定、失败回滚、主机密钥不匹配拒绝。375、768、1180、1440 宽度通过页面溢出检查。应用当前只支持 light 外观，另检查系统深色偏好与减少动态效果。

普通对话另跑 verify-turn-stage-flow.mjs，在开发和构建 renderer 中验证实际 read/bash 回流、思考与工具展示、停止、重载和虚拟列表恢复。

cc 完成两轮只读 review。删除会话、待确认回执、初始化重试、草稿冲突、权限选项、旧凭据回收等问题已修复并增加针对性回归。限定复核曾遇上游 503，重试后完成并确认权限卡、初始化重试及草稿冲突三项闭环；另完成实际构建界面的视觉 review，未发现阻断问题。窄窗同步结果提示由用户确认关闭；状态圆点有无障碍标签，移除操作有二次确认。

未使用真实云主机、真实供应商凭据、真实密码 SSH、Linux x64 或 Windows 桌面进行验收。构建 renderer 运行于仓库 Electron，未制作签名安装包、提交代码或发版。公开 Hemi SDK 的整体抽离是独立需求，本次部署包复用现有会话内核。

## 最终验收记录

验收日期：2026-10-23（Asia/Shanghai）。测试基于提交 4e6f51707269cd4152ed7da9cd4fc00c21ca12c1 加当前未提交工作区；没有提交或推送。

源码清单：.visual/workflow/bot-implementation/source-manifest.json，含 939 个源码／脚本／配置文件。SHA-256：85dbd4372a4821037d28a5a9df94cd5e047601dd019a21e859c0ed57db38083d。生成的运行包 SHA-256：fca81cbba6fe5c10f4a27305c3e237f8633b5e649195bddbb5c4e04bd252b48e。

| 检查 | 结果 |
| --- | --- |
| npm test | 1597 / 1597 通过，无跳过 |
| npm run build | 通过；Vite 仍提示已有大 chunk，需要后续独立优化 |
| spacing 与 git diff --check | 通过 |
| 完整 Bot Electron 流程 | Vite 开发 renderer 与构建 renderer 均通过，无 renderer 异常 |
| 最新生命周期补充 | 两种 renderer 均通过：全新临时桌面数据、三类语音入口主进程拒绝、只读切换后重启恢复草稿、系统停止确认、删除当前会话 |
| 普通对话回归 | 两种 renderer 均通过 8 项实际 read/bash、恢复及虚拟列表检查 |
| Linux 维护 | 真实启动失败回滚、主机密钥冲突拦截通过 |
| Linux 驻留 | 隔离容器 PID1 重启后 systemd/linger 恢复同一实例；停止后再重启不自动恢复；这是容器系统服务重启，不是物理云主机内核重启 |
| cc | 两轮代码 review、关键修复专项复核、四张真实界面的视觉 review 完成；视觉无阻断问题 |

曾有一次并行隔离验收期间，本地 SSE 夹具的模型连接验证未通过；增加内部失败诊断后，独立 SDK 检查及完整套件重跑通过，验证成功条件没有放宽。未能稳定复现，作为后续观察项保留。

事先已有的后台命令、过程显示和 SDK 需求等工作保持原状；对未涉及集成的原有修改逐文件核对摘要，无额外改动。测试结束清理独立容器、临时用户数据与 SSH 密钥，保留忽略目录中的报告和截图。

## 安装网络兜底专项验证

2026-10-23（Asia/Shanghai），基于 b31c949bc4f3920e961881cf979e5f1693ca8a38 加未提交工作区；环境为 macOS 26.5.1 arm64、Node 22.22.3、npm 10.9.8。设置全新临时 HEMI_USER_DATA_DIR，运行 `node --test --test-reporter=dot src/main/bot/install-dependencies.test.mjs src/main/bot/directories.test.mjs src/main/bot/desktop-service.test.mjs src/main/remote/ssh-runner.test.mjs`，46 项全部通过；`npm run build:bot` 和 `git diff --check` 通过。

真实 npm 验证覆盖 503 后重试、探测到的代理覆盖旧 npmrc 代理、直连镜像绕过失效 npmrc 代理、包内容变动触发 integrity 拒绝、锁文件与 npmrc 不变、安装脚本不执行。实际执行生产安装 shell，确认依赖失败不切换 current、不改原数据或服务文件，并释放安装锁。交互式 shell 探测另覆盖无换行横幅、变量白名单及启动脚本子进程超时。运行包中的 installer／transport 与当前源码逐字节一致，不含测试或 AppleDouble 文件。

记录位于忽略目录 `.visual/workflow/bot-install-fallback/report.json`，包含源码和运行包摘要。尚未读取报错 Ubuntu 服务器的 debug 日志或核实其代理；镜像下载使用本地 HTTP 夹具验证，未在真实云主机或公共 npmmirror 上验收。Docker daemon 未响应，本次未运行 Linux systemd 回归；没有 renderer 改动，未跑全量构建、全量测试或 Electron 回归。代码未提交、推送或发版。

## 模型添加双页签专项验证

2026-10-23（Asia/Shanghai），基于 b31c949bc4f3920e961881cf979e5f1693ca8a38 加未提交工作区；macOS 26.5.1 arm64、Node 22.22.3、Electron 44。`node --test src/main/bot/desktop-service.test.mjs src/main/bot/host.test.mjs src/main/bot/runtime.test.mjs src/main/bot/runtime.integration.test.mjs src/main/bot/cli.test.mjs` 的 30 项，以及随后新增的手动供应商整组保存测试均通过，共 31 项。`npm run build`、后续类型检查／renderer 构建／Bot 运行包构建、spacing 与 diff 检查通过；保留现有 Vite 大 chunk 提示。

`node scripts/verify-bot-models.mjs` 在全新临时 HEMI_USER_DATA_DIR 下分别启动 Vite 开发 renderer 与构建 renderer，经过真实 preload／IPC、SSH runner、CLI／私有 socket Host、Hemi SDK 和隔离 HTTP 模型夹具，完成无本机模型时手动初始化、服务器测试与拉取型号、手动保存、本机导入、错误文案脱敏、原配置保留及本机模型目录不变验证。两种模式均通过，console／renderer 异常为零。31 项服务测试另覆盖重复操作、丢失回执后重启核对、手动 localhost 与导入回环地址的区别、整组失败不产生半成品。

界面检查覆盖 375／768／1440 宽度、深色偏好与减少动态效果、页签方向键、切换后保留草稿，以及选择列表展开时一次点击导入按钮。截图、源码摘要和报告位于忽略目录 `.visual/workflow/bot-models/`，视觉结论见 `.visual/workflow/vision-report-bot-models.md`。本次修复了在 pointerdown／失焦时提前折叠列表导致按钮移位、点击丢失的问题。应用仍使用 light 皮肤；深色偏好检查不等同于提供新深色主题。

本次 SSH 的 Linux／systemd 边界由隔离脚本替代，Host、SDK、IPC 及模型 HTTP 请求均实际执行；未连接真实云服务器或真实供应商账号。原有 Linux UI 验证脚本已适配新页签及文案并通过语法检查，未重跑 Linux/systemd 全流程。没有提交、推送或发版，工作区其余并行修改保持原状。

模型保存成功提示改为复用现有 `h37-toast h37-toast-card`：底部居中白底绿勾，2.6 秒自动消失，移除成功横幅及“知道了”按钮；失败和待核对状态保留操作入口。到期按 instanceId／requestId 清理成功回执，旧 toast 不能清除更新的模型操作。验证仍基于上述提交与环境；`npm run typecheck`、`npm run build:renderer`、spacing／diff 检查通过，新增旧回执不能清除新结果的专项测试通过。`node scripts/verify-bot-models.mjs` 在开发／构建 renderer 均验证真实模型保存后的 toast 出现、自动消退、成功回执清理，以及失败横幅保留，console／renderer 异常为零。截图为 `.visual/workflow/bot-models/{dev,built}-model-saved-toast.png`，不涉及新依赖、全量测试或 Linux/systemd 回归。

## Bot 启动页样式修复（2026-10-24）

已绑定但尚无可展示对话的分支，原先只渲染状态文字和连续按钮，遗漏欢迎页的排版。现复用 `h-bot-welcome`，统一图标、标题、服务器地址及可换行的按钮组；已停止状态强调“启动 Bot”，连接断开状态强调“重新连接”。正文及按钮使用13px令牌。修正 Bot 样式中未定义的 `--fs-22`／`--shadow-3`，改用现有20px字号及第二档阴影，避免回退为继承字号或无阴影。未改变启动／重连的IPC或服务实现。

验证基准 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加未提交工作区，macOS26.5.1 arm64／Node22.22.3／Electron44.0.0。`npm run typecheck`、`npm run build:renderer`、spacing与diff检查通过。忽略目录脚本 `node .visual/workflow/verify-bot-startup.mjs` 使用全新临时 `HEMI_USER_DATA_DIR`，在真实Electron／preload／IPC中分别验证开发及构建renderer的未绑定、断开、已停止三种状态；覆盖1440/768/375宽度及375x360矮窗、单主操作、设置／创建连接弹窗和重连失败提示，异常为零。SSH替换为仅返回失败的本地脚本，没有连接真实服务器或执行云端启动。macOS会限制过高窗口，报告记录实际高度；检查过程中发现并修复无效字号令牌后，最终六组全部通过。临时Electron、Vite及测试数据均清理。未运行全套测试或无关桌面回归。

源码摘要、实际视口尺寸及截图见 `.visual/workflow/pc-bot-startup/report.json`，视觉记录见 `.visual/workflow/vision-report-pc-bot-startup.md`。当前开发renderer可热更新，已生成新构建产物，尚未发布或替换已安装的桌面发行版。


## 提交前综合复查（2026-10-24）

基准为 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加当前工作区，环境 macOS26.5.1 arm64／Node22.22.3／Electron44／Xcode26.6。审查发现设备网关逐片解码UTF-8会损坏跨分片的中文或emoji，实际TLS可复现为合法证明被拒绝；改为有界收齐字节后统一解码，真实TLS测试覆盖三字节及四字节字符的多种切点。两项旧交付去重测试缺少登记数据，按当前“只有登记成果生成卡片”规则补齐夹具，同时增加同回合重复入口，保留跨回合及缓存去重断言。

扫码端到端复查另发现主动断开后的迟到轮询可恢复online状态；现断开立即发布离线意图，刷新在握手、快照、草稿及回执异步边界检查连接意图／身份，停止、断开、移除后丢弃旧结果。新增not-modified与完整快照的确定性回归测试，明确重连后才恢复。macOS扫码验证夹具保留实际PC二维码像素，Core Image未识别时使用Vision CPU路径，避免测试机ANE模型不可用；生产iOS扫码实现不变。

最终 `node scripts/run-tests.mjs` 1704/1704通过（此前 `npm test` 首轮1699/1701、修复网关和夹具后1702/1702）；`npm test --workspace @hemi/mobile` 22/22通过，SDK单独41/41通过并包含于主套件。桌面与移动构建、renderer许可重生成（156项，无待补声明）、移动npm／原生许可复查（130项npm清单）、spacing及diff检查通过。`verify-device-pairing.mjs` 开发／构建均通过真实Electron/preload/IPC/CLI/Host到原生CryptoKit／固定证书TLS的扫码、核对、丢失回执、创建发送、撤销及断线隐藏／取消流程；SSH与Keychain为隔离夹具。`verify-mobile-resource-device.mjs`、`verify-mobile-resource-store.mjs` 通过生产原生TLS分片、摘要和暂存生命周期检查。`verify-registered-deliverables.mjs` 开发／构建均通过真实本地和Bot执行器的登记卡片、正文路径预览、错误与窄屏检查。独立临时HEMI_USER_DATA_DIR的Electron smoke通过，未配置模型／语音的拒绝属于其预期检查。

证据在忽略目录 `.visual/workflow/commit-*.log`、`device-pairing/`、`vision/registered-deliverables/` 及最终提交快照清单。此前的移动端开发／构建和真机验收记录仍见移动实施文档。本轮未新增Android原生Bot桥验收、iPhone相机／系统文件面板人工复测、云服务器部署或桌面发行版升级；原生网络检查在macOS编译运行生产Swift客户端。凭据、签名配置、用户数据、二维码截图和临时验证产物均不纳入提交。
