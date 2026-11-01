优化任务输出和长会话性能，并完善 macOS 固定签名与发布流程。

- 将运行记录改为后台增量写入，批量保存模型用量，减少任务持续输出和多任务运行时的主进程阻塞。
- 长会话按需加载历史 QA；回到最新消息后释放已回载的旧内容，切换会话时回收展示缓存和闲置控制器。历史记录完整保留，可以继续向上翻阅。
- 减少旧消息重复转换，合并虚拟列表测量；复制完整回答时按需读取全文，避免分页后只复制当前片段，并保留草稿、编辑与文本选择保护。
- 兼容旧运行记录的自动导入和备份恢复，保留存储失败后的输出与暂停状态，恢复保存时不自动重放已完成操作或排队输入。

- macOS 打包复用同一份固定自签名证书，增加跨构建身份与包体签名校验；签名身份缺失或不匹配时停止打包，不静默降级为临时签名。
- 调整原生代码签名和 exFAT 打包处理，避免给图片、字体等资源写入多余的签名属性；必要时在系统临时目录签名，再清理伴生文件并验证包体。
- 修复 macOS CI 配置证书信任时等待交互授权的问题：在临时 runner 上使用无交互管理员信任域，并在构建结束后清理，不改变固定签名身份。
- 签名清理增加逐步日志、命令硬超时与工作流超时，单步失败仍继续清理并阻止发布；针对 macOS CI 的信任删除挂起，改用明确拒绝代码签名信任并验证撤销结果，再清理临时身份。修复 Windows 测试的 CRLF 换行兼容性。
- 修复子任务“已返回／已交接”状态箭头意外放大的样式问题，恢复与其他状态一致的 12px 图标，保留状态文案和执行过程入口。
- 改进 POSIX 后台命令的进程退出确认：优先使用内核进程组探针，减少高负载下外部进程探针超时引发的误判；无法确认清理时仍阻止后续执行。
- 保持现有 macOS 更新下载、SHA-512 校验和退出换包流程。Windows 继续使用原有 NSIS 安装与更新流程。
- 中英文 README 改为原地播放视频，移除额外视频下载入口及重复链接；官网已发布到 https://piuqiupiaqia.github.io/Hemi/ ，视频由 OSS 提供。

注意：固定自签名不等于 Apple Developer ID 签名或苹果公证，首次打开仍可能出现 Gatekeeper 提示。从旧版临时签名迁移后，录屏、辅助功能或麦克风权限可能需要重新授予；真实权限延续仍需在具体设备上验证。

---

Smoother task output and long conversations, plus improvements to stable macOS signing and release handling.

- Moved runtime-record writes to incremental background storage and batched model-usage saves, reducing main-process blocking during continuous output and concurrent tasks.
- Long conversations load earlier Q&A on demand. Returning to the latest messages releases backfilled presentation data, and switching conversations releases view caches and idle controllers. Saved history remains available when scrolling back.
- Reduced repeated conversion of older messages and batched virtual-list measurements. Copying a complete answer retrieves its full text on demand, avoiding truncation by the visible window while preserving drafts, editing, and text selections.
- Retained automatic import of legacy runtime records and portable backup/restore support. Storage failures preserve output and paused state; saving after recovery does not automatically replay completed operations or queued input.

- macOS packages reuse one pinned self-signed certificate, with cross-build identity and packaged-signature checks. Missing or mismatched signing identities stop packaging rather than silently falling back to ad-hoc signing.
- Refined native-code signing and exFAT packaging to avoid detached signature attributes on images, fonts, and other resources. When needed, signing is staged on a native filesystem before copying back and verifying the package.
- Fixed macOS CI certificate trust setup waiting for interactive authorization: ephemeral runners use the non-interactive administrator trust domain and clean it up afterward, without changing the pinned signing identity.
- Added per-step signing cleanup logs, command deadlines, and workflow timeouts. Cleanup continues after individual failures, but any failure blocks publication. To avoid a macOS CI trust-removal hang, cleanup explicitly denies code-signing trust, verifies the revocation, then deletes the temporary identity. Fixed CRLF compatibility in Windows tests.
- Fixed oversized arrows for returned and handed-off subtasks, restoring the same 12px size as other state icons while preserving their labels and execution-process access.
- Improved POSIX background-command cleanup confirmation with a kernel process-group probe, reducing false uncertainty when external probes time out under load. Unconfirmed cleanup still blocks further execution.
- macOS retains its existing HTTP download, SHA-512 verification, and quit-and-swap update flow. Windows continues to use the existing NSIS installation and update flow.
- Both READMEs now play the video inline without redundant video-download links. The product website is live at https://piuqiupiaqia.github.io/Hemi/ with its video served from OSS.

Note: a stable self-signed identity is not an Apple Developer ID signature or Apple notarization, so Gatekeeper warnings may still appear. Moving from an older ad-hoc-signed version may require granting screen recording, accessibility, or microphone permissions again. Actual permission continuity must still be verified on the target Mac.
