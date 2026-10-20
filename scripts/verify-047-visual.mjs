// 047 像素回路采集：产品 fixtures 6 场景 × 三档（1440/768/375，高 1000 与设计稿同规格，
// deviceScaleFactor 1）全页截图到 .visual/workflow/vision/047-newapi-import/，收集 console
// 错误（tier-1 的一部分）。对比由 snapshot-compare.sh 单独执行（固定 0.5%）。
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || [
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'),
  path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright/index.mjs'),
].find(existsSync);
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');

const BASE = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5173';
const OUT = path.resolve('.visual/workflow/vision/047-newapi-import');
mkdirSync(OUT, { recursive: true });

const SCENES = [
  'settings-model-add-newapi',
  'settings-import-login',
  'settings-import-selecting',
  'settings-import-progress',
  'settings-import-success',
  'settings-import-failed',
];
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 768, height: 1100 },
  { width: 375, height: 1100 },
];

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
const errors = [];
try {
  for (const scene of SCENES) {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${scene}@${viewport.width}: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.push(`${scene}@${viewport.width}: ${error}`));
      await page.goto(`${BASE}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const file = path.join(OUT, `${scene}-${viewport.width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`${file}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(errors.length === 0 ? 'CONSOLE_ERRORS=0' : `CONSOLE_ERRORS=${errors.length}`);
for (const error of errors.slice(0, 6)) console.log('  ', error.slice(0, 200));
process.exit(errors.length === 0 ? 0 : 1);
