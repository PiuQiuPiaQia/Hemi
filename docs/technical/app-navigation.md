# 桌面窗口导航

所有桌面页面使用 `src/renderer/src/components/app-top-bar.tsx` 的 `AppTopBar`。组件样式由同目录的 `app-top-bar.css` 管理，页面不再按会话栏宽度设置顶栏首列，也不自行补偿系统窗口按钮的位置。

## 接入方式

```tsx
import { AppTopBar } from '@/components/app-top-bar';

<AppTopBar
  showBrand={false}
  title="使用记录"
  back={{ label: '返回对话', onClick: onClose }}
  actions={pageActions}
/>
```

- `title`：页面名称、会话名称或页面自己的标题控件；普通字符串会自动获得截断样式。
- `back`：共用返回按钮，包含可访问名称、回调和可选的 `disabled` 状态。返回操作位于标题左侧。
- `leading`：标题前的附加控件。
- `actions`：右侧页面操作。可交互元素从窗口拖动区域排除。
- `showBrand`：需要时显示品牌图标与名称。

对话、技能、工作流、使用记录、设置、Bot 和首启引导均接入该组件。设置页面保留窄窗分类抽屉，技能与工作流页面保留现有工具槽。工作流编辑器的可编辑名称出现时，只显示这一个标题。

## 平台与外观

顶栏沿用 `--hemi-topbar-h` 的 52px 高度，与工作区的高度计算保持一致。普通页面的顶栏使用 `--bg-rail`，不按侧栏宽度分成不同颜色；主题外框仍遵循外观系统的透明规则。首启引导使用画布背景。

组件读取本机 `window.hemiVoice.platform`，即使当前查看远端 Bot，也使用本机窗口控件的布局。

macOS 保留原生红绿灯，左侧预留 96px，主进程维持 `hiddenInset` 与原来的按钮位置。Windows 使用原生 Window Controls Overlay：主进程的 `main-window-chrome.mjs` 配置单行标题栏和原生窗口按钮，渲染层通过 `titlebar-area-*` 环境变量避开右侧按钮；环境变量不可用时预留 138px 按钮区，再加常规边距。左上角显示“文件、编辑、视图、帮助”，窄窗折叠为“菜单”。主窗口取消继承的第二行菜单，macOS 系统菜单栏保持不变。

Windows 菜单由 `WindowsMenuBar` 统一提供。文件菜单接入当前页面已有的新建对话和打开工作区回调，未提供的操作显示为禁用；设置与视图菜单复用应用导航，所以仍会检查工作流的离开条件。编辑菜单使用 Electron 原生撤销、重做、剪切、复制、粘贴和全选，不自行重写文本编辑行为。文件菜单还提供原生关闭和退出；帮助菜单提供日志与关于。

`app:show-menu` 只接受主窗口主 frame 的调用，菜单内容来自固定共享定义。原生菜单关闭后返回所选页面命令，不自行执行任意 renderer 字符串。F10 聚焦菜单，Alt+F/E/V/H 打开相应分组；菜单按钮支持左右键和上下键。焦点还原到原文本输入，保留编辑目标及选区。

Windows 的按钮背景透明，随外框显示；换肤时通过现有外观广播更新原生按钮的文字色。没有自行绘制最小化、最大化或关闭按钮。

## 验证

`node scripts/verify-app-navigation.mjs` 使用独立的临时 `HEMI_USER_DATA_DIR`，分别启动 Vite 开发渲染器和构建后的 Electron 渲染器。覆盖 1440、980、560px 的页面布局、长标题、返回、键盘操作、分类抽屉、换肤及工作流名称的真实 IPC 编辑保存。

Windows 的渲染器留位在 macOS 上模拟验证。配置单测验证平台分支与换肤行为；Windows 原生按钮、Snap Layouts 和 DPI 变化仍需 Windows 真机验证。界面截图和完整结果写入 `.visual/workflow/vision/app-navigation/`。
