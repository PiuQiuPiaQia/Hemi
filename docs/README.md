# 文档导航与维护

- [开发说明](development.zh-CN.md)：环境、构建与验证入口。
- [按平台发布](technical/platform-releases.md)：Mac／Windows 独立发版、验收与现有更新地址的兼容方式。
- `technical/`：当前架构、协议、实现和验证边界。
- `requirements/`：仍有效的需求、验收约定及素材来源。
- `design/`：仍有参考价值的交互稿，以及资源导出或验证依赖的设计源文件；原型检查不等于生产验收。
- `media/`：项目介绍使用的截图和来源说明。

## 当前重构需求

- [Agent 与后台任务生命周期](requirements/agent-task-lifecycle.md)：等待、额度、超时、异常反馈和历史回归约束；[候选方案](requirements/agent-task-lifecycle-proposal.md)记录与 CC 讨论后的边界处理及验证要求，待 review。
- [Bot 订阅账号](technical/bot-oauth.md)：独立浏览器授权、服务器凭据与续期、首次配置和验证边界。
- [Windows Bot](technical/bot-windows.md)：Windows x64 SSH 主机、计划任务常驻、安装维护与实机验收。

- [原生 pi-memory 实现与验收](technical/native-pi-memory.md)：进程归属、原生生命周期、搜索部署、验证证据与剩余缺口。
- [原生 pi-memory 共享记忆重构](requirements/native-pi-memory.md)：每个桌面／Bot 一个共享记忆库，直接使用原版插件，不增加记忆适配层，不保留旧版本兼容；核心方向已确认，实施方案与验收见文档。

## 历史稿清理

被替代且无工具依赖的原型、重复截图和演示视频不在当前工作树长期保存，也不搬到同仓库的 archive 目录。旧版本通过 Git 历史查看；更新入口链接时保留需求决策、独有参考图、素材来源和第三方版权声明。

本轮移除 Bot 独立交互稿 v1/v2、首版皮肤启动演示、旧静态主页稿。清理前版本为 `d020e5279a7ed9f27e73b630ae9669c9278c9987`，可用以下命令查看历史文件：

```sh
git ls-tree -r --name-only d020e5279a7ed9f27e73b630ae9669c9278c9987 -- docs/design
git show d020e5279a7ed9f27e73b630ae9669c9278c9987:docs/design/cloud-bot/v2/README.md
```

旧 Bot 原型的 [Lucide 版权声明](design/cloud-bot/LUCIDE-LICENSE.txt) 保留；独有的主页构图参考已移至[需求附件及来源记录](requirements/assets/appearance-and-skins/SOURCES.md)。

以下目录暂不清理：

- `design/appearance-skins/v1/`：`scripts/build-skin-assets.mjs` 使用的母版、头像及清单。
- `design/appearance-skins/character-motion-trial-v1/`、`character-motion-trial-v2/`、`home-background-motion-v1/`：动画生成源文件、关键帧、来源及正式皮肤所用的动画母版。
- `design/appearance-skins/motion-preview-v2/`：主页动画验证脚本仍使用其中的静态快照作基线。
- `design/appearance-skins/motion-preview-v3/`：现行需求和实施文档引用的已确认视觉依据。

删除历史稿只减少工作树和源码快照体积，不会自动缩小 `.git` 历史或桌面安装包。Git 历史重写须单独评估并授权。

## 本轮校验

基线为上述提交加文档清理工作树，环境为 Linux、Node.js v22.22.3。

- `git diff --check -- docs`：通过。
- 本地引用扫描：检查保留文件中是否仍有链接指向本轮删除的文件，并校验修改文档的本地链接。
- `node scripts/generate-appearance.mjs --check`：通过，正式皮肤资源及生成清单未变化。
- `node --test src/shared/appearance/*.test.mjs`：8 项通过。

本轮未改生产代码或依赖，未运行完整构建、Electron 或原型浏览器回归；保留的历史验证记录仍只代表原记录中的环境与范围。
