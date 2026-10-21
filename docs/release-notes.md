本次更新改进成果文件展示、思考进度和失败重试，并恢复默认空间与旧会话的目录快捷入口。

- 成果文件：图片在对话中显示保留原比例的小缩略图，普通文件显示紧凑卡片，点击进入预览。明确引用的本地文件也可查看；同回合去重，后续更新复用预览标签，缺失文件可重试。
- 文件打开：macOS 右键菜单按文件类型列出少量常用程序，可直接打开文件，或在访达中打开所在目录并选中文件。
- 历史恢复：恢复已有成果在生成与登记回合中的入口，修复中文、特殊符号和长路径可能共享文件身份的问题，并让新登记跟随正确的输入位置。
- 思考进度：过程组收起时显示最新思考与持续更新的耗时；展开、完成或停止后显示相应状态。
- 目录入口：本机项目、默认空间和旧会话均提供访达、终端、VS Code 快捷入口；默认空间首次打开时创建目录，旧会话打开实际家目录。
- 模型与重试：精简模型选择显示，改进任务委派指引；失败提示提供可展开的诊断信息，切换会话或重启后仍能按原输入重试。

下载：macOS（Apple 芯片）用 `.dmg`，Windows（64 位）用 `-setup.exe`。macOS 安装包采用临时签名，尚未进行 Developer ID 签名与公证，首次打开可能需在「系统设置 → 隐私与安全性」中允许。

---

This update improves file results, thinking progress and failed-turn retries, and restores directory shortcuts for default and older conversations.

- File results: images appear as small thumbnails at their original proportions; other files use compact cards. Click to preview, retry missing files, and reuse the same preview tab after updates. Explicit local file references can also be previewed.
- Open files: on macOS, the context menu lists a few common applications for the file type, plus an action to reveal and select the file in Finder.
- History: recover existing results in their generating and registration turns. Fix file identity collisions involving Chinese names, special characters or long paths, and attach new registrations to the correct input.
- Thinking progress: collapsed process groups show the latest thought and a running timer, with appropriate states when expanded, completed or stopped.
- Directory shortcuts: local projects, the default workspace and older conversations offer Finder, Terminal and VS Code actions. The default directory is created on first use; older conversations open the actual home directory.
- Models and retries: simplify model selection and improve delegation guidance. Failed turns show expandable diagnostics and retain their original retry input across navigation and restarts.

Downloads: `.dmg` for macOS (Apple silicon), `-setup.exe` for Windows (64-bit). The macOS build is ad-hoc signed without Developer ID notarization; first launch may require approval under System Settings → Privacy & Security.
