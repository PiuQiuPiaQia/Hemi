# 基于 DSH fork 的 Hemi 二代适配计划（v2，按 fork 源码校准）

状态：草案 v2，待评审，未批准实施。
日期：2026-11-04。基线：`hemi-dsh` fork 仓库（deepseek-ai/deepseek-harness master，HEAD 8bd073392e，v0.2.2-alpha.3，394 个 workspace 包）。已跑通 install/build/start:desktop。
证据：本轮两名只读侦察对 fork 源码的核实（包结构、扩展机制、能力覆盖），路径均相对仓库根。v1（基于 npm rc.5 包清单 + DataElement 审计、"嵌入"前提）已被本版取代；上游能力比 v1 认知大幅扩张。

## 一、上游能力地图（按 fork 源码核实，非 npm 清单推断）

| 能力 | 上游状态 | 证据路径 | 对 Hemi 的意义 |
| --- | --- | --- | --- |
| 会话/回合/工具循环/压缩/作业/目标/工作流/定时/交付物 | 原生（同 v1 认知） | packages/session、core、jobs、goal、schedule、deliverables 等；client 侧 ui-workflow-run/ui-schedule/ui-goal/ui-jobs/ui-deliverables/ui-plan/ui-agent-team 齐全 | 自研调度层全删（v1 结论不变） |
| **语音输入** | 有，实验性：STT 服务定义 + 本地 SenseVoice + API STT + 浏览器麦克风 UI + bundle（默认禁用）；产物=插入草稿的文本，**无语音输出/TTS 通道** | packages/experimental/{speech-to-text, speech-to-text-sensevoice, api-speech-to-text, client-ui-voice-input, voice-input-bundle} | P0 从"自研"变"启用+增强"；语音对话（TTS/通话条）仍是缺口 |
| **浏览器自动化** | 有：browser-use 独占提供方槽 + 三个实验提供方（playwright-mcp、chrome-devtools-mcp、stagehand-native）+ runtime；chrome-devtools 提供方可接入已有浏览器及其登录态 | packages/browser-use、packages/experimental/browser-use-*、packages/web/tool-web | Hemi 浏览器任务后端首选"评估上游提供方"，扩展方案降级为备选 |
| **桌面 UI 自动化** | 有槽位；原生 CUA 仅 macOS（AX 树+截图+键鼠+授权引导，Swift 辅助进程）；另有 cua-driver-mcp/native 适配；**无 Windows 原生提供方** | packages/computer-use、experimental/{cua, cua-macos, cua-bundle, computer-use-cua-driver-*} | macOS 用上游；**Windows UIA 提供方是真二开** |
| **SSH 远端** | 完整家族：共享 OpenSSH 连接+远端 POSIX helper、fs-ssh（ctx.fs）、subprocess-ssh（ctx.subprocess）、sandbox-ssh（ctx.sandbox）、免 Node helper 分发 | packages/ssh/{ssh, fs-ssh, subprocess-ssh, sandbox-ssh, ssh-helper-runtime} | Hemi SSH 远程主机需求大部分被承接，从"自建"变"适配" |
| 跨会话记忆 | **无现成包**；最近的是 experimental/session-search（检索早前会话）与 storage 家族（ctx.storage KV + JSON/SQLite 后端） | packages/experimental/session-search、packages/storage/* | 真二开：基于 ctx.storage 建 Hemi 记忆库 |
| 模型接入 | llm-pi-ai 多供应商适配器仍在：providers 字典（apiKeyEnv/baseURL/api/compat/models）支持自定义网关**免改码**；credentials 家族齐 | packages/llm/llm-pi-ai/README.md | VVCode/GLM/Anthropic 兼容端点直接配置迁移 |
| 子 agent/角色 | subagent 家族 + **agent-team** + preset；另有 subagent-claude-code、subagent-codex 适配器（可当外部子 agent 用） | packages/subagent/*、packages/client/ui-agent-team | Hemi 四角色可用 agent-team/preset 组合表达 |
| agent preset | **只组合插件**（id/plugins/name/description/order），不含 model/instruction/tools 字段；模型走 settings 的 default-model | packages/preset/agent-preset/README.md | **角色级模型路由与用量审查无法用 preset 表达**——真二开点 |

## 二、二开清单（v2 重排）

### P0：第一批（验证 + 补真空）

1. **品牌与发行身份**。机制已核实：运行时品牌=sidebar.brand.* 插槽（ui-brand-official 按 `DSH_CLIENT_BUILD_PROFILE` 门控，换品牌即换该插件行为）；构建身份=`DSH_CLIENT_TITLE`/`DSH_BUILD_CLIENT_PROFILE`（scripts/client-build-environment.ts）；桌面 productName 硬编码于 apps/desktop/electron-builder-config.mjs:120 + `DSH_DESKTOP_APP_ID` + resources 图标。BRAND_GUIDELINES 允许"DSH 前缀"命名、禁全称商标——**Hemi 命名合规需先定**（Hemi 不含 DSH 前缀，需确认是否需要替代许可或调整命名）。
2. **角色级模型路由与用量审查**（上游真空）。preset 不带模型；需做一个小型 host 插件：按 agent-team 角色读写 settings 的 provider/model 路由表 + 会话内按角色的 token/缓存统计视图（client UI 插件）。这是 Hemi"主/研究/评审/执行/设计"体验的核心。
3. **Windows 桌面提供方**（上游真空）。把 Hemi 的 Windows UIA 实现包成 computer-use 提供方（对齐 cua 对象 API：应用/窗口枚举、AX 树、截图、输入、按应用授权）。macOS 直接用 cua-macos。
4. **跨会话记忆**（上游真空）。基于 ctx.storage（JSON/SQLite 后端）+ 参考 session-search，实现 MEMORY/daily/scratchpad 三层与检索工具；每实例独立。
5. **启用并验收实验性能力**：voice-input-bundle（含 SenseVoice 本地）、browser-use 提供方选型（先试 chrome-devtools-mcp，重点验证接入已有浏览器登录态与 Hemi 任务窗口/标签分组生命周期的差距）。未决：这些 experimental 包在桌面 bundle 的默认挂载状态未核实（explorer 遗留问题），启用方式待查证。

### P1：第二批

6. **语音对话增强**（若要超越上游）：TTS/语音输出通道、通话条 UI（client 插件）、STT 服务商配置页。上游只有"语音→草稿文本"。
7. **浏览器提供方对齐**：若 chrome-devtools-mcp 覆盖不足（任务窗口管理、标签分组收尾、跨窗口任务页），把 Hemi 扩展（0.3.7）包成自定义 browser-use 提供方。
8. **SSH 适配**：把 Hemi 的 ssh-target 目录语义、凭据与产物下载映射到 ssh 家族的 profile/credentials；验证 sandbox-ssh 是否覆盖 Hemi 的远端沙箱需求。
9. **Bot 部署形态**：headless + sdk-jsonrpc-server + webhook/schedule 组合（同 v1）；上游 ssh-helper-runtime 的免 Node 分发可直接用。
10. **皮肤主题**：theme 插槽 + design/appearance-skins 素材。
11. **数据迁移**：凭据→credentials；模型配置→llm-pi-ai providers；工作区映射；旧会话归档只读。

### P2：按需
12. 备份/审计等周边；工作流准备卡语义映射（upstream ui-workflow-run 存在，语义差距待用一遍再评）。

## 三、扩展机制速查（已核实，供开发直接引用）

- **新工具包**：Cordis 插件（export name/inject/Config/apply，`ctx.tools.register(defineTool(...))`）；契约在 packages/core/tools/src/{schema.ts defineTool, contracts.ts ToolDefinition}；schema 自动进系统提示。范例 packages/shell/tool-bash/src/index.ts。
- **新 UI 插件**：packages/client/ui-* 双半部（node 半 + ./client 浏览器半），`ctx.slots.register/inject`（槽名 domain.entry.hole）；三处登记：tsconfig.client.json、packages/bundle/web-app/cordis.patch.yml 的 dsh.client row、web-app package.json 依赖。纪律见 packages/client/AGENTS.md。
- **挂包**：pnpm-workspace glob packages/*/* 已覆盖新目录，只需改 tsconfig host/client references；package.json 不变量由 scripts/check-workspace-constraints.ts 强制。Typert 仅 Host→Client RPC 需要。
- **组装**：profile → bundle（package.json dsh.bundle.patch）→ patch YAML；运行时 `dsh plugin --profile desktop add` 可加插件；preset 用 standard.patch.yml 模式组合（persona 前缀等）。
- 建议我们的包统一放 `packages/hemi/*` 命名空间，少碰上游文件（merge 纪律同 v1）。

