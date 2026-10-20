# Development

[中文](development.zh-CN.md) · [Product overview](../README.md)

## Run

The current validation target is macOS on Apple Silicon. Use Node.js 22.19 or later in the Node 22 line.

```bash
npm ci
npm run dev
```

In the app, open **设置 → 模型与路由** (Settings → Models and routing), add your provider and model, then send a text task. Voice features require separate speech-service configuration. Pi is bundled through npm; no separate executor installation is needed.

`npm run dev` starts Vite and Electron. To choose another port:

```bash
HEMI_DEV_PORT=5176 npm run dev
```

Development uses `~/Library/Application Support/hemi-dev`; the installed app uses `~/Library/Application Support/hemi`. For isolated verification, set `HEMI_USER_DATA_DIR` to a new directory. Logs are written to `hemi.log` in that directory; `HEMI_LOG_LEVEL=debug` enables detailed logs.

## Check a change

```bash
npm test
npm run build
node scripts/check-spacing.mjs
```

Tests use controlled provider endpoints and do not need model credentials. `npm run build` includes TypeScript checks. After dependency changes, regenerate and review notices with `node scripts/generate-renderer-notices.mjs`; CI checks them with `--check`.

To run the built renderer:

```bash
npm run build
npm start
```

For an application smoke test, use a new data directory:

```bash
HEMI_USER_DATA_DIR="$(mktemp -d)" HEMI_SMOKE_TEST=1 npm start
```

A smoke test without model configuration checks startup and configuration errors; it does not prove a model task succeeded. For execution changes, also run a task through the normal app and check the actual file, process, or other result. UI lifecycle changes need both the Vite and built renderer.

## Source layout

- `src/main/`: Electron services, IPC, agent runtime and workflows.
- `src/preload/`: renderer bridge; `src/shared/`: shared channels and contracts.
- `src/renderer/`: React UI and styles; `extensions/chrome-extension/`: browser extension.
- `scripts/`: build and verification tools; `third-party/`: license and source records.

Register IPC channels in `src/shared/ipc-channels.mjs` and keep handlers in `src/main/ipc/`. `npm run pack` creates a local unpacked app without publishing. See [contributing](../CONTRIBUTING.md) and [security and privacy](../SECURITY.md).
