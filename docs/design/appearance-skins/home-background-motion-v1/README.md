# Hemi 主页人物动画整体预览

日期：2026-10-21。将已确认的[人物动画 v2](../character-motion-trial-v2/README.md)放入现有主页主题背景，检查真实页面尺寸下的整体观感。

冷启动与本主页动画已串联为[完整演示 v3](../motion-preview-v3/index.html)。

- [打开整体预览](index.html)：默认动态背景，可暂停或切到静态对照。底栏仅用于本次视觉评审，不是新增产品设置。
- [只看主页](scene.html)：不显示评审控制条。
- [8 秒整体样片](hemi-home-background-motion.mp4)：1440 × 960，30fps，无声。
- [高清透明人物视频](character-idle-alpha-hq.webm)：1232 × 1418，30fps，8 秒循环，无声。
- [画面截图](poster.png)、[验证记录](qa.json)。

## 合成方式

沿用已确认的主页 DOM/CSS 只读快照。侧栏、50 条演示会话、欢迎语、头像、输入框、建议任务和左侧 `Smile / DeepSeek` 题字保持原样；没有加入人物特写面板，也没有重新设计产品控件。

人物继续放在背景层，不拦截点击。使用 v2 同一组眼部关键帧和网格参数，不叠加整张 PNG 浮动；人物自身眨眼、发梢摆动和衣料起伏通过透明视频播放。延续原背景的透明度、底部渐隐和窄窗减弱样式。

为了避免试片的低分辨率输出在主页放大后模糊，重新从 v2 网格导出接近原始画布尺寸的透明 VP9。该评审文件约 10 MiB，正式发行的编码、尺寸和常驻功耗仍需接入后评估。

动画导出画布包含源图四周的留白，因此渲染位置以原始 PNG 的框和源图原点对齐，扣除左侧 48px、上侧 16px 留白，保持脸部、头部及整体比例与静态背景一致。窗口变化时重新计算人物框；视频的额外留白不会把脸缩小或移动。

减少动态效果时默认静态背景；页面隐藏时暂停；视频解码失败时显示原始 PNG。静态对照只用于评审，不新增人物背景开关。

## 验证与复现

在仓库根目录，使用 Node 22.19+、本机 Chrome、Playwright 与 FFmpeg：

```sh
node docs/design/appearance-skins/home-background-motion-v1/export-character.mjs
node --check docs/design/appearance-skins/home-background-motion-v1/home-motion.js
node docs/design/appearance-skins/home-background-motion-v1/verify-and-export.mjs
```

可通过 `HEMI_PREVIEW_PLAYWRIGHT` 和 `HEMI_PREVIEW_FFMPEG` 指定本地工具路径。未安装新的 renderer 依赖。源人物图及原图版权信息未改动；眼部素材和生成提示词沿用 [v1 记录](../character-motion-trial-v1/README.md)。

浏览器检查将现有界面所有按钮、输入控件、侧栏、主区、输入框和题字的几何、字体、圆角逐项与原快照对照，并检查人物原点、实际视频播放/暂停与循环、列表滚到底部的背景稳定性、静态对照、减少动态效果和原生解码失败回退。1440/980/768/375px 截图与视觉报告保存在 `.visual/workflow/vision/home-background-motion-v1/` 和 `.visual/workflow/vision-report-home-background-motion-v1.md`。准确环境、基线 HEAD、命令及结果见 `qa.json`。

这是现有主页样式下的只读合成预览，没有接入 Hemi 生产代码、真实会话或模型服务。Electron 开发/构建版、跨平台解码、多窗口生命周期、性能与正式换肤偏好保存仍需实施；人物也仍是局部参数试片，尚未制作正式 Cubism 模型。
