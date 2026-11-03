# 基于 DSH 官方 Desktop 重构：二开范围需求梳理

状态：草案，待评审，未批准实施。
日期：2026-11-03。信息基线：DSH npm `@deepseek-ai/dsh@0.2.1-rc.5` 包清单（227 个 `@deepseek-ai/*` 包）、官方仓库 `deepseek-ai/deepseek-harness` `apps/desktop` 的 README／开发指南／打包指南、本机 DataElement `dsh-desktop` v0.12.1 源码审计、Hemi v0.2.58 功能清单（README 与 docs）。
性质：静态审计与包面映射，**未运行验证**；结论中所有"原生覆盖"指包清单与文档证据，具体行为需原型阶段逐条核实。

## 背景与前提

- 维护疲惫集中在自研调度层（会话流、任务收口、后台命令、目标续跑），而非工具实现层。
- 方向调整为：放弃现有 Pi 自研栈，**基于官方 DeepSeek Harness（DSH）框架与其官方 Desktop 应用二开**。官方 Desktop 与框架同仓库同版本节奏，不存在第三方补丁层（DataElement 方案的主要痛点）。
- 本文档回答一个问题：**换到 DSH 官方 Desktop 上，哪些直接删、哪些要二开、先验证什么。**

## 一、DSH 原生覆盖 → 删除自有实现

| Hemi 现有自研层 | DSH 对应包（证据：npm 包清单） | 处置 |
| --- | --- | --- |
| conversation-flow SDK、flow-replica、generation 协同（编辑重发／回卷 bug 所在层） | `dsh-session`、`dsh-session-persistence`(+`-jsonl`)、`dsh-session-projection`(+`-cache`)、`dsh-session-query`(+`-sqlite`)、`dsh-session-checkpoint-policy` | 整层删除，语义按 DSH 会话体系对齐 |
| 回合循环、工具执行框架 | `dsh-agent-loop`、`dsh-agent`、`dsh-tools`、`dsh-tool-call-timeout-policy`、`dsh-timeout` | 删除 |
| 后台命令与受管任务（job_list/output/kill、插队清理） | `dsh-jobs`、`dsh-jobs-local`、`dsh-tool-jobs`、`dsh-client-ui-jobs` | 删除；统一作业查询/输出/停止由原生承担 |
| 子 agent 派发与结算（explorer/oracle/fixer/designer 的宿主侧管理） | `dsh-subagent`(+`-fork-in-process`/`-spawn-in-process`)、`dsh-tool-subagent`(+`-control`)、`dsh-client-ui-subagent` | 宿主侧删除；角色定义转为 agent preset 配置 |
| 上下文压缩与裁剪 | `dsh-compaction`、`-basic`、`-tool-result-pruner` | 删除 |
| Bot 目标续跑（goal continuation / 完成校验） | `dsh-goal`、`dsh-goal-round-driver`、`dsh-command-goal`、`dsh-tool-goal`、`dsh-client-ui-goal` | 自研调度删除；Hemi 的完成校验规则移植到 DSH Goal 语义（见风险 4） |
| 工作流执行 | `dsh-workflow`、`dsh-tool-workflow`、`dsh-workflow-ptc`、`dsh-client-ui-workflow-run` | 删除执行引擎；准备卡语义需映射（P1-8） |
| 定时触发 | `dsh-schedule`、`dsh-client-ui-schedule` | Hemi 本就未做，属新增能力 |
| 交付物（register_delivery） | `dsh-client-ui-deliverables`、`dsh-attachment`(+`-local`) | 语义映射到 DSH deliverables，删自研登记层 |
| 权限、审批、沙箱、危险命令门控 | `dsh-user-approval`、`dsh-permission-presets`、`dsh-sandbox`(+`-local`/`-policy`/`-windows-acl`)、`dsh-bash-sandbox`、`dsh-client-ui-approval`、`-permission-presets` | 删除自研 gate；按应用授权的桌面交互授权并入二开 P0-3 |
| 文件与编辑工具 | `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-str-replace-editor` | 删除自研实现 |
| 网页抓取与搜索 | `dsh-tool-web`、`dsh-web-fetch-http`、`dsh-web-search-deepseek` | 抓取/搜索用原生；**任务浏览器自动化不在其中**（见 P0-2） |
| 技能（skills） | `dsh-skill`、`dsh-skill-filesystem`/`-office`/`-badge`、`dsh-tool-skill` | 沿用原生技能机制，Hemi 精选技能转为技能包 |
| MCP | `dsh-mcp-client`、`dsh-mcp-resources` | 沿用原生 |
| 模型接入与凭据 | `dsh-llm`(+`-retry`)、`dsh-llm-pi-ai`（pi-ai 多供应商）、`dsh-llm-deepseek`、`dsh-credentials`(+`-local`)、`dsh-client-ui-settings-models` | 删除自研接入层；现有 VVCode／GLM／Anthropic 兼容端点按 pi-ai 通道迁移（P1-7） |
| 打包、签名、更新、安装器、故障恢复 | 官方 `apps/desktop` packaging（双平台 Actions、更新、诊断恢复、快捷键、i18n） | 现有发布链路作废，改为跟随官方构建与打包流程 |
| 中文界面 | `dsh-client-locale`、官方 desktop i18n 门禁 | 沿用原生 |

