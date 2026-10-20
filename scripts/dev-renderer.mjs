#!/usr/bin/env node
/**
 * 043 R-20 · dev:renderer 跨平台入口：替代 `${HEMI_DEV_PORT:-5173}` 的
 * POSIX 参数展开（cmd/PowerShell 不解释）。端口解析与 `npm run dev` 一致：
 * HEMI_DEV_PORT 优先，缺省 5173；vite 保持 strictPort。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.HEMI_DEV_PORT || 5173);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[dev:renderer] HEMI_DEV_PORT 非法：${process.env.HEMI_DEV_PORT}`);
  process.exit(1);
}

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(
  process.execPath,
  [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
