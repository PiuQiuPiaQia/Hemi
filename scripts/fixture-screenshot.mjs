#!/usr/bin/env node
/**
 * fixtures 场景截图 harness（开发/验收辅助，非产品链路）：
 * 无头 Electron 加载 /fixtures.html?scene=<name>，按视口尺寸截 PNG 落盘。
 *
 * 用法：node scripts/fixture-screenshot.mjs <scene> <out.png> [width] [height] [base]
 * 默认视口 980×680、base http://127.0.0.1:5173/fixtures.html。
 * 注意：Electron ESM 主入口里顶层 await app.whenReady() 永不结算（ready 在
 * 模块求值完成后才发），必须走 .then(main)。
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

async function main() {
  const scene = process.argv[2] ?? 'main-idle';
  const out = resolve(process.cwd(), process.argv[3] ?? `.visual/fixture-${scene}.png`);
  const width = Number(process.argv[4] ?? 980);
  const height = Number(process.argv[5] ?? 680);
  const base = process.argv[6] ?? 'http://127.0.0.1:5173/fixtures.html';

  const hardExit = setTimeout(() => {
    console.error('screenshot timed out');
    process.exit(2);
  }, 20000);

  await app.whenReady();
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
  });
  // tier-1 console 门：渲染错误/告警直接反映在 harness 输出里。
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[console:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`load failed: ${code} ${desc}`);
    clearTimeout(hardExit);
    process.exit(2);
  });
  await win.loadURL(`${base}?scene=${encodeURIComponent(scene)}`);
  await new Promise((r) => setTimeout(r, 700)); // 等首帧与字体
  // 可选第 7 参：捕获前的页面内脚本（对齐滚动位置等比对前置状态）。
  if (process.argv[7]) {
    await win.webContents.executeJavaScript(process.argv[7]);
    await new Promise((r) => setTimeout(r, 200));
  }
  const png = await win.webContents.capturePage();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png.toPNG());
  console.log(`saved ${out} (${width}x${height})`);
  clearTimeout(hardExit);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
