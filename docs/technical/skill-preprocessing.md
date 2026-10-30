# Hemi Skill 前置处理

Hemi 负责技能发现、元数据解析、可用性判定、冲突选择和诊断。Pi 只消费 Hemi 生成的有效 Skill 定义；技能正文继续按需通过文件工具读取。

## 公共规则

- `skill-definition.mjs` 是安装、项目发现与会话装配共用的元数据校验入口。使用 YAML 解析库读取 frontmatter，统一校验 name、description、title 和 disable-model-invocation，不另写宽松字段提取器。
- `skill-catalog.mjs` 合并受控技能库快照与本机项目技能。单个文件失效只排除该项，保留诊断和其他有效项；技能库与项目同名时仍沿用技能库优先。
- 项目技能的名称来自已校验的 frontmatter，选择身份沿用项目目录 ID。候选和实际 Skill 定义使用相同名称与完整描述。
- 普通回合可以带着部分技能不可用的诊断继续。显式选择失效技能或工作流依赖失效时，在调用模型前返回该文件和原因，不换用其他同名技能。
- `createHemiSession` 在 Hemi 边界处理技能，通过 `skillsOverride` 交给 Pi；不传 `additionalSkillPaths`，关闭默认 Skill 发现。
- 技能内容修订进入主会话的驻留键；同一路径的元数据或正文变更会重建运行会话，保留既有会话历史。
- 桌面和 Bot 的候选源返回同一格式的失效摘要；共享 slash 面板在有效技能旁展示警告。源文件和用户会话数据不自动改写。

## 验证

开发基线：`02651574` 加本轮工作区改动；macOS arm64，Node 22.22.3。具体命令、结果和版本见 `.visual/workflow/skill-preprocessing/report.json` 及验证记录。

2026-10-30 验证结果：

- 共享目录、技能库、选择校验、工作流引用、真实 HemiSession/Pi 与 Bot Host 的针对性测试通过。
- `npm run build`、`node scripts/check-spacing.mjs`、`git diff --check` 通过。
- `node scripts/build-skill-market.mjs` 通过，已有官方包与目录没有内容变化。
- `node scripts/verify-skill-preprocessing.mjs` 在 dev/built 两种入口均通过；覆盖部分失败提示折叠/展开、有效候选、原会话/新会话完成和修复后恢复候选。Electron 44.0.0 的内嵌 Node 为 24.18.1，宿主构建/测试 Node 为 22.22.3。dev 控制台出现 ResizeObserver 通知循环提示，未出现 pageerror 或阻断本场景。
- `npm test`：2213 通过、21 跳过、1 失败。失败用例为 `取消后台目标后清理进程与待通知结果，不唤醒或污染下一轮`，错误为 `cleanup-unconfirmed`。同一工作区单独复跑 `node --test --test-name-pattern='取消后台目标后清理进程与待通知结果' src/main/agent/hemi-session.test.mjs` 通过；保留全量失败记录，不宣称全量通过。

重点场景：不合法 YAML 与有效技能并存、原会话和新会话继续、已安装技能损坏后保留其他项、显式失效引用拒绝、文件修复后的候选恢复、同路径内容变更后的 SDK 请求更新、BOM/CRLF 和仅手动调用策略。

应用验收脚本 `node scripts/verify-skill-preprocessing.mjs` 使用独立临时 `HEMI_USER_DATA_DIR` 和本机 HTTP 模型，覆盖 Vite 开发渲染器与构建渲染器的真实 preload/IPC、Hemi 目录、Pi SDK 请求。Bot 集成测试使用实际 Host/SDK 和本机 HTTP 模型。未更新安装版应用、生产 Bot 或物理设备。
