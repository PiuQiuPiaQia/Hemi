# 晴海蓝 · 人物动作试片 v2

日期：2026-10-21。针对 v1 发梢和衣服动作难以察觉的反馈，增强局部运动并修复预览缩放。

已合成到[主页背景整体预览](../home-background-motion-v1/index.html)，可直接看现有页面中的效果。

- [交互对照](index.html)：默认新版，可切换原版、新版、静止画面；左侧同步放大发梢与肩部衣料。
- [8 秒普通预览](character-motion-preview.mp4)：1440 × 960，30fps，无声。
- [透明人物素材](character-idle-alpha.webm)：616 × 710，30fps，VP9 alpha，无声，不含背景、文字或特写框。
- [浏览器与编码检查结果](qa.json)。

## 调整

发梢水平主振幅由源图 7px 增至 28px，叠加 4px 的次级摆动；垂直幅度由 2.4px 增至 8px。两侧发梢保持不同相位，头发靠近脸部的位置保持固定。衣料起伏由 1.8px 增至 8px，扩大肩部到腰部的作用范围，并给领口蝴蝶结增加小幅滞后运动。脸部核心区域没有增加运动权重。

透明人物画布增加四周留白，避免加大后的发梢超出原始 PNG 画布而被截断。预览的名义画布为 1440 × 960；修复了缩放字符串缺少插值的问题，375/768/1440px 窗口均显示同一完整构图。v1 同步修复缩放。

这版用于看清动作差异，后续可以依据实际主页尺寸再降低常驻幅度。当前仍是单图局部网格变形，并非独立发束和服装拆层模型；沿用 v1 的眼部关键帧，没有重新生成角色图片。原始资产、内置 image_gen 制作模式和完整提示词见 [v1 制作记录](../character-motion-trial-v1/README.md)。

## 验证

macOS / Node 22.22.3 / Chrome 155，基于 `559397ac57bdd85893be3380e55e03f2d1501fa3` 上的未提交设计稿改动。

```sh
node --check docs/design/appearance-skins/character-motion-trial-v2/rig.js
node docs/design/appearance-skins/character-motion-trial-v2/verify-and-export.mjs
node docs/design/appearance-skins/character-motion-trial-v2/verify-and-export.mjs --check-existing
```

最后一条在修复窗口缩放后复核已导出视频和交互。渲染实测：固定眼睛时脸部核心区域的像素变化为零；0 秒与 8 秒网格输出相同；原版与新版在源图同一发梢扫描线的轮廓位移范围分别为 15px、62px；领口宝石的垂直质心位移范围约为 1px、20px。后两项是特定扫描线和局部特征的测量，用于确认实际渲染变化，不代表全图位移或直接换算成 Live2D 参数。

交互、减少动态效果、窗口缩放、MP4 播放和 WebM 实际透明解码通过。采用浅色概念稿，无独立深色模式。截图与视觉检查记录在 `.visual/workflow/vision/character-motion-trial-v2/` 和 `.visual/workflow/vision-report-character-motion-trial-v2.md`。自动化浏览器在验证后关闭。

本轮只改设计试片，没有接入 Hemi；未验证 Electron 开发/构建版、跨平台解码与功耗。正式 Live2D 拆层、眼睑绑定、转头和挥手仍在[人物动画制作计划](../character-animation-production.md)内。
