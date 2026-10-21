# PDF 与 Office 对话附件

支持 `.pdf`、`.docx`、`.xlsx`、`.pptx`，单份文档最多 20 MiB；单条消息沿用最多 3 个附件。旧版 `.doc`、`.xls`、`.ppt` 按本次用户确认不接入。

“＋ → 选中文件”、拖入文件和粘贴图片统一走本条消息的附件登记，发送后清空准备区。文档共用本地文字提取器，正文进入已有来源封装、文本预算和防注入边界。图片仍沿用原看图链路。已有工作对象的读取、刷新和移除继续使用原接口。

## 展示与数据

- PDF 使用 PDF.js 原文页面，支持翻页、缩放和中文 CMap，扫描图片也可预览。
- Word 使用 docx-preview 保留纸张、段落、表格、嵌入图片及 section 分页。
- Excel 展示只读单元格网格和工作表标签，保留列标、空列、日期和百分比；公式显示已保存的计算结果，悬停可看公式，不执行重算。
- PPT 使用 PPTX renderer 按原布局渲染静态幻灯片，支持翻页与缩放。
- 原文与提取文字可切换；后者显示实际用于模型上下文的读取范围和错误提示。
- 输入框附件按用户截图及 ZCode `ConversationComposer.tsx`：文件为 48px 高的双行卡片，显示彩色文件类型图标、文件名和大写扩展名；图片为 48px 方形缩略图，缺少缩略图时显示图片文件图标。文件并排排列，空间不足自动换行，长文件名省略；悬停或键盘聚焦显示移除按钮。用户进一步明确后，发送前后共用 `AttachmentCard`；已发送附件独立位于消息文字上方，保留完整缩略卡片，纯附件消息没有空白气泡。

交互参考本地 ZCode `aac4755666d09fdcd70272fcf063c077a639015f` 的 `packages/ui/src/previewPaneOfficeDocxContent.tsx`、`previewPaneOfficeXlsxContent.tsx`、`presentation/pptxRendererPreviewEngine.ts` 和 `ChatMediaAttachmentPreviewDialog.tsx`。Hemi 的组件为独立实现，未复制 ZCode 组件源码。

解析在受内存与超时限制的 worker 中完成，重新读取仍校验文件大小。Office ZIP 限制条目数和展开大小；原文读取仅接受登记过的会话／附件身份。Word、PPT 原文 DOM 位于禁用脚本的 sandbox iframe，无 preload API；文档链接不导航主 renderer。预览切换会撤销旧异步结果并释放 PDF／幻灯片资源。

## 验证记录（2026-10-21）

验证基线为 `e0b97054cf2845736c52dd434422a2d9430cd890` 加本次未提交改动；保留工作区原有语音入口改动。环境：macOS 26.5.1 arm64、Node 22.22.3、Electron 44.0.0。应用验证每次使用新的临时 `HEMI_USER_DATA_DIR`，结束后删除。样例均由本项目生成，包含中文、表格、嵌入图片、多页、脚本链接、扫描图片和加密 PDF。

通过的命令：

```sh
npm ci
node --test --test-reporter=dot src/main/composer/documents.test.mjs src/main/context/work-context.test.mjs src/main/composer/attachments.test.mjs src/main/composer/references.test.mjs
npm run build
node scripts/generate-renderer-notices.mjs
node scripts/generate-renderer-notices.mjs --check
node scripts/check-spacing.mjs
node scripts/verify-release-materials.mjs
git diff --check -- <本次附件相关改动文件>
node scripts/verify-document-attachments.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5197 node scripts/verify-document-attachments.mjs
```

40 项相关测试通过。开发 renderer 和构建 renderer 各通过 10 项真实 Electron 流程检查：拖入、原文／文字预览、内嵌图片、翻页、缩放、多表切换、发送到本地 SSE provider 的真实文本请求、发送后清理、历史预览、中文 PDF、Excel `@` 引用、脚本链接阻断、快速切换、关闭后重读原文件和扫描件文字提示。覆盖 375／768／1440 宽度，无页面级横向溢出；Excel 横向滚动保留在网格内。

