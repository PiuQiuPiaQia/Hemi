修复对话完成后完整答案被折叠、只剩简短确认的问题。本版为 macOS Apple Silicon 修复版本。

- 对话流按消息用途折叠：只有明确的进度说明归入过程记录；中间成果、最终答案和未标记正文始终保持可见，后续工具调用不会隐藏已交付的内容。
- 保留模型提供的原生消息阶段，并为其他模型提供统一的进度通道；缺少阶段时立即保留正文，不增加分类纠正请求。
- 展开的进度说明支持 Markdown；消息阶段在保存、重载和重启后保持一致，旧会话无需迁移。

---

Fixes complete answers being folded away after a conversation finishes, leaving only a short acknowledgement visible. This patch release is for macOS Apple Silicon.

- Conversation folding now follows message purpose. Only explicit progress messages join the activity record; intermediate results, final answers, and unmarked text remain visible even when more tools run afterward.
- Preserves native model phases and provides a shared progress channel for other models. Missing phases fall back immediately without extra classification requests.
- Expanded progress supports Markdown. Message phases survive saving, reloading, and restarting; existing conversations require no migration.
