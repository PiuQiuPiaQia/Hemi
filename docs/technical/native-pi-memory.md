# 原生 pi-memory 实现与验收记录

更新：2026-10-27（Asia/Shanghai）。需求：[原生共享记忆重构 v1.2](../requirements/native-pi-memory.md)。代码基线 `4af7ccbe70f9ffcd13854a8868ca034825e6e76d` 加未提交工作树。保留并行的 Bot、模型、浏览器和队列改动；本次没有提交、推送、发布或更新用户的实际 Bot。

## 当前交付

每个桌面或 Bot 一个 `<dataDir>/pi-memory/` 共享库。Pi SDK 1.3.0 通过 `DefaultResourceLoader.additionalExtensionPaths` 加载原版 `pi-memory@0.4.2`。保留原包的源码、清单、安装脚本、文档及 LICENSE，不 fork、打补丁、复制工具实现或增加 MemoryClient。

主会话与工作流根会话加载插件；子 Agent、验证和模型探测会话不加载。同一进程只服务一个所属实例，主会话仍可并发。原生写入、遗忘、恢复及快照行为直接执行上游处理函数，不增加整库队列或另一套存储。

旧记忆服务、条目管理、提炼队列、桥接、旧 IPC 和分区界面已删除。旧用户文件不读取、不转换、不删除。登录状态的 `provider-import/login-memory` 等非记忆能力保留。

## 自动整理与模型认证

正常结束原生会话时，插件按需把重要决定、经验和后续事项保存到每日日志。进程固定 `PI_MEMORY_EXIT_SUMMARY=1`；产品没有单独开关、配置写入接口或“重启后生效”状态。此前保存的关闭值不再影响运行时。

关闭等待原生 `session_shutdown`，最多 30 秒，然后释放会话。单轮结束和页面切换不结束执行会话；模型／工作目录切换、LRU 释放及回卷失效使用 `reload`，遵循插件跳过过渡摘要的规则。Bot 的 `service.stop` 只停止受理和工作，实际 Host 结束才派发关闭事件。Host 关闭后不安排迟到的延迟写盘。

路由会话结束时使用最后实际执行的物理 SDK 模型。OAuth 模型通过公开 API 登记 `stream` 与 `streamSimple`，均由已有 OAuth 服务解析模型与凭据，原生摘要的 `complete()` 不会发送别名占位键。三种 API 协议及四家 OAuth 的固定／路由摘要使用真实 SDK 和合成 HTTP 外部端点验证。

摘要用量尚未进入对话账本，页面直接说明。原版插件会在内部捕获部分摘要错误，Hemi 不把关闭钩子返回当成保存成功，也不补造成功状态；结果以真实日志为准。

## 不交付大型搜索组件

按用户最新决定，移除 qmd 部署器、五个平台锁文件、安装 IPC／Bot RPC、搜索状态及安装按钮，不内置额外 Node、原生推理库或 GGUF 权重，也不自动下载安装这些依赖。约 2.25 GB 的搜索模型不属于当前产品功能。

通过 SDK 的公开 `excludeTools` 排除 `memory_search` 和 `memory_status`，不改写原插件，不做同名替身或备用字符串搜索。保留 `memory_write`、`memory_read`、`memory_forget`、`memory_restore`、`scratchpad`。上下文继续从同一份原生文件取得，基础记忆不依赖 qmd。

| 环境 | 固定值／作用 |
| --- | --- |
| `PI_MEMORY_DIR` | 所属实例的 `pi-memory/` |
| `PI_MEMORY_SNAPSHOT` | `per-turn`，每轮读取共享文件 |
| `PI_MEMORY_NO_SEARCH` | `1`，关闭隐式检索 |
| `PI_MEMORY_QMD_UPDATE` | `off`，关闭后台索引及嵌入模型下载 |
| `PI_MEMORY_EXIT_SUMMARY` | `1`，自动整理启用 |
| `QMD_CONFIG_DIR`、`XDG_CACHE_HOME` | 保持实例隔离，保护用户已有的外部 qmd 配置 |

原包仍可能在会话开始时探测可选 qmd，并记录缺失信息；这不触发 Hemi 安装流程。即便系统已有 qmd，后台嵌入仍关闭。用户以前的外部 qmd 数据不做清理。

## 查看界面

桌面和 Bot 使用同一组件，按长期记忆、每日日志、待办和恢复记录查看原始 Markdown／JSON。页面仅提供刷新、选文件和复制；修改、遗忘和恢复在所属对话中用原生工具完成。恢复记录按明确选择读取。

记忆类别和刷新合并为一条工具栏，删除重复的共享说明、内容标题及操作提示。自动整理仅保留一行，使用当前模型及用量统计边界在信息浮层中查看，没有设置卡片或开关。窄屏的类别排成两列，文档长行可折行。

原始文件接口校验所属实例、身份、路径、符号链接、类型、大小和 UTF-8。手机读取当前 Bot 的相同文件，正文不放进持久缓存；迟到读取与实例切换有失效保护。需要 `nativeMemory: 1` 能力，旧 Bot 提示更新。

## 验证记录

2026-10-26 已完成原包完整性、共享并发、原生遗忘／恢复、跨项目快照、压缩与关闭、三种 API／四家 OAuth、桌面 dev／built／unsigned app、手机 dev／built、Bot Unix RPC 和隔离 Linux SSH／systemd／TLS／崩溃恢复验证。旧搜索专项仅是历史证据，不代表当前仍交付搜索能力。

2026-10-27 本次简化使用 macOS arm64、Node 22.22.3、Electron 44，临时 `HEMI_USER_DATA_DIR` 及合成 HTTP 模型端点。检查和结果保存在忽略目录 `.visual/workflow/memory-simplified/`：

| 检查 | 当前记录 |
| --- | --- |
| 原生环境、SDK、Bot Host／TLS、三种 API 及四家 OAuth | 26 项定向测试通过；自动整理固定启用，两个 qmd 工具不声明 |
| TypeScript | `npm run typecheck` 通过 |
| 构建、全量回归、实际桌面与 Bot 产物 | 桌面构建通过；全量 1827 项：1820 通过、0 失败、7 项 Windows 环境用例跳过；真实 Bot tgz 原包核对、工具执行与崩溃恢复通过 |
| 界面 | 开发与构建 renderer 的空库／正文、刷新、类别、窄屏和深色使用截图复核 |
| 样式和差异 | `node scripts/check-spacing.mjs`、`git diff --check` |

所有会话和凭据均为测试夹具。未把真实模型服务商、Windows 打包或物理手机安装声明为本次通过项。未修改用户安装数据或现有 Bot。
