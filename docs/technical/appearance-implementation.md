# Hemi 人物主题与启动动画实施方案

日期：2026-10-21。依据：[产品需求](../requirements/appearance-and-skins.md)、[已确认完整演示 v3](../design/appearance-skins/motion-preview-v3/README.md)。本文件收敛此前设计提案，作为本轮生产实现及验证记录的入口。

## 1 交付范围

交付经典、晴海蓝、月见紫、焦糖橙、蜜糖金、围巾红六款浅色皮肤。设置按钮正上方增加 Shirt 换肤入口，392px 浮层内两列六卡，点击即保存并保持面板打开；不增加人物背景开关。保留 Hemi 的布局、字号、间距、圆角、模型设置和业务实例。

人物皮肤包括主题配色、卡片、头像、固定侧栏水印、右侧主页人物和左侧题字、冷启动演出和主页局部动画。晴海蓝复用已确认的眨眼/发梢/衣料动画；其余人物从现有透明母版导出局部发梢、围巾或衣料参数动画。没有把正式 Live2D/Cubism 工程列为应用运行时依赖，也不以转头或挥手冒充已完成动作。

## 2 权威状态与持久化

外观独立存于 `userData/appearance.json`，仅包含 `{schemaVersion:1,skinId,mode:'light'}`。新装或升级缺文件默认经典，保留已有合法选择。未知版本、损坏或读失败回退经典但不覆盖原文件；用户主动选择时先备份异常文件再原子替换。

共享注册表从 `skins.config.json` 读取皮肤顺序、配色、题字及媒体定义，校验后供主进程和 renderer 共用。主进程服务初始化一次，通过异步串行队列提交；同目录独占临时文件、flush、rename 成功后才更新内存和广播。失败保留旧状态，队列可继续处理后续请求。相同 requestId 在有界缓存内去重，冲突返回明确错误；蓝→紫→蓝按出队时状态判断，保留最后选择。

快照使用每进程唯一 sessionId 与递增 revision，重启不比较旧进程 revision。renderer 只显示已提交选择，保存中和错误是独立状态；资源解码和提交回执均带代次，迟到回调不得恢复旧皮肤。

## 3 固定 IPC 与窗口同步

新增固定 appearance get/set/bootstrap/changed/applied/visual-ready/activity 接口。preload 在页面脚本前安装事件缓存，bootstrap 内部同步读取已初始化内存，禁止磁盘 IO；页面只获得固定 getter、提交和取消订阅方法。

所有 `loadRenderer` 创建的 Hemi 自有顶层窗口登记 windowMode、webContents 和预期 renderer URL。权限同时检查登记、顶层 frame 和 URL；写入仅主窗口，外部登录视图和任意子 frame 不获得权限。切换只广播登记窗口，主窗口原生背景随已提交皮肤更新，三类悬浮窗口原生底始终透明。

窗口以 ready-to-show、当前版本颜色 applied 和 visual-ready 协调首次显示。恢复显示时补发当前快照，旧版本回执不得使旧皮肤显示。主窗口每次创建只授予一次冷启动资格，renderer reload、隐藏恢复、普通换肤和悬浮窗口不重复长片头。原生 show/hide/focus/blur/minimize 状态经固定 activity 事件传到 renderer，避免 backgroundThrottling=false 时隐藏窗口继续解码。

## 4 首帧与颜色

head 先加载无依赖外部 bootstrap，写入 html 的 skin/mode/window 属性，再载入生成颜色 CSS 与现有模块。生成规则使用高于基础 :root 的皮肤选择器，避免主包后加载 tokens.css 覆盖。开发页面使用 public URL；构建时 Vite 将其重写为 file 页面可用的相对 URL。

文档级 runtime 在 React 前初始化，统一订阅和合并快照；React 通过 useSyncExternalStore 读取。颜色放在 html，body Portal 和 Flowgram 独立 root 继承，不移动 Portal、不用主题 key 重挂。经典保留现有颜色；主题强调与成功/运行/警告/危险语义分离，原有几何 token 不变。

配置统一生成 public CSS、early bootstrap、SkinId 类型、静态素材 import 与字节/hash 清单。开发和构建前自动更新，`--check` 可独立检查漂移；素材和配置全部校验成功后才写生成文件。运行时不访问 docs、桌面路径或远程字体，不接受用户 CSS/脚本路径。题字在主页、冷启动及各窗口宽度的字号同样来自配置。

## 5 主窗口分层与真实 UI

