#!/usr/bin/env node
/**
 * 043 R-20 · dev:electron 跨平台入口：等 renderer 端口就绪（替代 wait-on），
 * 注入 VITE_DEV_SERVER_URL 后拉起 Electron（替代 cross-env 的 POSIX 链式
 * 调用）。HEMI_* 环境变量原样继承。
 */
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevRuntime } from './prepare-dev-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.HEMI_DEV_PORT || 5173);
const devServerUrl = `http://127.0.0.1:${port}`;
const WAIT_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询 TCP 端口（ref 定时器保活事件循环；vite 起来即返回）。 */
async function waitForPort(port) {
  const startedAt = Date.now();
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
      throw new Error(`等待 renderer 端口 ${port} 超时（${WAIT_TIMEOUT_MS}ms）`);
    }
    await sleep(300);
  }
}

async function main() {
  await waitForPort(port);
  const executable = prepareDevRuntime();
  const child = spawn(executable, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, HEMI_DEV_RUNTIME: '1' },
  });
  child.on('error', (error) => {
    console.error('[dev:electron]', error.message);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main().catch((error) => {
  console.error('[dev:electron]', error?.message ?? error);
  process.exit(1);
});
