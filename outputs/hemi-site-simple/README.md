# Hemi 精简官网

静态产品宣传页，包含下载入口、65 秒带轻音乐宣传片和五项产品特色。无需构建。

## 本地预览

在仓库根目录运行：

```sh
node outputs/hemi-site-simple/tools/serve.mjs 4320
```

打开 <http://127.0.0.1:4320/>。服务器仅监听本机，支持视频 Range 请求；这不是公开部署。

## 内容维护

- 页面与样式：`index.html`、`styles.css`。
- `media/promo.mp4`：已验收成片；源码和音乐许可见 `../hemi-feature-story/video/`。
- `media/poster.jpg`、`media/icon.svg`：封面与品牌图标。
- 更新视频或封面后，同步更新 HTML 中媒体 URL 的版本参数，避免缓存旧内容。
- QA 截图、临时文件、历史导出和备份不纳入版本控制。

页面不显示制作版本、音乐版本、时长角注或内部检查说明。产品功能说明保留 SSH/Bot 在线条件、记忆隔离和工作流 Beta 等必要边界。
