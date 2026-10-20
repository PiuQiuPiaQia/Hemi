# 开发

[English](development.md) · [产品介绍](../README.zh-CN.md)

## 运行

当前验证平台为 macOS Apple Silicon，使用 Node.js 22.19 及以上的 Node 22 版本。

```bash
npm ci
npm run dev
```

在应用的 **设置 → 模型与路由** 添加服务提供方和模型，即可发送文字任务。语音功能需要另行配置语音服务。Pi 随 npm 依赖提供，无需另外安装执行器。

`npm run dev` 同时启动 Vite 和 Electron。需要更换端口时：

```bash
HEMI_DEV_PORT=5176 npm run dev
```

开发数据位于 `~/Library/Application Support/hemi-dev`，安装版使用 `~/Library/Application Support/hemi`。隔离验证时，将 `HEMI_USER_DATA_DIR` 设为新目录。日志为该目录下的 `hemi.log`；`HEMI_LOG_LEVEL=debug` 可开启详细日志。

## 检查改动

```bash
npm test
npm run build
node scripts/check-spacing.mjs
```

单测使用可控模型端点，不需要外部模型凭据。构建命令包含类型检查。修改依赖后运行 `node scripts/generate-renderer-notices.mjs`，检查生成的许可清单；CI 使用 `--check` 核对一致性。

运行构建后的界面：

```bash
npm run build
npm start
```

用全新数据目录执行应用冒烟：

```bash
HEMI_USER_DATA_DIR="$(mktemp -d)" HEMI_SMOKE_TEST=1 npm start
```

未配置模型时，冒烟只验证启动和配置错误，不能证明模型任务成功。执行链路改动还需从正常应用入口提交任务，核对实际文件、进程或其他结果。UI 生命周期改动需要分别验证 Vite 和构建入口。

## 源码位置

- `src/main/`：Electron 服务、IPC、agent 运行时和工作流。
- `src/preload/`：界面桥；`src/shared/`：共享通道与契约。
- `src/renderer/`：React 界面和样式；`extensions/chrome-extension/`：浏览器扩展。
- `scripts/`：构建与验证工具；`third-party/`：许可及源码来源。

IPC 通道先登记到 `src/shared/ipc-channels.mjs`，处理器放在 `src/main/ipc/`。`npm run pack` 只生成本机目录包，不发布。另见[参与贡献](../CONTRIBUTING.md)和[安全与隐私](../SECURITY.md)。
