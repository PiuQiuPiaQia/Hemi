# 第三方组件与许可声明

Hemi 自有代码采用 MIT（根 [LICENSE](LICENSE)）；本文件列出随源码与安装包分发的第三方组件及其原许可。
**本清单不改变任何第三方组件的原许可与版权**——MIT 只覆盖 Hemi 有权授权的自有代码，不含这些组件，
也不含它们内嵌的原生库。各条目记录：用途、精确版本／commit、是否修改、源码地址、声明在分发产物中的位置。

「Hemi」名称、应用图标等品牌素材不在根 MIT 的授予范围内；第三方素材的权利按其来源许可另行判断。

来源与许可文件见 [third-party/README.md](third-party/README.md)。已补 Cua／UBRN 的固定源码版本、原始通知和 MPL 全文，
以及从实际 Vite 输出生成的前端清单。Electron／Chromium 的原始许可随安装包分发；原生传递依赖和下述未解决项仍未全部核对。

## 复制进源码的第三方代码（vendor）

| 组件 | 版本／基线 | 用途 | 修改 | 源码 | 声明位置 |
| --- | --- | --- | --- | --- | --- |
| shadcn 样式 | npm `shadcn@4.18.0` 的 `dist/tailwind.css` | Tailwind 状态／动画样式 | 原样保留；未包含 CLI | https://github.com/shadcn-ui/ui | [完整 MIT](third-party/licenses/shadcn-MIT.txt)；来源及字节哈希见 third-party/sources.json |
| FlowGram engine（bytedance/flowgram.ai） | commit `2ee4a9d2aaf11850276b7d72eeb0ad5bed0e2948`（＝ npm `@flowgram.ai/runtime-js@1.0.16`） | 工作流执行引擎子集（059 vendor） | 手工转写为 .mjs；与上游偏差以文件头 `VENDOR-PATCH` 标注 | https://github.com/bytedance/flowgram.ai | [vendor 目录 LICENSE](src/main/workflows/vendor/flowgram-engine/LICENSE)（MIT，© Bytedance Ltd.）＋各文件头注 |

## 运行时依赖（进入安装包）

| 组件 | 版本 | 许可 | 用途 | 修改 | 源码 | 声明位置 |
| --- | --- | --- | --- | --- | --- | --- |
| uiohook-napi（包装层） | 1.5.5 | MIT | 全局 Option 长按说话（全局键鼠钩子） | 未修改 | https://github.com/SnosMe/uiohook-napi | npm 包内 LICENSE；内嵌 libuiohook 见下行 |
| libuiohook（经 uiohook-napi 静态链接） | 随 uiohook-napi 1.5.5 内嵌（binding.gyp 定义为 static_library） | **LGPL-3.0-or-later** | 同上（底层 C 库） | 未修改 | https://github.com/kwhat/libuiohook | **待补**：GNU 许可文本、对应源码与重建／重链说明（070 AC-05 要求实测重建后登记） |
| @trycua/cua-driver | 0.32.0 | MIT | 桌面操控（036 cua 后端，进程内调用） | Hemi 未修改 | [固定提交](https://github.com/trycua/cua/tree/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver) | npm 包未附完整 MIT 文本；现补在 [Cua-MIT.txt](third-party/licenses/Cua-MIT.txt) |
| @trycua/cua-driver-darwin-arm64 | 0.32.0 | MIT AND MPL-2.0 | 同上（mac arm64 原生运行时） | 未修改（确定性构建产物） | 同上；`node-runtime-NOTICE.md` 随包分发 | npm 包内 `node-runtime-NOTICE.md`；[上游 Rust 组件通知](third-party/licenses/Cua-Rust-NOTICES.md)保留 trope-cua、Interface-Agent、yabai 版权与 MIT 全文 |
| @ubjs/core、@ubjs/node 及本机平台包（经 cua-driver 引入） | 0.31.0-3 | MPL-2.0 | cua 原生运行时依赖（typescript／runtimes/napi） | Hemi 未修改；Cua compatibility runtime 的修改由上游构建脚本提供 | [对应源码与修改脚本](third-party/README.md)；core 为 `49bc591`，node／Cua 源码输入为 `dcb5c4a` | [MPL 全文](third-party/licenses/MPL-2.0.txt)、[UBRN 原始通知](third-party/licenses/UBRN-NOTICE.txt)和包内 node-runtime-NOTICE.md |
| @earendil-works/pi-coding-agent、pi-ai、pi-agent-core、pi-codemode、pi-mcp、pi-telemetry、pi-tui | 1.3.0 | MIT | Agent 会话与工具运行时（主／子 agent） | Hemi 未修改 | [固定源码](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0) | [Pi MIT 全文](third-party/licenses/Pi-MIT.txt)；pi-mcp 包内 LICENSES 的第三方通知继续保留 |
| ws | 8.21.3 | MIT | WebSocket（浏览器扩展桥） | 未修改 | https://github.com/websockets/ws | npm 包 LICENSE |
| pi-memory | 0.4.2 | MIT | 记忆扩展（能力对照保留，见 AGENTS.md） | 未修改 | npm registry | npm 包 LICENSE |
| electron-updater | 6.8.10 | MIT | 应用内更新 | 未修改 | https://github.com/electron-userland/electron-builder | npm 包 LICENSE |
| Electron／Chromium | Electron 44.0.0 及其内嵌组件 | MIT 与组件各自许可 | 桌面运行时 | Hemi 未修改 | https://github.com/electron/electron | 安装包 Resources/licenses（macOS）或 resources/licenses（Windows）中的 Electron-LICENSE.txt、LICENSES.chromium.html；从当前 Electron dist 原样复制 |

## 前端与构建依赖（部分进入渲染 bundle）

`src/renderer/public/licenses/renderer-components.json` 记录实际 Vite JavaScript 输出中的组件、入口显式导入的样式、锁文件摘要和各许可来源；
`renderer-third-party.txt` 保留原许可文本与版权。运行 `node scripts/generate-renderer-notices.mjs` 可重新生成，
加 `--check` 检查是否过期。Vite 会将这些文件复制到分发目录的 `licenses/`。

`bezier-js@6.1.4` 的原始 MIT 标记与[完整许可](third-party/licenses/bezier-js-MIT.txt)一并保留。全文来自上游后补许可的固定提交，
其 src 树与 npm 发布提交相同（来源与哈希见 third-party/sources.json）。原 `conversation-virtualization.txt` 继续保留。
Tailwind CSS、tw-animate-css 与原样保留的 shadcn CSS 也分别保留版本、样式输入哈希和 MIT 全文。
构建工具（如 TypeScript）、主进程依赖和原生传递组件仍须分别核对，不能由前端清单覆盖。

可用 `node scripts/verify-distribution-licenses.mjs <解包目录> <仓外报告.json>` 核对实际安装包中的声明与构建输入一致，
并列出实际分发的原生文件、所属 npm 包与哈希。该检查不替代二进制内嵌 C／Rust 组件的完整许可核查。
