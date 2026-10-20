// 027/028 预览面板关闭交互（2026-10-18 用户裁决）：起 vite dev 渲染层加载
// preview-attachment fixtures 场景（真实 VoiceScreen + FilePreviewPanel），断言——
//   1. 宽窗（1440）点击对话流不收起右侧面板；
//   2. Escape 逐个关闭当前 Tab，最后一个 Tab 关闭后面板整体收起；
//   3. ＋ 菜单开着时 Escape 只关菜单、面板不动；
//   4. 收起按钮（显式动作）仍收起面板；
//   5. 窄窗（375，modal）点面板外（顶栏/backdrop）不收起，Escape 逐 Tab 关闭照常。
// 运行：node scripts/verify-preview-close.mjs（需要 dev:renderer 在 5173，脚本不自起）
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
const SCENE = 'preview-attachment';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const tabCount = (page) => page.locator('.h24-preview-tab').count();
const panelCount = (page) => page.locator('.h24-preview').count();
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  return ok ? 0 : 1;
};

const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
let failed = 0;
try {
  // ---- 宽窗 1440：并排（非 modal）----
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/fixtures.html?scene=${SCENE}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.h24-preview', { timeout: 10_000 });
  await page.waitForTimeout(300);

  failed += check('宽窗初始 3 枚 Tab', (await tabCount(page)) === 3, `tabs=${await tabCount(page)}`);

  // 1. 点击对话流（用户气泡）：面板不收起、Tab 不丢。
  await page.locator('.h24-user-message').first().click();
  await page.waitForTimeout(150);
  failed += check('点对话流后面板仍在', (await panelCount(page)) === 1 && (await tabCount(page)) === 3,
    `panel=${await panelCount(page)} tabs=${await tabCount(page)}`);

  // 2. Escape 逐个关 Tab；最后一个关完面板收起。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  failed += check('Escape×1 关当前 Tab（剩 2，面板在）', (await panelCount(page)) === 1 && (await tabCount(page)) === 2,
    `tabs=${await tabCount(page)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  failed += check('Escape×2 剩 1 枚 Tab', (await panelCount(page)) === 1 && (await tabCount(page)) === 1,
    `tabs=${await tabCount(page)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  failed += check('Escape×3 最后 Tab 关闭后面板收起', (await panelCount(page)) === 0, `panel=${await panelCount(page)}`);

  // 3. ＋ 菜单开着时 Escape 只关菜单。
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.h24-preview', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.locator('.h24-preview-add').click();
  await page.waitForTimeout(120);
  const menuShown = await page.locator('.h24-preview-add-menu').count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  failed += check('＋菜单 Escape 只关菜单、面板不动',
    menuShown === 1 && (await panelCount(page)) === 1 && (await tabCount(page)) === 3 && (await page.locator('.h24-preview-add-menu').count()) === 0,
    `menuWas=${menuShown} panel=${await panelCount(page)} tabs=${await tabCount(page)}`);

  // 4. 收起按钮（显式）仍收起。
  await page.locator('.h24-preview-collapse').click();
  await page.waitForTimeout(200);
  failed += check('收起按钮仍收起面板', (await panelCount(page)) === 0, `panel=${await panelCount(page)}`);

  failed += check('宽窗零 console 错误', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));
  await page.close();

  // ---- 窄窗 375：覆盖主列（modal）----
  const narrow = await browser.newPage({ viewport: { width: 375, height: 760 } });
  const narrowErrors = [];
  narrow.on('console', (m) => { if (m.type() === 'error') narrowErrors.push(m.text()); });
  narrow.on('pageerror', (e) => narrowErrors.push(String(e)));
  await narrow.goto(`${BASE}/fixtures.html?scene=${SCENE}`, { waitUntil: 'networkidle' });
  await narrow.waitForSelector('.h24-preview', { timeout: 10_000 });
  await narrow.waitForTimeout(300);
  failed += check('窄窗初始 3 枚 Tab', (await tabCount(narrow)) === 3, `tabs=${await tabCount(narrow)}`);

  // 5. 点面板外（顶栏一带，落在内部 backdrop 上）不收起。
  await narrow.mouse.click(187, 26);
  await narrow.waitForTimeout(200);
  failed += check('窄窗点面板外不收起', (await panelCount(narrow)) === 1 && (await tabCount(narrow)) === 3,
    `panel=${await panelCount(narrow)} tabs=${await tabCount(narrow)}`);

  // Escape 逐 Tab 关闭照常。
  for (let i = 0; i < 3; i += 1) await narrow.keyboard.press('Escape');
  await narrow.waitForTimeout(200);
  failed += check('窄窗 Escape×3 收起面板', (await panelCount(narrow)) === 0, `panel=${await panelCount(narrow)}`);
  failed += check('窄窗零 console 错误', narrowErrors.length === 0, narrowErrors.slice(0, 2).join(' | ').slice(0, 200));
  await narrow.close();
} finally {
  await browser.close();
}
console.log(failed === 0 ? 'PREVIEW_CLOSE_OK' : `PREVIEW_CLOSE_FAILED=${failed}`);
process.exit(failed === 0 ? 0 : 1);
