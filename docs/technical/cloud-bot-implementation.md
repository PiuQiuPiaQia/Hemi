# 云端 Bot 实现与验收

已实现单 Bot 首版，依据 [需求文档](../requirements/cloud-bot.md) 和共用普通对话页面的 v3 交互方案。入口在左侧 Bot 导航。首次连接 Linux SSH 服务器后安装常驻 Host，云端持有模型、会话和执行状态；普通 SSH 工作区仍由桌面应用管理运行。

桌面和 Bot 共用 VoiceScreen、侧栏、历史、输入、排队、编辑、模型菜单、权限卡、附件及文件阅读器。作用域内的 conversation bridge 适配数据来源，不替换全局 window.hemiVoice。Bot 的语音入口隐藏，ASR、duplex、TTS 和全局语音快捷键同时在主进程拦截。切回普通对话后使用原数据与执行流程。

## 运行与数据

| 部分 | 实现 |
| --- | --- |
| Host | Node 22，复用 createHemiSession、Pi SDK 1.3.0、Hemi 工具门控和 conversation controller |
| 常驻 | systemd 用户服务；要求该账号启用 linger。服务不依赖 SSH 会话或桌面进程 |
| 控制通道 | 严格核对主机密钥的 SSH，RPC 连接云端 0600 Unix socket；不开放公网控制端口 |
| 绑定 | 一台桌面绑定一个实例；稳定 instanceId 与每次进程 bootId 分开核对 |
| 任务 | Host 串行调度各会话；受理时冻结模型版本、目录、附件与技能身份；关闭客户端不取消任务 |
| 模型 | 用户手动勾选 API Key 模型；主进程解密和传输，云端实际请求验证；不把密钥回传 renderer |
| 会话 | 独立草稿、模型、思考强度、目录、附件、权限及历史；新会话沿用最近打开或选择的模型，目录使用内置默认空间；初始化与设置不再要求配置默认模型或默认目录 |
| 文件夹 | 读取服务器真实子目录；安装 Node 前也可通过 SSH 浏览；服务器确认后更新会话目录 |
| 文件 | 实际上传与受控预览／下载。交付限定生产运行的目录，按会话和 artifact 身份读取 |
| 中断 | 稳定操作 ID 与持久回执；结果不明先核对；Host 重启不自动重放有副作用的任务 |

每个会话可选择同一默认目录，也可选择其他云端目录。会话独立不代表文件系统隔离。Linux 文件及命令沿用 Hemi 门控；这里没有额外的容器沙箱。遇到需要用户确认的操作，Host 持续等待，后续任务排队，直至用户处理或停止。

Host 默认工具为文件读写、检索、bash、交付登记和云端项目技能。显式技能选择复用普通对话的指令装配。不会复制本机技能库、记忆、工作流或 OAuth 登录；本版不提供云端浏览器、桌面接管及子 Agent 委派。界面提供能力说明。

## 安装与维护

支持有 systemd 用户服务的 Linux arm64／x64，账号主目录须可写、至少 512 MB 可用空间，并可访问 Node 官方分发和 npm registry。沿用系统 SSH 配置、密钥／agent、密码保存方式。未知或变化的指纹阻止连接；linger 未启用时给出管理员处理说明，不自动提权。

服务器有合格 Node 22 与 npm 时复用；缺少时在 Bot 专用目录部署固定 Node 22.22.3，并核验官方 SHA-256，不改全局 Node。安装上传版本化源码包，核验摘要，按锁文件 npm ci，启用服务，验证模型、文件和命令，再断开 SSH 核对同一常驻进程。

| 路径 | 用途 |
| --- | --- |
| ~/.local/share/hemi-bot/current | 当前组件 |
| ~/.local/share/hemi-bot/releases | 当前与上一组件；成功安装后清理更早版本 |
| ~/.local/share/hemi-bot/runtime | 私有 Node（需要时） |
| ~/.local/share/hemi-bot/data | 0700 数据目录；state.json、附件和授权，文件限定运行账号访问 |
| ~/.config/systemd/user/hemi-bot.service | 常驻服务定义 |
| 桌面 userData/bot | 本机绑定、展示缓存、离线草稿和不含密钥的结构化诊断 |

维护要求云端空闲，有任务时提示等待完成后重试；握手失败自动切回上一组件，保留数据。断开连接不停止任务；停止 Bot 先等云端取消完成，再 disable --now，收到系统回执后才确认常驻已停止。重启后保留暂停队列，由用户明确继续。

“仅移除本机绑定”保留云端服务、数据及凭据；“停止并移除”以停止确认成功为前提。重新连接同一服务器识别原实例，恢复原记录，不重复安装。新地址必须核对同一实例身份。

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
