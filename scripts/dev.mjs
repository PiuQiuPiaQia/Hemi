#!/usr/bin/env node
/**
 * dev 启动包装：先挑一个空闲端口（默认从 5173 向上找，可 HEMI_DEV_PORT 指定
 * 首选值），再把 HEMI_DEV_PORT 注入 concurrently 的两个子进程——vite 仍保持
 * strictPort（端口已确认空闲，真被抢占就该响），electron 的 wait-on 与
 * VITE_DEV_SERVER_URL 自动拿到同一端口，不再需要手动换端口。
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

const requested = Number(process.env.HEMI_DEV_PORT || 5173);
let port = requested;
while (!(await isPortFree(port))) port += 1;
if (port !== requested) {
  console.log(`[dev] 端口 ${requested} 被占用，自动改用 ${port}`);
}

// 未打包实例的数据与单实例锁由主进程隔离，可与已安装的 Hemi 同时运行。
const child = spawn(
  'concurrently',
  ['-k', '-n', 'renderer,electron', '-c', 'cyan,green', 'npm:dev:renderer', 'npm:dev:electron'],
  { stdio: 'inherit', env: { ...process.env, HEMI_DEV_PORT: String(port) } },
);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
