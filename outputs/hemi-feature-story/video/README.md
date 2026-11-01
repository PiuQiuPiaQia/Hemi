# Hemi 产品宣传片

65 秒、1920×1080、30fps，使用 Remotion。镜头依次为任务、模型接入、记忆、角色分工、制作、SSH/Bot、官网、工作流 Beta、品牌收尾。

## 安装和导出

使用 Node.js 22.19+（Node 22 系列）：

```sh
cd outputs/hemi-feature-story/video
npm ci
npm run typecheck
npm run render        # out/hemi-features-final.mp4，带轻音乐
npm run render:nobgm  # out/hemi-features.mp4，无音轨
```

字体使用 macOS 的 PingFang SC、SF Pro，其他系统可能出现字形和换行差异。`out/`、依赖、历史导出和 QA 图片不纳入版本控制；官网的 `media/promo.mp4` 保存已验收成片。

更新官网视频时，将 `out/hemi-features-final.mp4` 复制到 `../../hemi-site-simple/media/promo.mp4`，同步修改官网 HTML 中媒体 URL 的版本参数。

## 素材与边界

- `public/tex/` 是用于本片的 Hemi 界面与官网截图；远程主机和项目为虚构演示数据，不是对真实服务器的测评。
- 工作流展示配置与运行前确认，不表示流程已经执行；官网镜头为本地页面，不表示已公开部署。
- 保留 SSH 连接条件、Bot 在线条件、记忆按主机保存、工作流 Beta 等产品边界。
- 音乐是 MrCatfishing 的 **Calm Background Music**，CC0。来源、许可和处理记录在 `public/audio/bgm/`；音源为 Freesound MP3 预览，PCM 派生文件不等于原始无损素材。
- 如需重新处理 BGM，安装 `ffmpeg`、`ffprobe`，运行 `python3 scripts/prepare-bgm.py`。淡入淡出在 `src/Main.tsx` 中实现。

## 已验收版本

2026-11-01：类型检查、带音乐和无音乐渲染成功；65 秒、1950 帧。抽帧检查已移除所有右下角制作角标，并清理制作备注。未对最终 MP4 从头到尾实时播放或人耳试听。

官网所用带音乐 MP4 的 SHA-256：

```text
9d5d64e3cb89555cafc6055ef24761f35df95a467d51b6d64f25c0afbde81b50
```
