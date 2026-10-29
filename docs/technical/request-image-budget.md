# 模型请求图片预算

## 原因与现有压缩

主 agent 已启用 Pi SDK 自动上下文压缩：`contextTokens > contextWindow - reserveTokens` 时总结旧历史，Hemi 的 `reserveTokens` 默认 20,000，`keepRecentTokens` 默认 8,000。后者是近似 token 预算，不是请求字节限制，也不是图片数量上限。当前 SDK 估算每张图片约 1,200 tokens；一张 PNG 的 Base64 却可能超过数 MiB，因此图片会在 token 阈值之前触发网关 HTTP 413。

SDK 的摘要生成把历史转换为文字，图片本身不进入摘要请求；保留的近期上下文仍会携带图片。单次 `read` 的 4.5 MiB 图像上限同样不能限制累积的请求大小。`compaction_end` 在成功、失败、取消时都会派发，日志只有存在 `result` 才能报告完成。

## 请求边界规则

`request-images.mjs` 在 `controlledStream` 内、实际 SDK provider 调用前为视觉候选统一投影图片，覆盖主／子 agent，并兼容恢复的旧档案。不修改 SessionManager 条目、原始文件或不可变工具结果。

- 视觉候选的正常请求保留最近 8 张图，每张 Base64 最多 512 KiB，总图像正文至多 4 MiB。超过单图预算时使用现有 SDK 的 worker 解码、压缩编码，必要时缩小尺寸；投影附原图／当前尺寸及坐标换算说明。
- 旧图片替换为明确的未重新看图占位符，文字与调用关系保持原顺序。有不可变快照引用时保留 `context_read` 入口，否则保留相邻原图路径说明。需要再次核对的旧图可重新读取。
- 在还没有生成有效内容时遇到 HTTP 413／媒体过大错误，最多再投影一次：最近 4 张图、每张 Base64 最多 128 KiB。只有字节确实减少才重试同一模型请求，共用逻辑调用身份；不重做工具、不刷新网络恢复窗口。
- 缩减后成功，同一会话对该 API／服务地址后续请求沿用较小预算；换服务不沿用。两次仍失败或原请求无图片时结束，提供易读错误，不显示网关 HTML。
- 历史包含图片时允许切换到文本候选。文本候选跳过 Hemi 图片预算及解码，将原消息交给 Pi SDK 1.3.0 的 `transformMessages`：用户图片替换为 `(image omitted: model does not support images)`，工具图片替换为 `(tool image omitted: model does not support images)`。其他文字及工具调用关系保留，原始历史图片不变。
- 备用候选按冻结计划的任务能力要求筛选，不因历史图片额外排除文本候选。同一服务的视觉／文本候选切换时重新选择请求投影，避免复用视觉候选的图片省略或压缩结果。新附件、明确要求 `imageInput` 的任务和看图工具仍沿用原有能力检查。
- 视觉候选的坏图、压缩失败和取消仍明确失败，不能被报告为已看图；文本候选的占位也不代表已查看、OCR 或生成图片描述。
- 网络重试仍保持投影后的请求前上下文；已有请求／工具预算、执行归属、取消、账本规则继续生效。

预算约束的是图片 Base64，文字、系统提示词与工具 schema 另占空间，因此它不承诺任何供应商都接受请求。特别低的网关上限、大量本轮附件或超长纯文字仍可能失败。保留数量是请求投影策略；全部原图仍在原档案，档案磁盘体积不会因此变小。

## zcode 对照

参考本地 ZCode 提交 `aac4755666d09fdcd70272fcf063c077a639015f`：

- `apps/zcode-cli/packages/core/src/compact/microcompact.ts`：按 token／空闲阈值清理旧工具结果，默认保留最近 5 组，降低持续累积。
- `apps/zcode-cli/packages/core/src/runtime/helpers/compact-media.ts` 与 `runtime/methods/compact-active.ts`：摘要媒体过大后，投影媒体占位符再试一次，历史记录保留。

本次沿用“请求投影与原始历史分离、明确省略、失败后有界缩减”的思路，独立实现 Hemi 的图片字节预算；没有移植 zcode 的完整微压缩／摘要框架，也没有复制其源码。

