// 047 产品 fixtures 场景运行时检查：起 vite dev 渲染层，逐场景加载 /fixtures.html，
// 抓 console error / 页面异常 / 关键元素在不在。视觉像素回路另行走
// visual-pixel-perfect（AGENTS 口径），这里先保证不白屏、不炸。
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || [
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'),
  path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright/index.mjs'),
].find(existsSync);
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');

const BASE = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5173';
const SCENES = [
  ['settings-model-add-newapi', '.h47n-methods'],
  ['settings-import-login', '.h47n-browser'],
  ['settings-import-loading', '.h47n-browser-loading'],
  ['settings-import-selecting', '.h47n-search'],
  ['settings-import-progress', '.h47n-steps'],
  ['settings-import-success', '.h47n-panel .h37-section'],
  ['settings-import-failed', '.h47n-validation, .h37-note'],
];

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
let failed = 0;
try {
  for (const [scene, selector] of SCENES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${BASE}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const found = await page.locator(selector).count();
    const ok = found > 0 && errors.length === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} ${scene}（${selector} × ${found}，console errors：${errors.length}）`);
    for (const error of errors.slice(0, 3)) console.log('   ', error.slice(0, 200));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failed === 0 ? 'FIXTURES_OK' : `FIXTURES_FAILED=${failed}`);
process.exit(failed === 0 ? 0 : 1);
