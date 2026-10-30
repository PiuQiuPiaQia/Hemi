# 正文用途协议与过程折叠

正文的 `phase` 是展示语义，不触发目标完成、工具授权、后台清理或队列派发。主会话、Bot、后台续跑和子任务使用同一套事件转换。

| phase | 含义 | 正常完成后的展示 |
| --- | --- | --- |
| `commentary` | 进度、新发现、等待原因 | 与相邻思考和工具合组，可展开 Markdown |
| `partial_answer` | 已交付的中间答案 | 保留正文位置和 Markdown，后面仍可调用工具 |
| `final_answer` | 本次模型回复的最终正文 | 保留正文；宿主生命周期仍可检查或继续工作 |
| `unclassified` | 未提供有效阶段的新正文 | 即时保留可见，不触发纠正请求 |
| 缺省或无法确认 | 旧档、协议异常 | 保留可见，不按前后工具位置推断 |

已标记为答案的文字不会降为 commentary，final_answer 不降为 partial_answer。分组保持原始顺序；答案、子任务、文件交付和工作流卡都划开过程组。失败、停止或只有进度没有答案时，进度文字保持可见。原先根据“这段后面是否还有动作”折叠正文的推断已移除。

## 输出约束与归一化

共享 `createHemiSession` 在有实际工具的 run 会话注册无副作用的 `report_progress({text})`，同时把消息用途约定写入真实系统提示词。主 Agent、角色、Bot 使用相同约定。无工具的辅助推理和 verify 会话不增加消息工具。角色的文件、命令和桌面能力仍由原白名单约束。

进度工具通过参数 schema、可用时的约束采样和执行时校验限制非空文字及 2000 字符上限。只有工具实际成功并返回进度内容，宿主才投影为 commentary；原生工具调用及结果仍留在 Pi 记录中，界面不重复显示一次“报告进度”操作。参数错误交回 SDK 的正常工具反馈路径，不新增自动纠正请求或另一套重试，不重放已有工具。

未携带有效阶段的正文从首个流事件起直接标为 unclassified，保持可见，不等待结束、不阻塞输出，也不反馈模型进行分类纠正。消息 stopReason 不用于推断 partial_answer 或 final_answer。之后收到可信原生阶段时可以更新原段；已有明确阶段不会被 unclassified 覆盖。模型是否把实质答案错误地写入 report_progress，无法靠 schema 判断，仍需要真实模型行为验证。

OpenAI Responses 的原生阶段从 Pi 的版本化 `textSignature` 读取，绝不解析正文中的标签或 JSON。阶段可能直到 `text_end` 才可用：宿主用每个 SDK 内容块的独立 `textId` 更新原段，不用“最后一段正文”作为目标。原始 Pi 消息和签名不改写。Pi 1.3 原生回传 commentary/final_answer；针对 provider 已签发的 partial_answer，现有请求钩子只在原始消息 ID 与正文完全匹配、输出项缺少阶段时补回该阶段，不把 Hemi 兼容阶段写入 provider 历史。

## 保存与恢复

`phase`、`phaseSource`、`textId` 从宿主事件进入 flow part；桌面 IPC、Bot、后台和任务档案共用转换。阶段更新沿既有 partId 更新；流式增量不会跨文本块合并。归约、turns 字段清洗、旧档引导和共享 SDK 投影保留合法阶段，未知阶段不取得折叠资格。

旧数据无需改写或回放模型。没有阶段的旧正文恢复为可见内容。这是保守兼容策略，可能使旧会话显示更多过程文字。

## 验证

基线：`dbd236549bf09d0276f56d9906023aba2462a5a7` 加本次未提交改动；macOS arm64、Node v22.22.3。

- `npm test`：全量单元与集成测试；包含真实 Pi + 本机 Responses SSE 的迟到阶段与恢复回传，以及兼容工具路径。
- 初版全量结果：2230 通过、23 跳过。随后补充了请求恢复时清理旧阶段目标的检查，运行 `node --test src/shared/message-phase.test.mjs src/main/agent/hemi-session.test.mjs src/main/agent/message-phase.integration.test.mjs src/main/bot/message-phase.integration.test.mjs src/main/agent-runtime/background-handoff.test.mjs`，46 项全部通过。
- `node --test src/main/bot/message-phase.integration.test.mjs`：真实 Bot host 的进度、答案后登记、最终确认和重启回读。
- `npm run build`、`npm run build:mobile`、`node scripts/check-spacing.mjs`：通过。
- `VITE_DEV_SERVER_URL=http://127.0.0.1:5198 node scripts/verify-message-phases.mjs` 和 `node scripts/verify-message-phases.mjs`：隔离 Electron → 实际 IPC/controller/Pi → 本机可控 provider → 磁盘记录 → 共享 UI。检查运行中展示、完成折叠、Markdown、1440/768/375 布局、渲染器重载、应用重启不重跑、停止后保留内容。

UI 证据位于 `.visual/workflow/vision/message-phases/{dev,built}/report.json` 与截图。脚本创建并清理独立 `HEMI_USER_DATA_DIR`。开发性能浮窗在必要时通过拖动移开，以便实际点击停止按钮，不修改产品行为。

2026-10-31 按用户要求改为直接兜底 unclassified，省去分类纠正请求。此次运行消息阶段、实际 SDK、Bot、档案清洗、flow 投影和展示分组的相关测试，共 98 项通过；桌面/移动端构建与间距检查通过。开发与构建渲染器重新验收通过，并新增实际请求数断言：兼容提供方仍只有原来的三次主推理，没有分类修复请求。本次小范围调整未重复全量测试。

全量验证暴露一个已有 TPS 用例的时序问题：合成 provider 在同一毫秒发出首个正文和结束事件，合法的零生成窗口会得到空 TPS。测试现在等待消费者实际收到首个正文，再发送结束事件，构造可测窗口；生产计时逻辑未修改。

尚未验证：真实远端模型对消息用途约定的系统性遵守率、物理 iOS/Android、Windows 实机、生产 Bot 部署。窄屏 Electron 检查不等于原生手机验收。上述隔离验收不包含应用安装或生产部署。
