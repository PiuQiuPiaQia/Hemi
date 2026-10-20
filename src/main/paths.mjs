import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * dev/prod 资源路径的唯一收口。
 * 主进程源码不经打包直接运行（package.json "main" 指向本目录），
 * 所以这里的相对层级必须同时对 `npm run dev` 和打包后的 app 负责。
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const preloadPath = path.join(here, '..', 'preload', 'index.cjs');

/** build/icon.png 随应用打包；Dock、原生关于面板与所有窗口使用同一资源。 */
export const appIconPath = path.join(here, '..', '..', 'build', 'icon.png');

export const rendererIndexPath = path.join(
  here,
  '..',
  '..',
  'dist-renderer',
  'index.html',
);
