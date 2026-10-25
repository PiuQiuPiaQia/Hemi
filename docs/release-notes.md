本次修复会话存档持续膨胀的问题，改用 Pi SDK 原生持久化。

- 增量保存：聊天上下文直接追加到原生会话文件，Hemi 只保存必要的业务信息和恢复校验，不再重复生成整份状态快照。
- 兼容旧记录：自动迁移旧快照，旧聊天中的内嵌存档在首次恢复时导入；校验成功后切换到新存档，并保留迁移原件。
- 重启续聊：恢复明确绑定原会话，保留聊天记录、工具结果和停止状态；恢复会话不会重复执行已完成的工具。
- 恢复保护：保留会话归属、回卷代次、模型及工作区校验，损坏或缺失的存档不会被空会话静默覆盖。

下载：macOS（Apple 芯片）用 `.dmg`，Windows（64 位）用 `-setup.exe`。

---

This patch fixes growing session snapshots by adopting native Pi SDK persistence.

- Append conversation context to native session files instead of repeatedly copying the entire session. Hemi retains only application metadata and recovery checks.
- Migrate legacy snapshots automatically and import embedded archives when resumed. Validate imports before activation and retain the original migration sources.
- Continue existing conversations after restart with chat history, tool results and stop state preserved, without replaying completed tools.
- Validate session ownership, rewind generation, model and workspace compatibility. Missing or damaged archives cannot silently become empty sessions.

Downloads: `.dmg` for macOS (Apple silicon), `-setup.exe` for Windows (64-bit).
