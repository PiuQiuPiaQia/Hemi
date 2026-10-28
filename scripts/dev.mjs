#!/usr/bin/env node
/**
 * dev 启动包装：先挑一个空闲端口（默认从 5173 向上找，可 HEMI_DEV_PORT 指定
 * 首选值），再把 HEMI_DEV_PORT 注入 concurrently 的两个子进程。
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 直接运行 JS 入口，不依赖 Windows 无法直接 spawn 的 .cmd 包装器。
export function spawnDev(port, spawnProcess = spawn) {
  const concurrentlyBin = path.join(
    path.dirname(require.resolve('concurrently/package.json')), 'dist', 'bin', 'index.js',
  );
  return spawnProcess(
    process.execPath,
    [concurrentlyBin, '-k', '-n', 'renderer,electron', '-c', 'cyan,green', 'npm:dev:renderer', 'npm:dev:electron'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, HEMI_DEV_PORT: String(port) } },
  );
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  const requested = Number(process.env.HEMI_DEV_PORT || 5173);
  let port = requested;
  while (!(await isPortFree(port))) port += 1;
  if (port !== requested) {
    console.log(`[dev] 端口 ${requested} 被占用，自动改用 ${port}`);
  }

  // 未打包实例的数据与单实例锁由主进程隔离，可与已安装的 Hemi 同时运行。
  const child = spawnDev(port);
  child.on('error', (error) => {
    console.error('[dev]', error.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[dev]', error.message);
    process.exit(1);
  });
}
