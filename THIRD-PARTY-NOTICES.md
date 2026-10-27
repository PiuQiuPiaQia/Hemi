# 第三方组件与许可声明

Hemi 自有代码采用 MIT（根 [LICENSE](LICENSE)）；本文件列出随源码与安装包分发的第三方组件及其原许可。
**本清单不改变任何第三方组件的原许可与版权**——MIT 只覆盖 Hemi 有权授权的自有代码，不含这些组件，
也不含它们内嵌的原生库。各条目记录：用途、精确版本／commit、是否修改、源码地址、声明在分发产物中的位置。

「Hemi」名称、应用图标等品牌素材不在根 MIT 的授予范围内；第三方素材的权利按其来源许可另行判断。

来源与许可文件见 [third-party/README.md](third-party/README.md)。已补 Cua／UBRN 的固定源码版本、原始通知和 MPL 全文，
以及从实际 Vite 输出生成的前端清单。Electron／Chromium 的原始许可随安装包分发；原生传递组件的来源、原始许可文本及重链材料见 third-party/。

## 复制进源码的第三方代码（vendor）

| 组件 | 版本／基线 | 用途 | 修改 | 源码 | 声明位置 |
| --- | --- | --- | --- | --- | --- |
| shadcn 样式 | npm `shadcn@4.18.0` 的 `dist/tailwind.css` | Tailwind 状态／动画样式 | 原样保留；未包含 CLI | https://github.com/shadcn-ui/ui | [完整 MIT](third-party/licenses/shadcn-MIT.txt)；来源及字节哈希见 third-party/sources.json |
| Material Icon Theme | ZCode `aac4755666d09fdcd70272fcf063c077a639015f` 中的 PDF、Word、Excel、PowerPoint、图片 SVG | 对话附件文件类型图标 | 5 个 SVG 原样保留；ZCode 未记录最初图标导入版本 | https://github.com/material-extensions/vscode-material-icon-theme | [完整 MIT 与原始版权](src/renderer/public/licenses/Material-Icon-Theme-MIT.txt)，随 renderer 分发；[来源与字节哈希](third-party/file-icons-sources.json) |
| FlowGram engine（bytedance/flowgram.ai） | commit `2ee4a9d2aaf11850276b7d72eeb0ad5bed0e2948`（＝ npm `@flowgram.ai/runtime-js@1.0.16`） | 工作流执行引擎子集（059 vendor） | 手工转写为 .mjs；与上游偏差以文件头 `VENDOR-PATCH` 标注 | https://github.com/bytedance/flowgram.ai | [vendor 目录 LICENSE](src/main/workflows/vendor/flowgram-engine/LICENSE)（MIT，© Bytedance Ltd.）＋各文件头注 |

## 运行时依赖（进入安装包）