```text
StartupStage
├─ Scene/Foreground       仅冷启动期间存在的场景、题字和人物
├─ AppSurface             同一份真实 React UI；交接后 transform:none
│  ├─ ThemeBackdrop       固定人物/场景层，pointer-events:none
│  └─ Home                现有配置加载、引导、设置、会话、工作流
└─ Skip/Waiting           可见跳过与真实准备状态
```

经典保留简短品牌准备态。人物冷启动采用已确认 6 秒时间线：人物入场、题字显现、真实 UI 展开；5.1 秒先对齐前景和背景人物原点/尺寸，再交接到主页。背景与前景共用素材时间，交接不重置人物循环，结束卸载前景资源。

BOOT_VISUAL_READY 与 APP_READY 分开：前者允许原生窗口展示同主题舞台，后者由现有 Home 初始化完成投影。页面在后台照常加载，StartupStage 不创建第二份 Home，也不改会话恢复。交接前 AppSurface inert，阻挡 body Portal 的指针/键盘，不搬节点；交接后恢复可操作性和焦点。Esc/跳过可达；未就绪时进入明确准备态，超时提供重试，不把未加载 UI 伪装为可操作。

换肤、减少动态效果、失焦/隐藏、资源错误和缩放可取消当前演出代次并收口到当前皮肤静态场景。迟到媒体事件不会重播旧角色或重新锁住页面。

## 6 主页背景与资源生命周期

右侧人物、左侧 Smile/Sister/Suspended/Sweet/Stupid 与名称沿用确认稿。阅读态保留淡色题字，放在正文后方，并用阅读列渐变遮盖降低正文区域的干扰；设置、工作流等内容表面保持清晰。侧栏底色进一步混白，人物水印透明度为 6.5%。侧栏水印是局部绝对层，不占列表高度；滚动、抽屉和 50 条会话不改变水印锚点。

当前业务状态派生主页/阅读/其他页面、草稿/通话状态；焦点、原生窗口 activity、visibility、reduced-motion 决定是否播放。空主页输入聚焦或有草稿、失焦/隐藏时暂停并保留当前帧，恢复只继续主页循环。进入对话流（历史、回复中、任务）或其他业务页后，CharacterMedia 使用 staticOnly，不创建 video；模式切换时只重建人物媒体节点，清除旧视频 src 并 load 释放解码器，现有业务 DOM 保持。新建对话空主页和冷启动使用 motion 模式；冷启动即使恢复的是历史会话也照常演出，交接结束再切为静态图。没有永久 rAF 或轮询来维持静止状态。

人物制作采用已验证的局部参数网格离线导出透明 VP9，应用仅本地视频解码。普通卡片、头像和静态人物另行压缩，未选择皮肤不预解码高清影片。媒体失败使用同人物静态 WebP，应用功能继续可用。

## 7 验证与验收

纯逻辑测试覆盖注册表/生成漂移、严格 schema、读失败保护、备份失败、原子保存失败、队列恢复、no-op、请求冲突、快速返回原皮肤和快照乱序。IPC 校验与窗口首帧须在实际 Electron 中验证，不能只用 mock。

本次影响文档首帧、全局颜色和 UI 生命周期，实施完成后运行完整 npm test、npm run build、spacing 检查，并使用全新 HEMI_USER_DATA_DIR 在 Vite 开发 renderer 和构建 renderer 中验证实际桥接、重启保存、六款切换、悬浮面、冷启动/跳过/真实输入、阅读暂停和工作流保持。视觉检查沿用截图→检查→修正流程。依赖不变则无需重生第三方库存；如增 renderer 依赖，按仓库要求生成并复核 notices。

记录基线 commit、未提交工作树、macOS/Node/Electron 环境、实际命令与证据。Windows 结论必须由 Windows 实机给出；当前平台无法覆盖的项明确列为剩余验证，不以截图或逻辑测试替代。

## 8 首次实现记录

本轮已完成代码、六款本地物料和文档，未提交或发版。测试基线为 `559397ac57bdd85893be3380e55e03f2d1501fa3` 加本轮工作树，保留进入本轮之前的设计修改。环境：macOS 26.5.1 / Apple M4 / arm64，命令行 Node 22.22.3，Electron 44.0.0（内嵌 Node 24.18.1），React 19.2.6，Vite 8.0.16。没有新增依赖或修改锁文件。

