# 晴海蓝 · 人物动作试片

日期：2026-10-21。用于验证当前人物的眨眼、局部发丝轻摆和衣服起伏。制作模式为内置 `image_gen` 图像编辑 + WebGL 参数网格。未接入 Hemi 生产应用。

发梢和衣料幅度已在[动作增强对照 v2](../character-motion-trial-v2/index.html)中调整；本目录保留首版动作，并同步修复预览窗口缩放。

## 查看与下载

- [交互试片](index.html)：右侧完整人物、左侧同步面部特写；可暂停、手动眨眼、拖动眼睛闭合程度和查看变形网格。
- [普通预览 MP4](character-motion-preview.mp4)：8 秒，1440 × 960，30fps，无声。面部特写和文字仅用于检查效果。
- [透明人物素材 WebM](character-idle-alpha.webm)：8 秒，560 × 684，30fps，VP9 + alpha，无声。只有人物，无题字、特写或背景。
- [睁眼](keyframe-open.png)、[半闭眼](keyframe-half.png)、[闭眼](keyframe-closed.png)：渲染截图，便于对照关键状态。
- [验证结果](qa.json)、[原图来源与 SHA256](sources.json)、[完整提示词](prompts.json)。

原图本身是一只眼睛睁开、另一只眼睛保持眨眼的表情。本试片只让原本睁开的眼睛闭合，没有补另一只眼睛的睁眼状态。

## 这版实际做了什么

1. 从[原始透明 PNG](../v1/masters/cafe-blue.png)编辑生成两张同画布关键帧：[半闭眼](assets/eye-half.png)与[闭眼](assets/eye-closed.png)。两张都是 1135 × 1386 RGBA；保留生成文件原始字节，没有裁切或重采样。
2. 渲染时继续使用原图。只在以原图坐标 `(478, 468)` 为中心、旋转 −22° 的椭圆眼部区域混合关键帧；半径为 `(76, 49)`，边缘柔和过渡。原图其余区域不受生成帧的像素差异影响。
3. 用 96 × 120 网格、11737 个顶点和 23040 个三角形对两侧发梢与服装局部变形。发丝最大参数位移约 7px，衣服起伏约 1.8px；脸部核心区域权重为零。没有整体平移人物。
4. 8 秒循环中在约 2.2 秒、5.65 秒开始眨眼。一次闭合 80ms、停留 65ms、睁开 125ms。发丝周期为 8 秒，服装起伏周期为 4 秒；网格的 0 秒与 8 秒输出相同。
5. 从同一渲染导出普通预览与透明人物素材，题字和放大框没有烘焙进透明素材。

这是单张人物图上的局部参数动画。眼睛通过关键帧混合实现，头发和服装尚未拆成可互相遮挡的独立图层；未生成 Cubism 分层 PSD、模型工程、moc3 或 motion3.json。它能验证当前画风动起来的观感，无法替代正式 Live2D 建模交付。

## 验证与限制

验证环境与具体结果见 [qa.json](qa.json)。通过本地 Chrome 对交互、减少动态效果、375/560/980/1440px 宽度、循环边界和编码后视频播放的检查；实际解码检查确认 WebM 含透明像素及不透明人物像素。

固定睁眼状态时，脸部核心区域在不同动作时刻的像素比较为零变化；固定时刻切换闭眼状态时，变化仅落在眼睛附近。8 秒首尾网格渲染逐像素一致。上述结果来自当前试片渲染，不代表全部动作已达到正式交付质量。

这版没有转头、挥手、口型或多发束遮挡；眼睛过渡是短时间混合，逐帧看仍可能看到睫毛重影。正式建模应拆分眼白、虹膜与眼睑，采用连续几何形变，并由原画修正重叠区域。Hemi Electron 开发/构建版、跨平台解码、功耗和应用生命周期尚未验证。

## 复现

在仓库根目录，Node 22.19+：

```sh
node docs/design/appearance-skins/character-motion-trial-v1/build-assets.mjs
node docs/design/appearance-skins/character-motion-trial-v1/verify-and-export.mjs
```

第一条只把三张源 PNG 的原始字节包装为离线 data URL，生成 `assets-data.js`，解决 `file:` 页面 WebGL 纹理的跨源问题；不编辑图片。第二条运行浏览器检查并从 Canvas 导出视频，需要本机 Chrome、Playwright 和 FFmpeg。可通过 `HEMI_PREVIEW_PLAYWRIGHT`、`HEMI_PREVIEW_FFMPEG` 指定本地工具路径。没有新增 renderer 依赖。

正式制作与接入路线见[人物动画制作建议](../character-animation-production.md)，现有冷启动和主页界面预演见[动效预演 v2](../motion-preview-v2/index.html)。
