# Hemi 数据备份与恢复（坚果云 WebDAV）需求

- 状态：已实现（v1；2026-11 追加用户裁决：仅保留轻量备份，完整档移除）
- 日期：2026-10-31
- 背景：应用数据全部落在 `~/Library/Application Support/hemi`（Windows 对应路径），卸载即丢失；现有「导出」仅覆盖单条会话 Markdown/HTML（history.ipc），无全量备份能力。首个云端目标接入坚果云（WebDAV），架构上把「备份目标」做成抽象，本地文件夹与 WebDAV 只是两种目标实现。

## 1 目标与边界

### 1.1 已确认的决定

- 2026-10-31 用户裁决：**独立「备份」设置分类**（不挂「通用」区块）；**做定时备份**；**不做加密**（备份档明文，凭据剔除因此成为唯一防线，升级为硬约束）。
- 2026-11 用户裁决：**仅保留轻量备份**——移除完整档、档位选择与解释轻量/完整区别的说明；「立即备份」只有一个按钮，定时只剩开关/每天每周/保留份数。后端只创建轻量范围（不是仅隐藏 UI）；旧 `schedule.tier=full` 一律归一为 `light`，IPC 不再接受 tier 入参；旧 full 包的恢复兼容保留。
- 2026-11 用户新裁决：**凭据随备份**（推翻早前「永不进备份」）。技术依据：local-secrets 的解密密钥在 `secrets/key-v1`，整目录随包，恢复到新机即可解密（上游错误文案本身预期「从备份恢复应用数据」）。备份不加密，云端目标保存的是明文等价物——UI 须提示「妥善保管网盘账号」。
- 备份产物是**单次快照归档**（manifest＋分卷文件），不做数据目录的实时同步。
- 首个云端目标：坚果云 WebDAV（服务器 `https://dav.jianguoyun.com/dav/`，账号＋第三方应用密码）；同时支持「本地文件夹」目标，覆盖 iCloud Drive/OneDrive 等同步目录用户。
- ~~**凭据一律不进备份（硬约束）**~~（已被上条 2026-11 裁决取代）：`secrets/`、`provider-logins/`、`remote-passwords.json`、`runtime-v2/oauth-credentials.json`、`doubao-asr.json` 现均随轻量档备份并可在新机解密。
- 备份时机选**会话空闲**（无进行中回合）做文件级快照；runtime-v2 全部为文件存储（非 SQLite），无需停写。

### 1.2 本期范围

macOS 与 Windows 桌面端（Hemi 主应用）的备份/恢复：手动备份、定时备份、云端配置（WebDAV/本地文件夹）、应用内恢复、首启恢复引导。

### 1.3 非目标（本期不做）

- S3 兼容目标、增量/去重（chunk 级）、官方账号同步服务、移动端。
- 备份内容加密包含凭据（若未来支持，需口令加密整包）。
- 跨设备**同步**语义（备份是快照，不做冲突合并/双向同步）。

## 2 备份范围

| 数据 | 是否备份 | 说明 |
|---|---|---|
| runtime-v2/conversations、conversation-operations、task-history、run-journal.json | ✅ 备份 | 会话正文与任务历史，~50M |
| runtime-v2/workflows、skills、provider-import | ✅ 备份 | 工作流定义、技能安装与账号导入记录（2026-11 用户指出补充） |
| pi-memory、drafts、bot、各设置 JSON（appearance/onboarding/access-grants 等）、text-model-profiles、migration | ✅ 备份 | 记忆/草稿/设置，~2M，价值密度最高 |
| runtime-v2/sessions、contexts、attachments | ❌ 不备份 | 上下文与工具产物，~1.3G；原完整档目录，2026-11 裁决随完整档一并移除 |
| secrets、provider-logins、remote-passwords.json、oauth-credentials.json、doubao-asr.json（encryptedApiKey） | ❌ 永不 | 设备绑定凭据，见 1.1；不加密档中的唯一防线 |
| Cache、Code Cache、GPUCache、blob_storage、Partitions、Singleton*、Trust Tokens、*.log、*.tmp、agent-environment（仅 cache）、bot/cache.json | ❌ | 缓存与可重建运行时文件 |

仅轻量档（2026-11 裁决）：免费版坚果云上传流量仅 1G/月，轻量档（几十 M）可高频备份；完整档撞流量墙与单文件 500M 上限，且用户认为档位选择属于冗余复杂度，已整体移除。历史 full 备份包仍可列出与恢复（恢复按 manifest 内容解包，与档位无关）。

## 3 归档格式