| 检查 | 实际结果 |
| --- | --- |
| `npm test` | 1502 / 1502 通过，含新增 16 项存储、队列与 schema 测试 |
| 最终专项 Node 测试 | 外观 16 项与 native gate 2 项，共 18 项通过 |
| `npm run build` | TypeScript 与 renderer 构建通过；public 首帧文件正确重写为相对 URL；仅既有大分块提示 |
| `node scripts/generate-appearance.mjs --check` | 注册表/生成 CSS 一致 |
| `node scripts/check-spacing.mjs` / `node scripts/check-native.mjs` | 通过 |
| `git diff --check` | 通过 |
| Vite 真实 Electron | 48 项通过；无未捕获 renderer 错误 |
| 构建真实 Electron | 48 项通过；无未捕获 renderer 错误 |
| 资源清单 | 15 个文件字节数与 SHA-256 一致；五路影片均在 Electron 实际解码出透明与不透明像素 |
| 隔离 Electron 冒烟 | 退出码 0，取得 HEMI_SMOKE_RESULT；引导、未配置模型/语音的错误路径、悬浮球/字幕、尺寸与拖动检查完成 |

两种模式均使用独立临时 HEMI_USER_DATA_DIR，只生成 50 条验证会话和引导完成状态，没有复制个人数据或配置模型凭据。用真实文件系统只读目录注入保存失败；用无法加载的视频地址验证静态回退；用未来 schema 验证启动不覆盖和主动备份修复。

| 普通换肤测量 | Vite | 构建版 |
| --- | --- | --- |
| 可见主窗口交替提交样本 | 32 | 32 |
| 主进程 commit → 已绘制 applied 的 P95 | 40.4ms | 40.1ms |
| 单次真实卡片 pointerdown → 已提交广播 | 12.0ms | 11.5ms |

P95 样本在初次资源展示后采集，不含磁盘提交或冷启动影片时长，满足需求的 ≤200ms 预算；单次真实点击测量另列，不能将一次点击当作点击耗时的 P95。数据是本机观察值，不外推到 Windows 或低性能机器。

回归覆盖：六卡选择/当前态/键盘/点外/真实保存错误，快速蓝→紫→蓝与 no-op，草稿及 DOM 保留，50 条会话和固定水印，当前阅读保留，输入/草稿/阅读/隐藏/减少动态效果的暂停与续播，五款影片 alpha，真实媒体失败回退，Flowgram 首次懒加载后的独立 root 和未保存工作流保留，订阅清理、子 frame 无桥、未登记窗口和三类悬浮窗口写入被拒、跨窗口配色同步，reload 不重播、重启恢复/冷启动/跳过、未来配置保留/修复，以及 1180/880/560px 面板可达性。截图人工复核了六款配色、文字与人物、满列表、浮层、工作流和窄窗。

复现命令（仓库根目录）：

```sh
HEMI_DEV_PORT=5317 npm run dev:renderer
VITE_DEV_SERVER_URL=http://127.0.0.1:5317 node scripts/verify-appearance.mjs
npm run build
node scripts/verify-appearance.mjs
npm test
node scripts/check-spacing.mjs
node scripts/check-native.mjs
HEMI_USER_DATA_DIR=$(mktemp -d /tmp/hemi-appearance-smoke.XXXXXX) HEMI_SMOKE_TEST=1 npx electron .
```

回归脚本可用 HEMI_DESIGN_PLAYWRIGHT_MODULE 指定本地 Playwright。截图和原始数据位于本地 `.visual/workflow/vision/appearance-implementation/{dev,built}/`，脚本在结束或失败时关闭自己的 Electron 实例。视觉复核说明位于 `.visual/workflow/vision-report-appearance-implementation.md`。

## 9 扩展与回退

新增人物只需在 `src/shared/appearance/skins.config.json` 添加定义，并放入配置指定的 WebP / VP9 WebM 物料；运行开发或构建命令时自动更新类型、白名单、颜色、素材映射及清单。接入步骤、配置字段和回归命令见 [新增皮肤指南](adding-a-skin.md)。普通配色调整同样只改配置。正文排版继续由既有 tokens/styles 管理。

用户选择经典即移除人物与影片，恢复原有基础颜色；不删除任何业务数据。出现写盘或备份失败时保持上一次成功选择，并允许重试。升级不主动创建/覆盖 appearance.json，已有合法选择按 schema 保留。生产运行只读取打包资源，离线导出工具和 docs 母版不进入应用运行链路。

## 10 明确的剩余验证

