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

## 4 主页与对话流播放规则

以下为用户澄清后的现行规则，替代早期“阅读静态、输入暂停”的政策；片头自身的焦点中断规则不变。

| 场景 | 动画行为 |
| --- | --- |
| 主页、对话流（历史、回复中、任务），窗口可见 | 继续同角色视频循环 |
| 文本框聚焦、有草稿、通话/生成进行中、窗口失焦但仍可见 | 不暂停普通背景视频 |
| 设置、技能、工作流等 other 页面 | 使用同角色静态 WebP，卸载 video 并清除 src |
| 窗口隐藏/最小化或 document.hidden | 暂停并保留进度；依赖原生 activity，兼容 backgroundThrottling=false |
| prefers-reduced-motion | 取消片头；卸载背景 video，使用静态人物 |
| 更换皮肤 | 旧视频 pause、移除 src、load 释放；新角色按当前场景决定是否加载 |
| 视频损坏或无法播放 | 同人物 WebP 静态回退；现有 UI 可继续操作 |

静止状态没有维护人物的永久 rAF 或轮询。主页及对话流只保留当前角色的一路视频；片头临时增加前景一路，结束后卸载前景。若落到已有对话，背景播放器继续循环，不因 reading 切换而重建。侧栏水印独立于视频，透明度由 13% 降至 6.5%，只是固定底层图片，不影响列表滚动、点击、选择或重命名。

## 5 资源与打包

`scripts/build-skin-assets.mjs` 从已确认母版导出 WebP 静态人物、256px 头像和 8 秒 / 30fps VP9 alpha 视频，写入 renderer assets。蓝色复用确认动画；其余四款由离线 WebGL 局部形变导出。每个文件的字节数、SHA-256、源尺寸和 padding 记录在 manifest。

| 资源组 | 当前总量 |
| --- | --- |
| 五张头像 | 146,990 bytes |
| 五张静态人物 | 1,417,122 bytes |
| 五路透明动画 | 23,961,962 bytes |

资源经静态 import 交给 Vite，开发和构建共享同一映射。运行时不引用 docs、桌面源文件或远程 URL。未选角色的影片仅存在于打包产物，不创建播放器或预解码。来源和制作方式见[运行资源说明](../../src/renderer/src/assets/skins/README.md)。

## 6 验证边界

真实 Electron 的 Vite 与构建 renderer 使用同一套 `scripts/verify-appearance.mjs` 覆盖主题生命周期。现行阅读视频策略由 `scripts/verify-appearance-reading.mjs` 定向检查 src、paused、currentTime 推进、输入/失焦、换肤释放、other 静态与减少动态效果；报告明确区分原生事件和测试注入事件。准确命令、基线、结果和验证缺口统一记录在[实施记录](appearance-implementation.md)。

当前平台为 macOS Apple Silicon。Windows 的标题栏、透明窗口、字体回退、VP9 解码和性能需在 Windows 实机补验；未以 macOS 结果声称已经覆盖。正式 Live2D 拆层、模型绑定、转头和挥手另属后续素材制作需求。

## 7 冷启动末段错位修复（2026-10-21）

真实 Electron 逐帧复现：启动层内固定定位的人物和透视平面产生文档滚动溢出。第 6 秒卸载启动层时，滚动条消失，1440px 窗口中的 AppSurface 从 1430px 突然扩为 1440px；输入框横移 5px，主页人物横移约 11.2px。此时 AppSurface 的 transform 已经是 none，因此问题来自文档可用宽度变化。

仅在 StartupStage 尚未 done 时设置 `overflow:clip`，将离开舞台的画面裁剪在舞台内，避免产生文档滚动区域。使用 clip 保留原有定位和滚动容器语义；done 后恢复 visible，不影响日常页面和浮层。动画时间线、人物锚点与媒体交接不变。

验证基线：`e0b9705` 加当前未提交工作区，macOS arm64、Node.js 22.22.3、Electron 44.0.0。没有提交或清理工作区内其他改动。所有应用验证均使用脚本新建的临时 `HEMI_USER_DATA_DIR`，仅写入测试皮肤、窗口尺寸和引导完成状态。

验证命令与结果：

- `npm run build`：通过 TypeScript 和构建；仍有现有的大 chunk 提示。
- `node scripts/check-spacing.mjs`：通过。
- `node --check scripts/verify-appearance-startup.mjs`、修改文件的 `git diff --check`：通过。
- Vite：`HEMI_DEV_PORT=5193 npm run dev:renderer`；`VITE_DEV_SERVER_URL=http://127.0.0.1:5193 node scripts/verify-appearance-startup.mjs` 可运行全部案例，也可在命令尾追加案例名分批运行。
- 构建 renderer：`node scripts/verify-appearance-startup.mjs`，使用相同案例和断言。

两种 renderer 均覆盖 blue-wide（1440px）、purple-mid（980px）、orange-breakpoint（880px）、gold-narrow（768px）、red-compact（560px）。每帧检查文档没有额外滚动区域、布局宽度不变，展开后的 AppSurface、顶栏、输入框和人物在交接两侧的矩形最大差均为 0px；检查完整 6 秒演出、前景影片释放、输入可用及 renderer/资源错误。另在开发版 blue-wide、构建版 red-compact 检查 done 后裁剪恢复 visible。

桌面焦点切换会按现有规则提前结束演出；这类运行被自然完成断言拒绝，不作为末段通过证据。为完成不受桌面操作影响的几何采样，开发版 blue-wide 的最终记录及构建版 orange-breakpoint、gold-narrow、red-compact 使用 `HEMI_STARTUP_HOLD_FOCUS=1`，仅在测试进程内固定原生 isFocused 返回值。其他最终案例使用真实焦点，开发版 blue-wide 另有真实焦点完整复现与修复后采样。固定焦点案例不用于证明原生焦点取消逻辑。

逐帧 JSON 和交接前后截图：`.visual/workflow/vision/startup-handoff/{dev,built}/<case>/`；缺陷复现：同目录 `before-complete-1440/`。人工复核了 1440、768、560px 截图，未见新增裁切或错位。原生窗口最小宽度为 560px，因此未测 375px；当前主题仅支持 light，未测 dark。Windows 未覆盖，本轮未运行与该 CSS 修复无关的完整业务测试。
