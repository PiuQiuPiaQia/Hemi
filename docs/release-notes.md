完善文件预览，并修复退出保护、GLM 编程套餐续签与思考强度映射。

- 对话交付物、任务产物与附件统一扩展文档、音频等预览：PDF、Word、Excel、PowerPoint 可查看原文并提取文字；CSV/TSV 支持表格与原文切换，HTML 在受限沙箱中预览并可查看源码，更多配置与代码文件按纯文本显示。
- 重启后可从当前会话归档恢复附件来源；原文件移动或删除时明确提示来源不可用。任务远程产物仍需先下载再预览。
- 应用退出期间拒绝新的输入和会话执行，避免取消后又接受任务；保留未发送的草稿，重新启动后由用户明确发送，不自动重放。
- GLM 编程套餐跟进 ZCode 3.17.1 请求头，按令牌真实有效期安排提前续签，避免短有效期令牌在每次请求时反复续签或被误判为有效期不足。
- 思考强度“高”交由 Pi SDK 请求模型支持的最高档：DeepSeek Flash/Pro 可发送 max，不支持该档位的型号由 SDK 按实际能力夹取。界面与存储仍保持低／中／高三档，低、中、自动与关闭语义不变；不增加型号猜测或兜底映射，不调整 token 上限。

注意：macOS 继续使用固定自签名身份，不等于 Apple Developer ID 签名或苹果公证，首次打开仍可能出现 Gatekeeper 提示。

---

Expanded file previews and fixes for shutdown admission, GLM Coding Plan token renewal, and thinking-level mapping.

- Conversation deliverables, task artifacts, and attachments gain document and audio previews. PDF, Word, Excel, and PowerPoint support original-document viewing and text extraction; CSV/TSV offer table and raw-text views; HTML uses a restricted sandbox with a source toggle. More configuration and code formats display as plain text.
- Attachments can recover their source from the current conversation archive after restart. Moved or deleted originals show a source-unavailable message. Remote task artifacts still need to be downloaded before previewing.
- New input and conversation execution are rejected while the app is quitting, preventing cancelled work from being replaced by a newly accepted task. Unsent drafts are preserved and require an explicit send after restart; no automatic replay.
- GLM Coding Plan follows ZCode 3.17.1 request headers and schedules renewal from the token's actual lifetime, avoiding repeated renewal on every request or incorrectly rejecting short-lived tokens.
- High thinking requests the model's highest supported tier through Pi SDK: DeepSeek Flash/Pro can send max, while the SDK clamps other models to their supported capabilities. The UI and stored settings remain low/medium/high, with low, medium, automatic, and off semantics unchanged. No guessed model capability maps or token-limit changes are introduced.

Note: macOS continues to use a pinned self-signed identity, not Apple Developer ID signing or Apple notarization. Gatekeeper warnings may still appear on first launch.
