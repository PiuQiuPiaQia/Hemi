# Hemi 精简官网

静态产品宣传页，包含下载入口、65 秒带轻音乐宣传片和五项产品特色。无需构建。

## 本地预览

在仓库根目录运行：

```sh
node outputs/hemi-site-simple/tools/serve.mjs 4320
```

打开 <http://127.0.0.1:4320/>。服务器仅监听本机，支持视频 Range 请求；这不是公开部署。

## GitHub Pages 发布

线上地址：<https://piuqiupiaqia.github.io/Hemi/>。

仓库 Pages 使用 GitHub Actions。`.github/workflows/pages.yml` 在 `main` 上的官网文件更新时自动部署，也可在 Actions 中手动运行 **Deploy website to GitHub Pages**。

发布采用文件白名单，只包含 `index.html`、`styles.css`、`.nojekyll`、`media/icon.svg` 和 `media/poster.jpg`。视频直接从 OSS 播放，不上传本地 MP4、视频工程、QA 截图、开发工具或说明文件。

## 内容维护

- 页面与样式：`index.html`、`styles.css`。
- 播放器与直接下载链接使用 OSS：`https://hemi-agent.oss-cn-beijing.aliyuncs.com/hemi-features-final.mp4`。公开 HTTPS 读取，支持 Range；发布网站时无需打包本地 MP4。
- `media/promo.mp4`：保留的已验收本地成片；源码和音乐许可见 `../hemi-feature-story/video/`。
- `media/poster.jpg`、`media/icon.svg`：封面与品牌图标。
- 更新视频时优先使用新的版本文件名，并同步修改 HTML 的播放和下载链接；更新封面时同步更新版本参数，避免缓存旧内容。
- QA 截图、临时文件、历史导出和备份不纳入版本控制。

页面不显示制作版本、音乐版本、时长角注或内部检查说明。产品功能说明保留 SSH/Bot 在线条件、记忆隔离和工作流 Beta 等必要边界。