- Windows 实机：标题栏/透明窗口、字体回退、VP9 alpha、文件替换与性能；目前没有 Windows 环境，不能宣称跨平台实机已通过。
- 未用真实模型凭据拨打通话或执行在线任务；已有完整单测/集成测试和隔离冒烟通过，UI 换肤不重建业务实例，但长时间真实通话、录音、播报与任务运行仍需随产品回归观察。
- 当前人物为已确认的局部参数动画；正式 Cubism 拆层、绑定、转头和挥手需另行制作，不是本轮运行时依赖。
- 未做逐帧像素级对照、系统级首帧录屏或长时间内存浸泡；当前证据为实际显示就绪链路、交互状态/媒体检查与截图复核。


## 11 阅读态背景优化（2026-10-21）

按本轮反馈调整三处：历史侧栏底色以 48% 主题 rail 与白色混合，人物水印透明度从 13% 降到 6.5%；阅读态恢复左侧题字，置于正文后方，通过阅读列渐变遮盖控制干扰；对话流直接显示静态 WebP，不创建视频播放器。冷启动保留双层动画，若恢复的是历史对话，在演出结束时一并释放背景影片；返回新建对话空主页后重新创建当前人物播放器。输入聚焦/草稿、失焦与减少动态效果的暂停规则保持。

此次只重建人物媒体节点，业务 Home、会话、工作流和输入框均保持现有实例。旧影片卸载时 pause → remove src → load，验证其脱离 DOM、src 为空且 readyState 回到 0。阅读中逐款换肤也不请求影片。

验证基线为 `559397ac57bdd85893be3380e55e03f2d1501fa3` 加本轮未提交工作树；环境延续上节 macOS / M4 / Node 22 / Electron 44，使用全新临时 HEMI_USER_DATA_DIR 和生成的验证会话。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 类型与 renderer 构建通过；只有既有大分块提示 |
| `node --test src/renderer/src/native-gate.test.mjs` | 2 项通过 |
| `node scripts/check-native.mjs` / `node scripts/check-spacing.mjs` | 通过 |
| 生成 CSS 检查 / `git diff --check` | 通过 |
| `VITE_DEV_SERVER_URL=http://127.0.0.1:5317 node scripts/verify-appearance-reading.mjs` | 25 项通过，无未捕获 renderer 错误 |
| `node scripts/verify-appearance-reading.mjs`（构建 renderer） | 25 项通过，无未捕获 renderer 错误 |

专项覆盖冷启动双路播放、落到历史后的静态图、五款阅读题字、阅读切肤零影片请求、50 条列表和固定淡水印、草稿和输入实例保留、980/560px 阅读、新建对话继续播放，以及再次进入对话后旧解码器释放。实际截图复核了 1440px 对话正文/代码/列表和 980/560px 窄窗；没有重新运行与本次改动无关的完整业务测试。

证据位于本地 `.visual/workflow/vision/appearance-reading/{dev,built}/report.json` 及相邻 PNG，视觉报告为 `.visual/workflow/vision-report-appearance-reading.md`。原 48 项完整主题验证是上一版历史记录，本节 25 项是此次改动后的针对性验证。Windows 和正式安装包验证边界保持不变。

## 12 设置页配色补齐（2026-10-21）

设置页独立的白色根表面使透明顶栏、图标栏显示为白色，而二级分类栏仍显示主题色，外框出现断层；分类选中文字也仍使用深灰。补齐仅限非经典皮肤的三条外观规则：设置根表面使用 `--bg-rail`，使顶栏与两级导航底色连续；内容画布使用 24% `--bg-subtle` 混合白色，分组和输入框保留实白表面；桌面导航与窄窗抽屉的当前分类统一使用 `--g-100` 底色和 `--accent-text`。布局、字体、业务状态和警告/错误语义色保持现有实现，设置页不创建人物影片播放器。

验证基线为 `e0b97054cf2845736c52dd434422a2d9430cd890` 加本轮未提交 CSS；同工作区已有其他任务的未提交改动，未纳入本次修改范围。环境为 macOS 26.5.1 / arm64 / Node 22.22.3 / Electron 44.0.0，Vite 开发 renderer 与构建 renderer 各使用全新临时 `HEMI_USER_DATA_DIR`。

`npm run build`、`node scripts/check-spacing.mjs`、`node scripts/check-native.mjs`、生成文件一致性检查（build 的 prebuild）和 `git diff --check` 均通过。此次为局部 CSS 修复，没有运行完整业务测试或添加依赖。