## 四、风险与未决

1. experimental 成熟度：语音/CUA/浏览器提供方均自标实验性，默认禁用；验收前不能当稳定底座（P0-5 的启用验证是第一批必做）。
2. preset 无模型字段是设计事实而非缺陷——角色路由要顺着 settings/agent-team 做，不能硬塞进 preset。
3. 品牌合规：BRAND_GUIDELINES 的命名约束与 Hemi 商标需求待对齐（P0-1）。
4. 未核实项：experimental 包在桌面默认 bundle 的挂载/启用开关；apps/desktop profile 模板来源文件（两处 explorer 遗留）。
5. 上游节奏：master 比 npm 发布线新，破坏性变更持续；合并纪律见 v1（每 rc 跟一次、改动记账）。

## 五、里程碑门槛建议（更新）

已完成：fork 可跑（install/build/start:desktop 全通）。
- **M1（品牌+实验能力验收）**：品牌 profile 切换为 Hemi 身份跑通；voice-input-bundle 启用并完成一次语音输入；browser-use chrome-devtools 提供方完成一次真实网页任务（含取消）；cua-macos 完成一次窗口操作。产出：各能力差距清单（决定 P1-6/7 做不做）。
- **M2（真空补齐）**：角色路由插件 + Windows CUA 提供方 + 记忆包各出可演示原型。
- **M3（整合）**：一条完整 Hemi 流程（语音发起→浏览器/桌面任务→取消重试→重启恢复→交付），量化删改行数。

## 与现有需求文档的关系

- `agent-task-lifecycle(-proposal).md`：自研调度方案作废，其历史保证表继续当 DSH 行为核对清单。
- `native-pi-memory.md`：目标不变，实现改挂 ctx.storage。
- `cloud-bot.md`、`appearance-and-skins.md`：需求保留，落地按本文 P1-9/10。
