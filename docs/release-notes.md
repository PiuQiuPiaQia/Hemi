修复技能市场 401 与安装被限流的问题，重排技能详情与安装交互。本版为 macOS Apple Silicon 修复版本。

- 技能市场搜索恢复可用：SkillsMP 上游改为强制鉴权导致搜索全量 401，发现层已切换到匿名搜索接口，条目内容不变。
- 安装不再受 GitHub 匿名接口每小时 60 次的限制：提交解析改走 git 协议、文件改走归档通道，连续安装不会中途被限流卡住；确因内容问题装不了时，界面会给出真实原因而不是笼统的限流提示。
- 技能详情页重排：安装按钮移到页面上方随手可点；安装改为两步——先读取来源并列出完整核对材料（固定提交、内容摘要、文件清单、SKILL.md 原文），确认后才保存；同时清掉了重复的解释性文案。
- 单文件上限从 1 MiB 放宽到 2 MiB，附带数据文件的技能（如 impeccable）可以正常安装。
- 待发送队列支持拖拽排序，对话流可用 Esc 暂停。

---

Fixes the skill marketplace returning 401 and installs being rate-limited, and redesigns the skill detail and install flow. This patch release is for macOS Apple Silicon.

- Marketplace search is back: SkillsMP now requires authentication on its public endpoint, so discovery switched to the anonymous search API with the same catalog.
- Installs no longer depend on GitHub's anonymous API quota (60/hour): commit resolution moved to the git protocol and file downloads to the archive channel, so repeated installs are not throttled mid-way; when a skill genuinely cannot be installed, the real reason is shown instead of a generic rate-limit message.
- Redesigned skill detail page: the install action sits at the top within reach; installing is now two-step — read the source, review the full material (pinned commit, content digest, file list, SKILL.md), then confirm to save — with redundant explanatory copy removed.
- Per-file size limit raised from 1 MiB to 2 MiB, so skills that bundle data files (for example impeccable) install correctly.
- The outbox queue supports drag-to-reorder, and Esc now pauses an ongoing conversation turn.