- 目录式布局（云端正是一个带时间戳的「备份集」）：
  - `hemi-backups/20261031-1011/manifest.json` —— schemaVersion、appVersion、创建时间、档位（恒为 `light`；读取侧兼容历史 `full` 值）、分卷清单（文件名＋大小＋sha256）、条目统计（会话数、记忆文件数）、是否加密、加密参数（salt/nonce）
  - `hemi-backups/20261031-1011/part-0001.gz…` —— 内容分卷，gzip 流式压缩（Node 22/24 均稳定的 zlib 流 API；zstd 流在 22.x 不可用，暂不用）；分卷在压缩流之上切（每卷独立 sha256、独立可重传）
- manifest 独立成小文件：恢复时先读 manifest 校验完整性再决定下载哪些卷。
- **不加密**（用户裁决）：云端保存明文归档，UI 需明示这一点；凭据永不进包是唯一防线。

## 4 功能需求

### R-01 备份范围与排除
按 §2 清单打包；排除规则内置不可配置（凭据、缓存），未来新增数据目录默认并入轻量范围并在 manifest 记录。

### R-02 仅轻量档（2026-11 裁决，取代原「轻量/完整双档」）
备份只有轻量范围一档：UI 无档位选择、无完整档按钮、无档位说明；「立即备份」仅一个按钮，定时仅开关/每天每周/保留份数。服务端只创建轻量范围（`collectEntries` 不再接受 tier），旧调用传 `tier=full` 一律按轻量打包并在 manifest 如实记 `light`；设置中的 `schedule.tier` 仅作兼容字段保留，读取时归一为 `light`。

### R-03 分卷
单卷默认 300M（保守值，WebDAV 单文件 500M 上限留余量），可配置。恢复端按 manifest 顺序下载拼装。

### R-04 备份目标配置
- 本地文件夹：系统对话框选择。
- WebDAV：预设坚果云（地址默认值＋引导文案：官网「账户信息→安全选项→添加应用密码」）；也允许自定义地址（Nextcloud 等自建）。
- 连接信息存储：URL/用户名明文存设置 JSON；**应用密码走 local-secrets**（Keychain/safeStorage）。
- 同一时刻一个激活目标；可保存多个目标配置待切换（v1 可先只留一个）。

### R-05 连接测试
保存前测试：WebDAV 用 PROPFIND 探测根路径＋MKCOL 创建 `hemi-backups/`（已存在则幂等通过）；本地目标测试写删探针文件。失败给出可读原因（401 密码错 / 网络不通 / 目录无权限）。

### R-06 手动备份
设置页「立即备份」：单按钮（无档位选择）→ 快照 → 压缩/加密 → 分卷 → 上传（先传 manifest 后传分卷，或反之但 manifest 最后更新为「完整」状态——采用「分卷先传、manifest 最后传」保证 manifest 存在即备份集完整）。进度条＋结果通知；失败保留本地临时产物供重试免重打包。

### R-07 定时备份
- 频率：每天/每周（v1 不做自定义 cron）；仅轻量档（无档位绑定）。
- 触发时机：到点后等**空闲窗口**（无活跃回合，参照 run-journal/task-history 判定），超时未空闲则顺延；应用未运行则错过（不做补跑，v1）。
- 定时器实现参照 updater 的 scheduleStartupCheck 模式（src/main/services/updater.mjs）。

### R-08 保留策略
云端每个目标保留 N 份（默认 5，按时间戳排序），新备份成功后删除最旧；删除失败不阻塞（下次再清）。本地临时产物用后即删。

### R-09 应用内恢复
- 入口：设置页「备份与恢复」→「从备份恢复」；列出云端/本地备份集（读 manifest），显示时间、档位、大小、app 版本。
- 流程：选择 → 下载校验（逐卷 sha256）→ 解压到暂存目录 → 预览摘要（将恢复 X 个会话、Y 条记忆，附合并预估：新增/相同跳过/冲突）→ 用户确认 → 应用（合并恢复，落选/被替换数据自动存入本地安全副本，防误恢复）→ 重启或热重载生效。
- 合并策略 v2（2026-12，取代 v1 整目录级替换）：逐文件合并——本地没有的移入；字节相同跳过；内容不同保留 mtime 较新一方（秒级精度持平且内容不同取备份版），输者移入安全副本。凭据配套域不合并、按备份整组替换（密文必须与 secrets/ 密钥配对，禁止混搭）：secrets/、provider-logins/、remote-passwords.json、doubao-asr.json，及 runtime-v2/ 下 oauth-credentials.json、text-model-profiles.json；域内本地较新文件如需保留需重填。暂存解包时恢复文件原 mtime，供合并比较。

