首个 Windows 正式安装包（NSIS x64）：全新安装、开始菜单快捷方式、系统卸载入口与应用内更新（latest.yml）。本版包含 v0.2.24–v0.2.30 的全部桌面功能与修复（订阅额度进度与余额查询、用量热力图、完成轮折叠、会话列表性能、更新器暂存清理，以及 v0.2.29/v0.2.30 的旧命令恢复与清理确认修复），并补齐 Windows 平台适配。

- Windows 窗口与导航：单行集成标题栏（保留系统最小化/最大化/关闭按钮），常驻「文件 / 编辑 / 视图 / 帮助」菜单；窄窗口自动收起会话栏。
- 桌面操控接入：设置页真实能力探测与应用授权，支持应用发现、启动与界面操作；浏览器操控走独立后台窗口。
- Shell 命令链路：在中文与空格路径、嵌套引号、UTF-8 输出与 cmd 条件语句等场景实测通过。
- 安全修复：Windows 系统目录拦截现按不区分大小写比较真实落点，修复 SystemRoot 大小写差异导致写保护被绕过的问题；Bot 运行时归档补齐 Windows 命令监督器组件。
- 稳定性：会话状态与历史写入增加 Windows 文件占用重试；重启后恢复到正确的会话与草稿；先添加附件的会话不再丢失恢复身份；模型自动恢复窗口期限锚定单一时刻；开发启动器兼容 Windows。
- 已知限制：语音链路（麦克风/ASR/TTS）未在 Windows 硬件验证；全局按键暂不可用；个别应用的桌面操控组合键与直接设值存在兼容限制；远程桌面会话断开期间自启动可能出现首屏布局失配，重启应用即可恢复；Bot 平台在 Windows 上一轮并发两个后台命令的段交接存在工具批早退问题（已跳过对应测试并跟踪），PC 主链路不受影响。

---

The first official Windows installer (NSIS x64): fresh install, Start Menu shortcut, system uninstall entry, and in-app updates (latest.yml). This release includes all desktop features and fixes from v0.2.24 through v0.2.30 (subscription quota progress and balance lookup, usage heatmap, completed-turn folding, conversation-list performance, updater staging cleanup, plus the v0.2.29/v0.2.30 old-command recovery and cleanup-confirmation fixes) and the Windows platform work.

- Windows window and navigation: a single integrated titlebar (native minimize/maximize/close preserved), a persistent File / Edit / View / Help menu, and an auto-collapsing conversation sidebar in narrow windows.
- Desktop control wired in: real capability probing and per-app authorization in Settings, app discovery/launch/UI automation, and browser control through a dedicated background window.
- Shell execution: verified against Chinese and spaced paths, nested quotes, UTF-8 output, and cmd conditional grouping.
- Security: the Windows system-directory write guard now compares real paths case-insensitively, fixing a bypass caused by the SystemRoot casing; the Bot runtime archive now ships the Windows command supervisor components.
- Stability: Windows file-lock retries for conversation state and history writes, correct session and draft restored after restart, attachment-first conversations no longer lose their restore identity, the model recovery window anchored to a single clock reading, and a Windows-compatible dev launcher.
- Known limitations: the voice path (microphone/ASR/TTS) is not yet verified on Windows hardware; global hotkeys are unavailable; some apps reject certain desktop-control key combos and direct value setting; launching while a remote-desktop session is disconnected can misplace the first screen until the app is restarted; on the Bot platform a tool batch can abort early during segment handoff with two concurrent background commands on Windows (the matching test is skipped and tracked) — the primary PC path is unaffected.
