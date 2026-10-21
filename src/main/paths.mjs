import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * dev/prod 资源路径的唯一收口。
 * 主进程源码不经打包直接运行（package.json "main" 指向本目录），
 * 所以这里的相对层级必须同时对 `npm run dev` 和打包后的 app 负责。
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const preloadPath = path.join(here, '..', 'preload', 'index.cjs');

/** build/icon.png 随应用打包；原生关于面板与窗口使用该资源（dev 的 Dock 换成 devAppIconPath）。 */
export const appIconPath = path.join(here, '..', '..', 'build', 'icon.png');

/**
 * dev 专用图标（build/icon-dev.png 随仓库提交，由 scripts/generate-dev-icon.mjs 导出）。
 * 只在开发运行态用于 Dock：打包版与 dev 同时跑时，必须一眼看出哪个是开发实例。
 */
export const devAppIconPath = path.join(here, '..', '..', 'build', 'icon-dev.png');

export const rendererIndexPath = path.join(
  here,
  '..',
  '..',
  'dist-renderer',
  'index.html',
);
