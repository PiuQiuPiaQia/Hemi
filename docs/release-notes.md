本次更新加入角色皮肤与冷启动演出，并修复手动重试仍调用备用模型的问题。

- 换肤：侧栏底部、设置按钮上方新增换肤入口，提供经典、晴海蓝、月见紫、焦糖橙、蜜糖金、围巾红六款浅色皮肤，点击即应用并保存，当前会话和进行中的操作不中断。
- 人物皮肤同步配色、侧栏人物水印、主页人物与题字和局部待机动画；启动时有冷启动演出，可按 Esc 或点跳过，开启减少动态效果时直接进入静态首帧。
- 后台任务完成时，窗口未聚焦、最小化或隐藏会弹出系统通知，点击通知回到主窗口。
- 预览面板宽度可拖动边线调整，方向键微调，双击恢复默认宽度。
- 修复失败后手动重试仍落在备用模型的问题：重试先请求主模型，只有这一轮确实失败才自动降级；恢复旧会话后也不沿用存档里的备用状态。
- 未配置备用模型时的失败提示改为「当前模型请求失败，本轮未切换模型」。
- 开发版运行时使用带 DEV 角标的独立图标，与正式版区分。

下载：macOS Apple Silicon 使用 `.dmg`；Windows x64 使用 `-setup.exe`。
macOS 安装包尚未进行 Developer ID 签名和公证，首次打开可能需要在“系统设置 → 隐私与安全性”中允许。

Hemi 自有代码采用 MIT。第三方许可、原生库对应源码和重建说明随安装包提供；
`uiohook-napi-1.5.5-source.tar.gz` 也可单独下载。

---

This update adds character skins with a cold-start intro, and fixes manual
retries still calling the fallback model.

- Skins: a new picker under the sidebar, above Settings, with six light themes
  (Classic, Clear Blue, Moon Violet, Caramel Orange, Honey Gold, Scarf Red).
  Choosing one applies and saves immediately without interrupting the current
  conversation or running work.
- Character skins bring their palette, a sidebar watermark, the home character
  and lettering with an idle animation. Character skins also play a cold-start
  intro that Esc or the skip button ends early; with reduced motion enabled the
  app starts on the static first frame.
- When a background task finishes while the window is unfocused, minimized, or
  hidden, a system notification appears; clicking it restores the main window.
- Resize the preview panel by dragging its edge, nudge it with the arrow keys,
  and double-click to restore the default width.
- Fix a manual retry after a failure still using the fallback model: a retry now
  asks the primary model first and only falls back if that attempt actually
  fails. Restoring an older conversation no longer reuses its archived fallback
  state.
- The failure notice without a fallback now reads "当前模型请求失败，本轮未切换模型".
- The development runtime uses its own DEV-badged icon, distinct from the
  packaged app.

Downloads: `.dmg` for macOS Apple Silicon; `-setup.exe` for Windows x64.
The macOS app is not Developer ID signed or notarized. First launch may require
approval in System Settings → Privacy & Security.

Hemi's own code is MIT licensed. Third-party licenses, native source references
and rebuilding instructions are included in the app. The libuiohook source
archive is also available as a separate download.