真实窗口专项检查两种模式各 38 项通过，无未捕获 renderer 错误：通过实际换肤入口选择六款皮肤；检查顶栏/图标栏/分类栏底色连续、分类文字与图标、启用开关及白色表单表面；遍历全部六个设置分类；验证换肤保留当前设置实例和未保存的供应商名称；检查 980px 设置页、560px 分类抽屉与分类跳转、无横向溢出且没有 video 节点。经典页的计算颜色及布局尺寸与修改前快照相同。

本地复现：`HEMI_DEV_PORT=5317 npm run dev:renderer`，随后运行 `VITE_DEV_SERVER_URL=http://127.0.0.1:5317 node .visual/verify-appearance-settings.mjs`；构建后运行 `node .visual/verify-appearance-settings.mjs`。专项脚本与截图为本地验证物料，位于被 Git 忽略的 `.visual/`；报告及截图位于 `.visual/workflow/vision/appearance-settings/{before,dev,built}/`。视觉复核了宽窗配色、模型草稿表单和窄窗抽屉。未覆盖 Windows、正式安装包或在线模型调用，不能据此宣称这些环境通过。

## 13 单一皮肤配置与交互色（2026-10-21）

将原来的位置数组、人物资源映射、类型 ID、首帧白名单、生成器固定顺序和按人物 ID 写的字号分支收敛为 `skins.config.json`。共享 `createSkinRegistry` 校验配置并派生完整颜色；开发/构建入口自动生成 CSS、bootstrap、类型、静态 import 和逐文件 SHA-256 清单。生成器在全部配置和素材通过校验后才写文件，内容未变化则不写。原五款的离线导出工具也复用同一清单生成器。新增皮肤不再修改业务组件、IPC 或页面 CSS，步骤见 [新增皮肤指南](adding-a-skin.md)。

hover 改为不透明的主题混色：人物皮肤默认为 16% 主色混白，选中 24%，选中后 hover 30%；经典通过自己的中性色配置使用 8/12/16%。会话列表移除原先过淡的单独混色覆盖，分类导航、图标栏、辅助按钮使用统一交互变量，皮肤卡片使用自身配置派生的 hover 色并加深内描边。表单背景、业务状态语义色和现有布局保持。

验证基线为 `e0b97054cf2845736c52dd434422a2d9430cd890` 加本轮工作树。环境为 macOS 26.5.1 / arm64 / Node 22.22.3 / Electron 44.0.0；测试使用独立临时 `HEMI_USER_DATA_DIR`，没有模型凭据。工作区同时存在其他任务的修改，本轮没有修改它们。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 1524 / 1524 通过；在本轮基础改造后运行 |
| 最终外观专项 Node 测试 | 21 项通过；含配置扩展、无效配置、缺失/空文件和五种生成输出一致性 |
| `npm run build` | 本工作区与新增皮肤隔离副本均通过；仅大分块提示 |
| 生成漂移、spacing、`git diff --check` | 通过 |
| 现有六款真实 Electron，Vite / 构建 | 各 56 项通过，无未捕获 renderer 错误 |
| 临时第七款真实 Electron，Vite / 构建 | 各 64 项通过，无未捕获 renderer 错误 |
| 全仓 `check-native` | 最后一次发现并行工作新增的 `styles/turn-activity.css:26` 焦点环没有 `html.kb-nav`；该文件不在本轮改动范围，保留给原任务处理 |

第七款验证在临时项目副本中只追加 `trial-mint` 配置和三份新文件名的 WebP/WebM（复用现有蓝色人物作为测试物料），没有手改副本的类型、bootstrap、资源导入或业务代码。普通 `npm run build` 自动完成注册；实际卡片选择、主进程提交、保存、重启后 bootstrap、冷启动双路影片、主页影片、阅读静态图、1440/980/560px 自定义题字和抽屉 hover 全部通过。该测试皮肤没有加入正式配置。

本地回归为 `VITE_DEV_SERVER_URL=http://127.0.0.1:5317 node scripts/verify-appearance-catalog.mjs` 和构建后的 `node scripts/verify-appearance-catalog.mjs`；可通过 `HEMI_APPEARANCE_APP_ROOT` 指向隔离的扩展项目。证据位于 `.visual/workflow/vision/appearance-catalog/{current-dev,current-built,extension-dev,extension-built}/`。截图复核了选中/hover 的区别、换肤面板、人物与题字、设置页和窄窗抽屉。没有新增 renderer 依赖；Windows、正式安装包与真实在线业务仍不在本轮验证范围。
