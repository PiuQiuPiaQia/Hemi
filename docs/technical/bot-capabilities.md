# Bot 主机能力

Bot 与 PC 复用 Agent 运行时及工具实现。工作流和语音不在本次范围内，Linux 不开启桌面控制。

| 能力 | 主机行为与入口 |
| --- | --- |
| 浏览器 | 默认启用，操作 Bot 主机的浏览器。扩展未连接时使用独立无头 Chromium；会话登录状态属于 Bot。浏览器 DOM 操作资源随运行包分发。 |
| 联网检索 | Bot 设置中配置自己的 Tavily Key 后注册 `web_search` / `web_extract`。高级浏览器决策模型也使用 Bot 自己的接口、模型与 Key。 |
| 技能库 | Bot 设置的“管理 Bot 技能”提供市场、内置目录、安装、启停、删除和源码读取。导入本机文件夹时上传经过校验的文件集合，远端不解析客户端路径；项目技能继续自动发现。 |
| 完整历史 | `conversation_read` 读取 Bot 持有的完整公共时间线，使用快照引用和偏移分页。会话引用预览仍有长度限制，并提供准确的 conversationId 和完整历史读取指引。 |
| Windows Computer Use | `app_open`、`ui_list`、`ui_tree`、`ui_act`、窗口截图及定向鼠标／键盘操作。使用已有 Cua Driver 0.32.0 Windows 后端和原有应用授权卡。 |
| Windows 窗口资料 | Bot 输入框附件菜单的“Windows 窗口”读取远端窗口，添加所选窗口的当次截图和界面文字。截图是会话附件，界面文字标记为资料；发送时加入对应模型上下文。 |
| 诊断 | `get_runtime_diagnostics` 返回主机平台与脱敏能力状态。 |

## 配置及边界

`capabilities.json` 与技能目录放在 Bot dataDir。API Key 使用已有应用本地加密存储；检查、快照及保存回执只返回是否已配置，界面保存成功即清空输入框。修改能力配置要求当前无在途运行，新任务采用新配置。

技能库和项目技能一起参与公共 `collectSkills` 快照；用户选择的技能必须在当前主机目录可用且来源匹配。技能正文由 SDK 的常规文件读取工具按清单路径加载，不扩大文件／命令／应用权限。

窗口资料抓取先重新匹配 PID、规范应用身份和 windowId；截图只取所选窗口。操作写入会话的附件前要求当前写入端及 controlEpoch，复用串行化和持久请求回执。GUI 执行拒绝会如实返回错误，批量动作首败即停；失败时不改抓整屏。

## Windows 助手

常驻 Host 仍使用 S4U 计划任务，支持 SSH 断线后继续文件／命令任务。独立 `<主任务名>-Desktop` 任务使用当前账号的 Interactive principal、普通权限、Priority 4、登录与周期触发，执行稳定 `windows-launcher.mjs desktop`。更新停止旧助手后切换版本，回滚恢复先前任务；主任务启停同时管理助手。

Host 通过带控制令牌的本地命名管道调用助手。断线取消在途原语，不自动重复投递。助手串行执行原语，Cua 原生库懒加载；不自行实现鼠标或键盘注入。应用身份由可执行文件绝对路径或 AUMID 决定，启动只接受主机应用目录里的精确身份。

窗口 UIA 的后台读写和前台输入具有不同的系统条件。远程桌面断开后，部分 UIA 操作仍可能可用，前台输入则由 Windows 拒绝；状态显示连接情况，不用额外的输入桌面探测阻断有效的 UIA 路由。锁屏、注销和管理员权限窗口也可能导致驱动拒绝。

固定版 Cua 的 Windows 后台组合键和非 BMP 输入在真机出现过错误。工具提供显式 `delivery="foreground"`，经该固定版上游原生 wire 调用前台投递；Windows 系统指引要求组合键及 Emoji 使用该模式。前台投递需要连接且未锁定的桌面，用户明确要求后台时改用可用 UIA 语义操作或报告限制。动作结果仍须核对实际界面内容。

原生组件版本未升级。运行包保留 `THIRD-PARTY-NOTICES.md`、Cua MIT、Rust notices、Inter OFL 与 `native-components.json` 中已有的源码和许可指针。

## 验证记录（2026-10-27）

基线为 `487743f1b5d5b7a960d75d46a37823454bb05870` 加本次未提交工作树。环境为 macOS arm64 / Node 22.22.3，以及隔离的 Windows x64 / Node 22.22.3 测试任务；没有替换已安装 Bot 或读取个人窗口截图。证据位于忽略目录 `.visual/workflow/bot-capabilities/`。

- `npm test`：1919 项，1906 通过、13 平台／环境专属跳过、0 失败。随后桌面失败回执与必需截图目标的小调整另跑 `pi-desktop-tools.test.mjs` / `cua-client.test.mjs`，20 项通过。
- `npm run build`：通过；构建仅有现存大分块提示。`node scripts/check-spacing.mjs`、`git diff --check` 通过。
- `capabilities.integration.test.mjs`：真实 Host → Pi SDK → 独立 Chromium 的导航、中文输入、点击、正文读取、截图与任务清理；搜索／提取到真实本地 HTTP 供应商边界；跨重启的长历史分页；导入技能经 SDK 文件读取到实际模型请求。模型与供应商使用合成数据。
- 打包运行包解压到新目录后再次执行真实浏览器测试，通过；没有用源目录中的扩展资源补足运行包。
- `node scripts/verify-bot-capabilities-ui.mjs`：独立 `HEMI_USER_DATA_DIR`，开发及构建 renderer 各 3 条完整流程通过，覆盖窗口附件、真实配置 RPC、生产文件夹导入 IPC、启停及原文读取。截图检查 375 / 768 / 1440；系统深色偏好也有截图，但 classic 设置固定浅色，未据此声称验证独立深色皮肤。
- Windows 真机：生产 PowerShell 安装／回滚脚本解析、真实任务设置和交互助手任务配置共 3 项通过。实际 Host → SDK → 认证命名管道 → Cua 原生驱动的应用启动、目标截图、UIA 树、中文／Emoji 语义设值和按钮点击通过，测试应用自身写出的输入与结果文件逐字一致；手动窗口资料也通过真实 Host 登记为会话附件。完整前台键盘输入验收仍需保持 Windows 桌面连接且未锁定；当前远端返回 Disc，驱动明确拒绝前台 HWND 激活。用户选择暂缓该项、先完成其余验证，因此前台组合键和前台输入明确列为 deferred，未计为通过。`HEMI_BOT_VERIFY_BACKGROUND_ONLY=1` 可复现该后台验收范围，默认仍验证完整键盘流程。

没有验证 Windows 物理重启、所有第三方应用、管理员窗口、真实 Tavily / 决策模型账号或手机端新增的窗口选择 UI。手机原有对话可使用 Host 新工具，技能管理和窗口资料选择的新入口本次实现于 PC Bot 页面。代码未提交、推送或发版。

最终 Windows 后台验收运行包 SHA-256 为 `879e1bd51a4000783d5ab16cd5ce8831c700d19160928e188a8d81d015a97917`。测试前后常驻 Node 进程身份一致，隔离的交互测试任务、探测任务及本轮临时运行包已清理。源码指纹保存在证据目录的 `verification-inputs.json`。