收益盘点（粗估，待原型量化）：`packages/conversation-flow` 全家、`src/main/agent` 的 gate 与命令生命周期账本、`src/main/agent-runtime` 的调度/恢复/交接、`src/main/bot` 的目标调度、自研模型恢复器与发布工程大部分可删除；agent-task-lifecycle proposal 中的 P-01～P-07 探针全部不再需要。保留并平移的主要是工具实现层（浏览器、桌面自动化、语音、SSH）与产品化层（皮肤、记忆、迁移）。

## 二、需要二开的功能（Hemi 差异化）

### P0：核心差异化，首阶段必做

1. **语音输入与语音优先交互**。STT 服务配置、语音屏幕、通话条、按住说话；DSH 包面无任何语音组件。落地形态：客户端插件 + 官方 desktop 原生宿主能力；现有语音管线可平移，UI 注入走 client 插槽。工作量：大。
2. **浏览器任务后端**。Chrome 扩展、任务窗口/标签分组生命周期、`browser_*` 工具集（navigate/click/type/act/screenshot/extract）。DSH `tool-web` 仅覆盖 fetch/search，不含自动化。落地形态：DSH 工具插件 + 现有扩展平移（0.3.7 的解组收尾逻辑直接复用）；需把扩展会话与 DSH 会话/作业生命周期绑定。工作量：大（实现平移为主，协议适配为新写）。
3. **桌面 UI 自动化**。`ui_list/ui_tree/ui_click/ui_act/ui_type/ui_scroll/screen_view/app_open` 与按应用授权、危险操作门控。DSH 无对应。落地形态：DSH 工具插件，macOS Accessibility 与 Windows UIA 实现平移。工作量：大。
4. **品牌与发行身份**。Hemi 名称/图标/签名身份/更新源。官方 desktop 支持 client 品牌 profile（`--profile`、client title 覆盖）。需核对 MIT 与 `THIRD-PARTY-NOTICES` 义务，且不得出现 DeepSeek 商标。工作量：小，但流程要重建。

### P1：重要，第二阶段

