# Hemi 冷启动演出与主题背景实现

日期：2026-10-21。用户已确认[完整预演 v3](../design/appearance-skins/motion-preview-v3/README.md)，本轮已接入真实应用。本文描述当前实现；早期提案里的转身、抬手、视频生成服务和外部窗口嵌入不属于本次交付。

关联：[产品需求](../requirements/appearance-and-skins.md)、[换肤完整技术方案](appearance-and-skins.md)、[实施与验证记录](appearance-implementation.md)。

## 1 演出和实际资源

五款人物采用同一套已确认的界面展开交互，分别使用本角色的配色、题字、静态人物和 8 秒透明动画。晴海蓝包含眨眼、发梢和衣料动作，其余角色包含发梢/衣料或围巾/衣料的局部参数形变。程序播放的是离线导出的 VP9 alpha 视频，运行时不依赖 Cubism、WebGL 形变器或外部生成服务。

| 时间 | 画面与实现 |
| --- | --- |
| 0–1.4s | 同主题场景先显示；人物平移、旋转和缩放入场；题字通过蒙版揭示，装饰线描边 |
| 1.4–3.2s | 已在后台加载的真实 AppSurface 淡入；没有烘焙软件文字或第二份 Home |
| 3.2–5.1s | AppSurface 从透视平面展开到正常位置；前景人物同步移动和缩放到主页锚点 |
| 5.1–5.75s | 前后人物原点、宽高与素材时间对齐后交叉淡化，恢复主页题字 |
| 5.75–6s | UI 稳定，准备交还操作 |
| 6s 以后 | 前景节点卸载并释放视频 src；主页继续所选角色的 8 秒循环，不重置时钟 |

启动和主页使用同一素材映射与 padding 参数。两路视频从同一时间起播；交接处若偏差超过 1/30 秒，再校正主页时间到前景时间。轮廓先对齐再淡化，避免两个不同位置的人物同时露出。

## 2 分层与状态

```text
StartupStage（不随皮肤重新挂载）
├─ AppSurface（同一份现有 Home）
│  ├─ ThemeBackdrop / ThemeLettering
│  └─ 会话、设置、技能、工作流及现有 Portal
└─ StartupOverlay（仅 preparing / intro / waiting）
   ├─ Scene、Foreground、Title
   └─ Skip、真实准备状态、超时重试
```

| 状态 | 进入与退出 |
| --- | --- |
| preparing | 页面已获得主题快照，真实 Home 开始初始化；等待可见/聚焦和媒体准备 |
| intro | 两路媒体可用且原生窗口可见聚焦；运行一次 6 秒时间线 |
| waiting | 演出结束/跳过，但现有业务初始化尚未完成；显示准备状态，12 秒后提供重新加载 |
| done | 业务已准备完成；移除遮挡，AppSurface 恢复 transform:none、原有交互和 Portal |

经典皮肤没有人物片头，准备完成后进入原有页面。主窗口每次创建只有第一份文档获得 coldStart=true；reload、隐藏恢复、换肤及三类悬浮窗口均不重播。选择人物皮肤后退出再启动，按保存的皮肤演出。

BOOT_VISUAL_READY 只说明同主题舞台可以绘制，与 ready-to-show 和当前 revision 的 applied 一起协调原生显示。APP_READY 来自现有 Home 的 bootstrapping 状态，决定真实 UI 能否接管。二者分离，避免为播放片头延迟应用初始化，也避免把空壳伪装成已加载页面。

## 3 中断与焦点

演出期间 AppSurface inert。body 上新建的 Portal 同样暂时 inert，保留原宿主和进入前的 inert 值；结束时恢复。启动层捕获键盘，Tab 保持在跳过/重试按钮，Esc 优先跳过，避免触发底层任务快捷键。

切换皮肤、减少动态效果、已起播后失焦/隐藏、改变窗口尺寸、媒体失败或准备超过 1.8 秒，取消本代演出并收口到当前主题。已开始的演出不会在恢复焦点后重播。异步准备和 rAF 持有取消代次，旧角色不能重新占据前景。

跳过只跳过视觉演出。业务未就绪时继续 waiting；业务已就绪时直接进入真实页面。不会为演出重建会话、恢复任务或调用模型。

## 4 主页播放规则

| 场景 | 动画行为 |
| --- | --- |
| 空主页、无输入、窗口可见且聚焦 | 继续循环 |
| 文本框聚焦或有草稿、通话进行中 | 暂停并保留当前帧 |
| 对话流（历史、回复中、任务）、设置、技能、工作流 | 使用同角色静态 WebP，卸载 video 并清除 src；阅读态保留淡题字，位于正文下方 |
| 窗口隐藏/最小化/失焦或 document.hidden | 暂停；依赖原生 activity，兼容 backgroundThrottling=false |
| prefers-reduced-motion | 取消片头；已加载视频暂停在当前帧，未加载时使用静态人物 |
| 更换皮肤 | 旧视频 pause、移除 src、load 释放；新角色按当前场景决定是否加载 |
| 视频损坏或无法播放 | 同人物 WebP 静态回退；现有 UI 可继续操作 |

静止状态没有维护人物的永久 rAF 或轮询。空主页只保留当前角色的一路视频；片头临时增加前景一路，结束后卸载。若落到已有对话，主页播放器也一并释放，仅显示静态图。侧栏水印独立于视频，透明度由 13% 降至 6.5%，只是固定底层图片，不影响列表滚动、点击、选择或重命名。

## 5 资源与打包

`scripts/build-skin-assets.mjs` 从已确认母版导出 WebP 静态人物、256px 头像和 8 秒 / 30fps VP9 alpha 视频，写入 renderer assets。蓝色复用确认动画；其余四款由离线 WebGL 局部形变导出。每个文件的字节数、SHA-256、源尺寸和 padding 记录在 manifest。

| 资源组 | 当前总量 |
| --- | --- |
| 五张头像 | 146,990 bytes |
| 五张静态人物 | 1,417,122 bytes |
| 五路透明动画 | 23,961,962 bytes |

资源经静态 import 交给 Vite，开发和构建共享同一映射。运行时不引用 docs、桌面源文件或远程 URL。未选角色的影片仅存在于打包产物，不创建播放器或预解码。来源和制作方式见[运行资源说明](../../src/renderer/src/assets/skins/README.md)。

## 6 验证边界

真实 Electron 的 Vite 与构建 renderer 使用同一套 `scripts/verify-appearance.mjs`，验证冷启动、结束释放、跳过、reload/恢复不重播、草稿暂停与阅读静态图/播放器释放、减少动态效果、五路真实 alpha 解码、多窗口同步和窄窗面板。本轮静态阅读优化另由 `scripts/verify-appearance-reading.mjs` 覆盖。准确命令、基线和结果统一记录在[实施记录](appearance-implementation.md)。

当前平台为 macOS Apple Silicon。Windows 的标题栏、透明窗口、字体回退、VP9 解码和性能需在 Windows 实机补验；未以 macOS 结果声称已经覆盖。正式 Live2D 拆层、模型绑定、转头和挥手另属后续素材制作需求。