### R-10 首启恢复引导
onboarding welcome 步骤增加「从备份恢复」入口（次要按钮，不打断新用户主流程）：进入简化恢复向导（配目标 → 列备份集 → 恢复），完成后跳到剩余必要步骤（模型登录等，凭据不随备份走，必须重新配置）。

### R-11 不做加密（已裁决）
不提供口令加密；备份档明文上传。因不加密，凭据类数据**永远**被范围过滤排除（R-01 硬约束），恢复流程不涉及口令。UI 在配置目标时明示「云端保存明文副本」。

### R-12 限制与重试
- WebDAV 限频（免费 600 次/30min）：429/503 指数退避；单卷上传失败重试 3 次。
- 体积防线：打包前预估体积，超出目标剩余流量/空间时警告确认（坚果云流量属账户级，无法查询余额——按本地累计估算本月已上传量并提示）。
- 断点：PUT 无续传，失败整卷重传（分卷小的意义所在）。

### R-13 进度与可观测性
手动/定时备份与恢复均在设置页显示状态；已配置目标时展示上次备份时间/结果/体积（有价值的状态保留），**未配置且无错误/通知时不显示引导状态卡**（2026-11 裁决：目标表单本身就是引导）；失败写 hemi.log；不弹系统通知打扰（v1 用应用内状态即可，决策点 D-4）。

### R-14 版本兼容
manifest.schemaVersion；恢复时 schema 高于当前 app 支持即拒绝并提示升级 app；app 版本仅作展示与告警（大版本回退警告）。

## 5 UI 与挂载点

- 设置页：**独立第八分类「备份」**（2026-10-31 裁决，非「通用」内区块）；Bot 环境下该分类不显示（v1 仅本地端，后续按需开放），参照此前 skills 分类的环境过滤模式。
- 组件参照：settings-screen.tsx 的 section 模式；恢复向导可复用 onboarding 的步骤组件风格。
- IPC/服务：`src/main/services/backup-service.mjs`（快照/打包/校验/调度）＋ `src/main/ipc/backup.ipc.mjs`（registerBackupIpc，模式同 history.ipc）；WebDAV 客户端用 Node 内置 fetch 手写（PROPFIND/MKCOL/PUT/GET/DELETE 足够，无需引入依赖，遵守项目最小依赖倾向）。
- onboarding：onboarding-state.mjs 增加可选 restore 分支，不改变现有 step 版本号语义（restore 是 welcome 的旁路，完成或取消都回到主流程）。

## 6 测试与验收（按 AGENTS.md 按影响选测）

- 单测：范围过滤（凭据/缓存/原完整档目录绝不进包）、分卷与 sha256 往返、manifest schema 兼容判定、保留策略清理、429 退避、仅轻量档归一（旧 `tier=full` 入参与 `schedule.tier=full` 均归一为 light 且落盘即 light）。
- 集成：本地文件夹目标的完整备份→清空 HEMI_USER_DATA_DIR 隔离实例→恢复→数据一致（用隔离用户数据目录，不动开发数据）。
- WebDAV：本地起 WebDAV 测试容器或 mock（真实坚果云联调放最后人工验证，不进 CI）。
- UI：verify 脚本（参照 verify-bot-settings.mjs 模式）覆盖设置区块与恢复向导 fixtures；dev＋built 双渲染层各跑一遍。
- 端到端人工：坚果云免费账号真实上传/下载/限频行为各验证一次。

## 7 分期建议

- M1（先跑通链路）：本地文件夹目标＋轻量档＋手动备份＋应用内恢复＋格式定版。
- M2（本次核心诉求）：坚果云 WebDAV 目标＋连接测试＋定时备份＋保留策略＋首启恢复引导。
- M3（体验增强）：增量备份、S3 目标、恢复预览细化、可选通知。

## 8 决策点（已全部裁决，2026-10-31）

- D-1 完整档默认关：**是**（按建议值；后被 D-6 取代——完整档整体移除）。
- D-2 加密：**不做**（用户裁决）。
- D-3 UI 位置：**独立「备份」设置分类**（用户裁决）。
- D-4 结果通知：**应用内状态**（按建议值）。
- D-5 定时备份：**做**（用户裁决）；配置目标后默认每天（按建议值）。
- D-6 仅轻量档：**是**（2026-11 用户裁决）——移除完整档与档位选择、档位说明、未配置时的冗余状态卡；后端只建轻量范围；旧 full 包恢复兼容保留。

## 参考

- 坚果云限制（2026-10-31 实查）：免费版上传 1G/月、下载 3G/月、空间随上传量；专业版流量不限。WebDAV 单文件 500M、免费版 600 次/30min、付费 1500 次/30min。来源：定价页 https://www.jianguoyun.com/s/pricing 、帮助中心 https://help.jianguoyun.com/?tag=webdav 。