5. **SSH 远程主机工作区**。`ssh-target` 解析、ControlMaster、远端产物下载。DSH workspace/fs 仅 local/sandbox。落地形态：workspace/fs 后端插件（或先用 MCP 工具过渡）。工作量：中。
6. **Bot 部署形态**。自有服务器 Host、队列输入、断连续跑、审批暂停。DSH `headless`、`sdk-jsonrpc-server`、`webhook`(+github)、`schedule` 可组合承载；Hemi 的队列语义与"审批暂停后继续"移植到该组合。工作量：中到大。
7. **模型路由与用量审查**。主/研究/评审/执行/设计角色槽位、目录级模型偏好、按角色的请求/token/缓存统计视图。DSH 有 model-selection 与 preset，粒度差异需补客户端插件。工作量：中。
8. **跨会话记忆**。MEMORY.md、daily、scratchpad 及检索。DSH 无对应包；做成工具插件 + 每实例独立存储（不跨主机同步的现有约定保留）。工作量：中。
9. **工作流准备卡**。现有 `workflow_preparation` 的"用户补值→用户点启动"语义映射到 DSH workflow 体系。工作量：中。
10. **Hemi 皮肤与人物主题**。DSH theme 插槽承载，皮肤素材沿用（`design/appearance-skins` 母版保留）。工作量：小到中。

### P2：延后或按需取舍

11. 数据备份（webdav 等）、会话审计工具、视频等周边能力。
12. **数据迁移**（一次性）：凭据与模型配置迁移到 DSH credentials；工作区映射；旧会话建议归档只读保留，不做格式转换。

## 三、主要风险与未决问题

1. **developer preview**：官方明示"会有破坏性变更"，rc 节奏快（DataElement 锁 rc.3 时官方已到 rc.5）。二开插件需跟版升级——升级成本与现在跟 Pi 同类，但调度层缺陷不再自己修。
2. **UI 插槽稳定性**：官方 Desktop 的界面就是 DSH Web 应用；Hemi 的交互差异（语音优先、活动状态、等待展示）靠 client 插槽注入。DataElement 证明可行，也证明 UI 层改动最贵（settings-models 补丁 +561/-141 且对着编译产物改）。语音通话条等深度交互注入的可行性需原型验证。
3. **未运行验证**：本文全部基于包清单与文档；"原生覆盖"行为、工具插件协议、扩展与 DSH 作业生命周期的绑定均未实测。
4. **语义对齐成本**：Hemi 的目标完成校验、输入队列、审批暂停、后台等待交接在 DSH Goal/commands/jobs 体系中的对应行为未逐条核对，可能有语义降级或需补插件。
5. **许可与商标**：DSH MIT + 上游第三方声明保留义务；DeepSeek 商标与官方品牌不得混用；发行需自有签名身份。
6. **数据迁移**：旧 Hemi 会话格式与 DSH session-persistence 不兼容，建议放弃历史会话迁移（见 P2-12）。

## 四、验证原型（go/no-go 门槛建议）

Milestone 0（量级按实际评估，验收标准先行）：

1. 以 vendor／fork 方式引入官方 monorepo，跑通官方 desktop 开发与本地打包，切换为 Hemi 品牌 profile。
2. 平移浏览器工具最小集（navigate/extract + 现有扩展），在真实 DSH 会话内完成一次网页任务，含取消与标签分组收尾。
3. 平移桌面自动化最小集（`ui_list`/`screen_view`/`ui_click`）与按应用授权。
4. 语音输入最小版（STT → 注入输入框 → 发起回合）。
5. 走一条完整流程：语音发起 → 浏览器/桌面任务 → 中途取消与重试 → 重启恢复 → deliverables 交付。

验收产物：自有代码删除量 vs 新写胶水量对比、UI 插槽冲突清单、跟随一次 rc 升级的补丁成本记录。任何一项严重超标（如语音 UI 无法注入、扩展生命周期无法绑定）即回到方案评审，不硬推。

## 与现有需求文档的关系

- `agent-task-lifecycle(-proposal).md`：自研调度方案，若本方向获批则整体作废，其历史保证表可作为 DSH 行为核对清单复用。
- `native-pi-memory.md`：记忆目标不变，实现从 pi-memory 转为 DSH 插件形态。
- `cloud-bot.md`、`appearance-and-skins.md`：产品需求保留，落地形态按本文 P1-6/P1-10 更新。