| 组件 | 版本 | 许可 | 用途 | 修改 | 源码 | 声明位置 |
| --- | --- | --- | --- | --- | --- | --- |
| uiohook-napi（包装层） | 1.5.5 | MIT | 全局 Option 长按说话（全局键鼠钩子） | 未修改 | https://github.com/SnosMe/uiohook-napi | npm 包内 LICENSE；内嵌 libuiohook 见下行 |
| libuiohook（经 uiohook-napi 静态链接） | 随 uiohook-napi 1.5.5 内嵌（binding.gyp 定义为 static_library） | **LGPL-3.0-or-later** | 同上（底层 C 库） | Hemi 未修改；包含 wrapper 上游补丁 | https://github.com/kwhat/libuiohook | [GNU 许可全文](third-party/licenses/LGPL-3.0.txt)、[对应源码与重链说明](third-party/uiohook-relink.md)；源码归档随应用与 Release 分发，macOS arm64 已实测重链与加载 |
| @trycua/cua-driver | 0.32.0 | MIT | 桌面操控（036 cua 后端，进程内调用） | Hemi 未修改 | [固定提交](https://github.com/trycua/cua/tree/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver) | npm 包未附完整 MIT 文本；现补在 [Cua-MIT.txt](third-party/licenses/Cua-MIT.txt) |
| @trycua/cua-driver-darwin-arm64／win32-x64-msvc | 0.32.0 | MIT AND MPL-2.0 及其内嵌组件许可 | 桌面操控原生运行时 | Hemi 未修改 | 同上；`node-runtime-NOTICE.md` 随包分发 | npm 包内通知；[上游 Rust 组件通知](third-party/licenses/Cua-Rust-NOTICES.md)及 [native-components.json](third-party/native-components.json)；内嵌 Inter 字体保留 [SIL OFL](third-party/licenses/Inter-OFL.txt) |
| @ubjs/core、@ubjs/node 及本机平台包（经 cua-driver 引入） | 0.31.0-3 | MPL-2.0 | cua 原生运行时依赖（typescript／runtimes/napi） | Hemi 未修改；Cua compatibility runtime 的修改由上游构建脚本提供 | [对应源码与修改脚本](third-party/README.md)；core 为 `49bc591`，node／Cua 源码输入为 `dcb5c4a` | [MPL 全文](third-party/licenses/MPL-2.0.txt)、[UBRN 原始通知](third-party/licenses/UBRN-NOTICE.txt)和包内 node-runtime-NOTICE.md |
| @earendil-works/pi-coding-agent、pi-ai、pi-agent-core、pi-codemode、pi-mcp、pi-telemetry、pi-tui | 1.3.0 | MIT | Agent 会话与工具运行时（主／子 agent） | Hemi 未修改 | [固定源码](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0) | [Pi MIT 全文](third-party/licenses/Pi-MIT.txt)；pi-mcp 包内 LICENSES 的第三方通知继续保留 |
| playwright-core | 1.64.1 | Apache-2.0；内嵌组件各自许可 | 独立无头浏览器后端 | 未修改；使用本机浏览器程序，不随包分发浏览器 | https://github.com/microsoft/playwright | npm 包 LICENSE、NOTICE、ThirdPartyNotices 与 lib 许可侧文件；[来源及 WebP WASM 清单](third-party/playwright-sources.json) |
| ws | 8.21.3 | MIT | WebSocket（浏览器扩展桥） | 未修改 | https://github.com/websockets/ws | npm 包 LICENSE |
| undici | 8.10.2 | MIT | Bot 的 HTTP(S) 代理与原生 fetch／SDK 网络通道 | 未修改 | https://github.com/nodejs/undici/tree/v8.10.2 | [原始 MIT 与版权](third-party/licenses/Undici-MIT.txt)，同时保留 npm 包 LICENSE |
| vscode-jsonrpc | 10.0.0 | MIT | Windows Bot 持久控制通道的 JSON-RPC 消息编解码 | 未修改 | https://github.com/microsoft/vscode-languageserver-node/tree/main/jsonrpc | npm 包 License.txt |
| @peculiar/x509 | 2.2.0 | MIT | Bot 设备入口的 X.509 证书编码，使用 Node 原生 WebCrypto | 未修改 | https://github.com/PeculiarVentures/x509 | [原始 MIT 与版权](third-party/licenses/Peculiar-X509-MIT.txt)，同时保留 npm 包 LICENSE |
| reflect-metadata | 0.2.2 | Apache-2.0 | X.509 编码依赖的运行时元数据支持 | 未修改 | https://github.com/microsoft/reflect-metadata | [Apache 全文](third-party/licenses/Reflect-Metadata-Apache-2.0.txt)与[原始版权](third-party/licenses/Reflect-Metadata-CopyrightNotice.txt)，同时保留 npm 包声明 |
| pi-memory | 0.4.2 | MIT | 主会话共享记忆引擎（通过 Pi SDK 原生扩展加载） | 未修改 | https://github.com/jayzeng/pi-memory/tree/v0.4.2 | npm 包 LICENSE |
| electron-updater | 6.8.10 | MIT | 应用内更新 | 未修改 | https://github.com/electron-userland/electron-builder | npm 包 LICENSE |
| unpdf／内嵌 PDF.js | 1.9.1／6.4.299 | MIT／Apache-2.0 | 本地 PDF 文字提取 | 上游 serverless bundle，Hemi 未修改 | https://github.com/unjs/unpdf；https://github.com/mozilla/pdf.js | npm 包 LICENSE；[PDF.js Apache 全文](third-party/pdfjs/PDFjs-LICENSE.txt)；PDF.js © Mozilla Foundation；不引入可选 canvas 原生依赖 |
| Adobe CMaps（来自 pdfjs-dist） | 6.4.299 | BSD-3-Clause | 中文、日文、韩文 PDF 字符映射 | 字节表未修改，仅重打 ZIP | https://github.com/mozilla/pdfjs-dist/tree/v6.4.299/cmaps | [Adobe 原始版权与许可](third-party/pdfjs/CMap-LICENSE.txt)；[来源及逐文件哈希](third-party/pdfjs/sources.json) |
| fflate | 0.8.3 | MIT | Office ZIP 与本地 CMap 数据读取 | 未修改 | https://github.com/101arrowz/fflate | npm 包 LICENSE |
| @xmldom/xmldom | 0.9.12 | MIT | Office XML 文字与单元格解析 | 未修改 | https://github.com/xmldom/xmldom | npm 包 LICENSE |
| Electron／Chromium | Electron 44.0.0 及其内嵌组件 | MIT 与组件各自许可 | 桌面运行时 | Hemi 未修改 | https://github.com/electron/electron | 安装包 Resources/licenses（macOS）或 resources/licenses（Windows）中的 Electron-LICENSE.txt、LICENSES.chromium.html；从当前 Electron dist 原样复制 |

## 前端与构建依赖（部分进入渲染 bundle）

文档原文预览按需加载 `docx-preview@0.4.0`（Apache-2.0）和 `@aiden0z/pptx-renderer@1.2.4`（Apache-2.0），
Vite 清单保留直接进入 bundle 的包与原始声明；PPT renderer 的 browser export 还预捆绑 JSZip、Pako、ECharts、ZRender、TSLib，
这些内嵌组件的固定版本来自上游发布提交的锁文件，另保留[原始许可及版权](third-party/licenses/Pptx-embedded-NOTICES.txt)与[来源哈希](third-party/pptx-preview-sources.json)。
JSZip 双许可采用 MIT 选项。PDF 预览使用 unpdf 内嵌的 PDF.js；
对应 Apache 全文另见 [PDFjs-LICENSE.txt](third-party/pdfjs/PDFjs-LICENSE.txt)。ZCode 源码仅作交互参考，本次未复制其组件源码。

`src/renderer/public/licenses/renderer-components.json` 记录实际 Vite JavaScript 输出中的组件、入口显式导入的样式、锁文件摘要和各许可来源；
`renderer-third-party.txt` 保留原许可文本与版权。运行 `node scripts/generate-renderer-notices.mjs` 可重新生成，
加 `--check` 检查是否过期。Vite 会将这些文件复制到分发目录的 `licenses/`。

`bezier-js@6.1.4` 的原始 MIT 标记与[完整许可](third-party/licenses/bezier-js-MIT.txt)一并保留。全文来自上游后补许可的固定提交，
其 src 树与 npm 发布提交相同（来源与哈希见 third-party/sources.json）。原 `conversation-virtualization.txt` 继续保留。
Tailwind CSS、tw-animate-css 与原样保留的 shadcn CSS 也分别保留版本、样式输入哈希和 MIT 全文。
构建工具（如 TypeScript）、主进程依赖和原生传递组件仍须分别核对，不能由前端清单覆盖。

## 原生库与 WebAssembly

[native-components.json](third-party/native-components.json) 记录 Cua／UBRN／Photon 固定源码锁文件中的 Rust 组件，
并补充 macOS、Windows 发布二进制内嵌源码路径中观察到的版本。原许可及版权保存在
[Native-Rust-NOTICES.txt](third-party/licenses/Native-Rust-NOTICES.txt)。这是一份保守来源清单，包含构建、开发及其他平台的依赖，
不能将其中所有组件都视为当前平台实际链接的代码。MPL 组件的精确 crates.io 源码归档地址一并列出。

QuickJS-WASI 3.6.2 内嵌 QuickJS-NG、Ada 3.4.3、Mbed TLS／TF-PSA-Crypto、Project Everest 及 WASI 运行库，
对应原始通知见 [QuickJS-native-NOTICES.txt](third-party/licenses/QuickJS-native-NOTICES.txt) 与
[WASI-libc-NOTICES.txt](third-party/licenses/WASI-libc-NOTICES.txt)。提供双许可选择的 Mbed TLS 组件采用 Apache-2.0 选项。
Photon Node 0.3.4 保留包内 Apache-2.0 文本，其 WASM 中观察到的 Rust 组件版本也列入上述清单。

可用 `node scripts/verify-distribution-licenses.mjs <解包目录> <仓外报告.json>` 核对实际安装包中的声明与构建输入一致，
并列出实际分发的原生文件、所属 npm 包与哈希。依赖版本变化或出现新的原生包时须更新许可材料；检查会拒绝未经登记的原生包。

## 记忆功能的依赖边界

Hemi 直接加载上表的原版 pi-memory。记忆搜索不在当前交付范围：不分发或部署 qmd、llama.cpp、sqlite-vec 及其 GGUF 检索模型，也不提供搜索组件安装入口。