截图和机器记录位于 `.visual/document-attachments/{built,dev}/`。无未处理页面异常或非预期 console error；Chromium 对禁用脚本的 `about:srcdoc` 产生 sandbox 拒绝日志，原始日志保留在检查记录中。渲染器许可证清单包含 154 个组件，无未解决声明；预捆绑组件另行补全。未引入原生 canvas／OCR／WASM 依赖。

## 当前边界

模型上下文目前提取文档文字和单元格，不分析内嵌图片、图表或扫描件，也不完整还原复杂阅读顺序。每对象沿用 6000 字、同批文本封装 12000 字预算，超长明确提示截断；扫描件文字读取提示 OCR 尚未接入。原文预览与模型读取能力分别呈现。

Excel 预览为基础网格，未完整复现字体、条件格式、合并单元格、绘图或打印版式；最多 50 个可见工作表，每表最多 500 行、每行 64 个非空单元格，并限制总预览文本。Word、PPT 的复杂版式遵循对应渲染库能力；PPT 不播放动画和嵌入视频。

未测试 Windows、实际 Microsoft Office／LibreOffice 人工对照、外部真实模型和安装包发版；本地 provider 用于验证实际请求内容。原生文件选择器由测试替身选择路径，后续使用真实解析器；未操控用户的 Finder。UI 使用当前浅色主题，未新增深色主题。未运行全量测试或无关设备回归。

收尾时工作区出现其他并行的更新模块改动；这些改动未纳入本次验证，也未修改。全工作区 `git diff --check` 此时报告 `src/main/services/updater.test.mjs` 文件尾空行；附件相关改动的 scoped diff 检查通过。上文构建和应用结果对应本次附件实现的已测工作区状态。

## 附件卡片补充验证（2026-10-21）

针对用户提供的 ZCode 卡片截图，修正此前只替换文字徽标、没有对齐卡片结构的问题。同一基线 `e0b97054cf2845736c52dd434422a2d9430cd890` 加当前未提交改动，环境仍为 macOS arm64、Node 22.22.3、Electron 44.0.0。

`npm run build`、`node scripts/check-spacing.mjs`、`node scripts/generate-renderer-notices.mjs --check`、本次文件的 `git diff --check` 与原生 UI 规则检查通过。没有增加 npm 依赖；5 个 Material Icon Theme SVG 保留 MIT 原始版权、许可和来源哈希，并在构建产物 `licenses/` 中核对。

```sh
node scripts/verify-document-attachments.mjs --cards
VITE_DEV_SERVER_URL=http://127.0.0.1:5197 node scripts/verify-document-attachments.mjs --cards
```

两种 renderer 各通过 7 项真实 Electron 检查：＋ 文件选择／取消、原生选择器格式过滤、48px PDF 卡片与图片回退、真实缩略图、键盘移除、1440／768／375 换行和省略、实际发送与历史 PDF 预览、PPTX 类型图标、照片与 PDF 混合发送、纯附件消息没有空白气泡。测试仅替换操作系统文件选择器的返回值，后续 UI、preload、composer IPC、附件库、解析器及 provider 请求均使用实际实现，核对未创建持久工作对象。照片混发使用声明支持图像的本地测试 provider，无外部模型调用。无页面异常或 console error。每次使用独立临时 userData，结束关闭测试进程并删除数据。截图、几何数据和机器记录位于 `.visual/attachment-cards/{built,dev}/`。

卡片结构参考用户截图与来源源码，发送后按用户要求也保留同款卡片；字体、边框和背景沿用 Hemi token。参考截图与实测截图都按 2x 原始比例比较，以白色画布补齐不同的卡片宽度，没有拉伸。默认 0.5% 像素门限未通过，差异约 10.56%，主要是字体宽度、边框、图标色值和截取边缘；不声称逐像素一致，详见 `.visual/workflow/vision-report-attachment-cards.md`。

初次全局原生门禁与 diff 检查曾报告其他并行改动 `styles/056-tools.css` 的问题；本次没有修改该文件，收尾时 `node scripts/check-native.mjs` 复查已通过。附件文件的 scoped diff 检查通过。本轮选择器入口与共享卡片修正另运行 `node --test --test-reporter=dot src/main/composer/attachments.test.mjs`，10 项通过，没有重跑此前全部 40 项解析测试、全量测试或安装包发版。