## 验证

基准 `5ca1f1e32ca0296c019da7453387a9cd22aec46f` 加本轮工作树，未创建提交。macOS 26.5.1 arm64、Node 22.22.3、Pi SDK 1.3.0。会话测试在全新临时目录运行，生产工厂连接本地 HTTP 服务，使用合成图片和密钥。

```sh
node --test --test-reporter=dot src/main/agent-runtime/request-images.test.mjs src/main/agent/request-images.test.mjs src/main/agent-runtime/usage-ledger.test.mjs src/main/agent-runtime/model-recovery.test.mjs src/main/agent/model-recovery.test.mjs src/main/agent-runtime/context-extension.test.mjs src/main/agent/hemi-session.test.mjs src/main/agent/pi-factory.test.mjs src/main/agent/main-agent.test.mjs
git diff --check
```

覆盖旧图片历史减负、真实图片编码、413 同模型一次重试、较小预算复用、已完成工具不重放、原始条目不变、请求逐次记账、纯文字／重复 413 结束、自动摘要实际落档、摘要失败日志、原有网络恢复与会话行为。

上述专项及会话回归命令、语法检查和 `git diff --check` 均通过。最终错误文案修正后又重跑两组新增测试，覆盖媒体 400 不误报为 413。

实际故障档案另做只读离线投影，使用 SDK 还原当前分支，再测正常／缩减预算；私有数据只在本机内存中读取，没有发送至外部模型，前后哈希一致。仅统计证据存于忽略目录 `.visual/request-size/report.json`。

未改 renderer 生命周期或依赖，未运行全套测试、UI／设备回归、外部供应商调用或安装版升级。安装版及既有 Bot 需要部署包含此更改的运行时代码后才生效。

## 2026-10-29：使用 Pi 原生图片降级

验证基准为 `main` 的 `1e1697b84fc2099a1b1165d163c5f4cd5bcbf6c9` 加本次工作树修改，未创建提交。环境为 macOS 26.5.1 arm64、Node 22.22.3、Pi SDK 1.3.0。先用新增会话回归复现了切换文本模型时的 `unsupported-modality`，再移除请求边界拦截及按历史图片排除文本备用的限制。未修改 Pi SDK，也未新增图片降级实现。

验证使用新建的临时 `HEMI_USER_DATA_DIR`、生产会话工厂、已安装 Pi SDK 与本地 HTTP 流式服务；模型响应和图片均为合成夹具，无外部模型调用。

```sh
HEMI_USER_DATA_DIR="$(mktemp -d /tmp/hemi-pi-image-downgrade.XXXXXX)" node --test --test-reporter=spec src/main/agent-runtime/usage-ledger.test.mjs src/main/agent-runtime/request-images.test.mjs src/main/agent-runtime/model-policy.test.mjs src/main/agent-runtime/model-recovery.test.mjs src/main/agent-runtime/context-extension.test.mjs src/main/agent/request-images.test.mjs src/main/agent/model-recovery.test.mjs src/main/agent/hemi-session.test.mjs src/main/agent/pi-factory.test.mjs
node --check src/main/agent-runtime/usage-ledger.mjs
node --check src/main/agent-runtime/usage-ledger.test.mjs
node --check src/main/agent/request-images.test.mjs
git diff --check -- src/main/agent-runtime/usage-ledger.mjs src/main/agent-runtime/usage-ledger.test.mjs src/main/agent/request-images.test.mjs docs/technical/request-image-budget.md
```

53 项相关检查通过。覆盖视觉→文本→视觉的历史续聊、9 张历史用户图片和工具图片使用 Pi 原生占位、文字及工具调用关系保留、原始图片条目不变、文本候选跳过大图解码、同服务视觉→文本备用切换及请求记账、纯文本请求的 413 不触发无效图片重试，以及既有视觉图片预算／自动摘要／取消和恢复。语法检查及限定文件的 `git diff --check` 退出码均为 0；Git 同时输出仓库现有 AppleDouble `._pack-*.idx` 警告，未修改这些文件。

本次只修改共享运行时与相关测试／文档，未改 UI 生命周期或依赖，未运行全量测试或 Electron／设备回归，未更新安装版或生产 Bot。
