# 冷启动到人物动态主页 · 完整预演 v3

日期：2026-10-21。把已确认的冷启动界面演出、人物动画 v2 和现有主页背景串成同一段演示。

- [完整交互演示](index.html)：默认从片头开始，可重播、跳过片头、直接看主页、暂停和拖动进度。
- [14 秒完整视频](hemi-complete-theme-demo.mp4)：1440 × 960，30fps，无声；前 6 秒冷启动，后 8 秒主页人物循环。
- [不带评审控制条的场景](scene.html)、[封面](poster.png)、[验证记录](qa.json)。

## 演出顺序

| 时间 | 画面 |
| --- | --- |
| 0–1.4s | 浅蓝场景打开，右侧人物入场，左侧 Smile / DeepSeek 揭示，细弧线描边 |
| 1.4–3.2s | 现有 Hemi 只读界面浮现；人物继续眨眼和发梢、衣料动画 |
| 3.2–5.1s | 界面从透视展开到原尺寸，前景人物移动并缩放到主页人物的相同位置 |
| 5.1–5.75s | 人物原点、尺寸、视频帧对齐后，将前景人物交给主页背景层，恢复左侧题字 |
| 5.75–6s | 主页画面稳定，人物动画继续 |
| 6–14s | 主页完整播放一轮 8 秒人物动画：眨眼、发梢摆动、肩部与衣料起伏 |
| 交互预览 14s 之后 | 继续主页循环；片头不会自动重播 |

沿用 [v2 冷启动](../motion-preview-v2/README.md)的题字和界面展开方式，人物改用[已确认的局部动画](../character-motion-trial-v2/README.md)。主页保留[现有整体合成](../home-background-motion-v1/README.md)的背景、输入框和列表样式。

前景与主页引用同一份高清透明视频，两者共享连续的 8 秒素材时间；第 6 秒不重置人物时钟。先对齐到主页人物框，再进行图层交接，避免两张脸或头发轮廓错位。进入主页后暂停隐藏的前景视频，只保留背景视频播放。没有添加整图浮动来代替局部动作。

减少动态效果时直接显示静态主页。评审者点击重播或播放可主动查看演出。页面隐藏时暂停，媒体失败时保留静态主页。底部的播放按钮是预览工具，不是新增皮肤设置或人物背景开关。

## 验证与复现

在仓库根目录，Node 22.19+，使用本机 Chrome、Playwright、FFmpeg：

```sh
node --check docs/design/appearance-skins/motion-preview-v3/demo-motion.js
node docs/design/appearance-skins/motion-preview-v3/verify-and-export.mjs
```

可通过 `HEMI_PREVIEW_PLAYWRIGHT` 和 `HEMI_PREVIEW_FFMPEG` 指定工具路径。没有安装新依赖，也没有复制系统字体文件。

检查覆盖：人物交接时的原点/尺寸与媒体帧同步、片头落点与直接进入主页的同帧一致性、自动进入主页、暂停、14 秒后继续主页、重播/跳过/拖动、减少动态效果、1440/768/375px 宽度，以及输出 MP4 的实际播放。主页按钮、输入控件、侧栏、主区和题字的几何、字体、圆角与原快照逐项对照。环境、基线 HEAD 和准确结果记录在 `qa.json`；截图及视觉报告位于 `.visual/workflow/vision/motion-preview-v3/` 与 `.visual/workflow/vision-report-motion-preview-v3.md`。自动化浏览器在检查结束后关闭。

## 素材与边界

本目录的 scene.html 派生自既有只读 Hemi DOM/CSS 快照；人物引用 `../home-background-motion-v1/character-idle-alpha-hq.webm`，未新增角色图片或改动动作参数。源图、眼部素材、内置 image_gen 制作模式和完整提示词见 [v1 记录](../character-motion-trial-v1/README.md)。题字是蒙版揭示与装饰弧线描边，不是手写字形的逐笔动画。

这是冷启动到主页的完整视觉预演，界面不连接真实会话、IPC 或模型服务。它不代表真实应用启动已接入，也不是正式 Cubism 模型；转头、挥手、正式拆层工程、Electron 生命周期和目标平台性能仍需制作与验收。
