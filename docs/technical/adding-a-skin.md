# 新增 Hemi 皮肤

唯一需要编辑的皮肤定义是 [skins.config.json](../../src/shared/appearance/skins.config.json)。添加准备好的物料后，开发或构建命令会自动生成类型、首屏白名单、颜色、素材导入和资源校验清单。

## 接入步骤

1. 将人物静态 WebP、头像 WebP 和循环 VP9 WebM（透明通道）放到 `src/renderer/src/assets/skins/`。使用新的文件名，保留物料的来源、授权说明与第三方声明。
2. 在 `skins.config.json` 数组末尾复制一款人物皮肤，修改 `id`、`name`、配色、题字和素材字段。ID 是稳定的持久化标识，使用小写英文字母、数字及连字符；数组顺序即换肤面板顺序。`classic` 固定在第一项。
3. 运行 `npm run build`，或重启 `npm run dev` / `npm run dev:renderer`。不需要手改类型、白名单、IPC、React 组件或 CSS 选择器。将配置、素材和自动生成文件一起纳入代码提交。

颜色与业务状态分开：`palette` 决定界面主色、浅底、边框及色阶，警告、错误、成功等语义色由共用实现保持。`scale` 需要填写 50、100、200、300、500、600、800、900 八档六位十六进制颜色，700 档使用 `accent`。

示例字段（以当前蓝色配置为例，新增时更改 ID、文案及文件名）：

```json
{
  "id": "cafe-blue",
  "name": "晴海蓝",
  "palette": {
    "rail": "#edf2fb",
    "accent": "#385f9f",
    "line": "#dce4f0",
    "scale": {
      "50": "#edf3ff", "100": "#dfe9fb", "200": "#c4d5f5",
      "300": "#a5bee9", "500": "#7d9dd6", "600": "#587fc1",
      "800": "#2e508c", "900": "#253f70"
    }
  },
  "lettering": {"headline": "Smile", "subline": "DeepSeek", "color": "#7893b6"},
  "assets": {
    "image": "cafe-blue.webp",
    "portrait": "cafe-blue-portrait.webp",
    "motion": "cafe-blue-idle.webm",
    "width": 1135, "height": 1386, "paddingX": 48, "paddingY": 16,
    "durationMs": 8000, "framesPerSecond": 30, "motionKind": "blink-hair-cloth"
  }
}
```

`width`、`height` 是人物主体画布的尺寸，`paddingX`、`paddingY` 是动画导出时相对主体画布的透明留白，两者使用同一坐标系。它们用于对齐静态图与动画，不能直接替换为压缩后影片的编码尺寸。文件名只填写上述素材目录内的文件名。`durationMs`、`framesPerSecond`、`motionKind` 用于资源清单，按实际物料填写。仅配色的皮肤可以将 `assets`、`lettering` 都设为 `null`。

## 可选配置

- `windowBackground`：原生主窗口底色，默认使用 `palette.rail`。
- `interaction`：默认以主色与白色混合，hover 为 16%，选中为 24%，选中后 hover 为 30%。可以覆盖 `color`、`hover`、`active`、`activeHover`，后三者应递增，且位于 0–40% 之间。经典皮肤使用自己的中性色与 8/12/16% 配置。
- `lettering.sizes`：按需覆盖 `home`、`medium`、`narrow`、`startup`、`startupMedium`、`startupNarrow`、`startupCompact`。单位为 px，默认值分别为 104、72、62、136、136、92、80。长题字可以直接在配置中调小，无需新增按 ID 区分的 CSS。

首次接入使用已有的冷启动与主页动画流程；对话流和设置等页面继续显示静态素材。制作新的动作、拆层与绑定属于物料制作，准备好影片即可接入。`scripts/build-skin-assets.mjs` 保留为原五款人物的离线制作工具，普通接入不需要运行它。

## 自动生成与检查

`scripts/generate-appearance.mjs` 先校验整份配置及所有素材文件，再更新发生变化的输出；缺失或空素材、重复 ID、错误色阶、路径和尺寸会让命令失败。开发、renderer 构建及完整构建入口都会调用生成器。

生成文件为：

- `src/shared/appearance/skins.d.mts`
- `src/renderer/public/appearance-bootstrap.js`
- `src/renderer/public/appearance-colors.css`
- `src/renderer/src/appearance/assets.ts`
- `src/renderer/src/assets/skins/manifest.json`（逐文件字节数、SHA-256 和媒体元数据）

可独立运行 `node scripts/generate-appearance.mjs --check` 检查生成漂移。接入回归运行 `node --test src/shared/appearance/*.test.mjs`、`npm run build`，并用全新 `HEMI_USER_DATA_DIR` 验证换肤面板、静态/动画素材、冷启动、重启恢复及窄窗题字。真实窗口脚本为 `node scripts/verify-appearance-catalog.mjs`；开发 renderer 另设 `VITE_DEV_SERVER_URL`。
