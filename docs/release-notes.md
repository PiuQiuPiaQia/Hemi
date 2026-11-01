本地技能导入、更严格的工作流技能检查、子任务交接与后台任务修复；更新产品介绍与宣传视频。

- 技能中心支持扫描本机常用 Agent 技能目录并批量导入：覆盖 ~/.agents、~/.claude、~/.codex、~/.cursor、~/.gemini、~/.config/opencode 及已登记本机工作区下的技能目录；本机导入默认创建软链接并实时跟随源目录更新，移除导入不会删除原目录。
- Bot 技能中心同样支持扫描本机技能并跨机传输导入，远端无需暴露本机路径。
- 工作流运行前严格检查所需技能：失效的本地软链接技能会明确报错提示，不再静默降级为普通节点；备份与恢复不跟随符号链接，技能源目录不会被误归档。
- 子任务结构化交接：统一派单、受理、补充指令与结果回传的校验协议，宿主事实与模型声明分开核对。
- 修复后台任务按目标取消与归属：取消不再误伤无关工作，委派事件与任务历史归属更准确。
- 修复已释放会话再次关闭时，旧的清理错误影响后续任务重建的问题。
- 改进 Windows Bot 后台保存：状态文件临时被占用时让出事件循环并有界重试；失败保留原数据并报告错误，保存版本仅在落盘成功后推进。
- 更新精简官网源码，双语 README 改版并加入功能宣传视频。

---

Local skill imports, stricter workflow skill checks, subagent handoff and background-task fixes, plus a new product site with a promo video.

- The skill center can scan common local agent skill directories and batch-import them: ~/.agents, ~/.claude, ~/.codex, ~/.cursor, ~/.gemini, ~/.config/opencode and registered local workspaces. Local imports default to managed symlinks that follow the source in real time; removing an import never deletes the original folder.
- The Bot skill center supports the same local scan and cross-host transfer import without exposing local paths to the remote host.
- Workflows verify required skills up front: an unavailable symlinked skill now fails with a clear message instead of silently degrading. Backups no longer follow symbolic links, so skill sources are never accidentally archived.
- Subagent handoffs now use a validated structured protocol for dispatch, acceptance, follow-up instructions and results, keeping host facts separate from model claims.
- Fixed background-task cancellation and ownership: cancelling by goal no longer stops unrelated work, and delegation events map to the right task history.
- Fixed repeated closure of a disposed session resurfacing an earlier cleanup error and blocking the next task's session setup.
- Improved Windows Bot background saves with bounded, event-loop-yielding retries for transient state-file contention. Failed writes preserve existing data and report errors; revisions advance only after a successful commit.
- Added simplified product website source; bilingual READMEs now lead with the feature promo video.
