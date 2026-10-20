// 登录记忆文案与错误态的可读性/响应式检查（无新视觉稿，非像素还原）。
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(runtime).href);
const out = path.resolve('.visual/workflow/vision');
const base = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5173';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
const results = [];
try {
  for (const scene of ['settings-model-add-newapi', 'settings-import-login', 'settings-import-login-memory-error']) {
    for (const width of [1440, 768, 375]) {
      const errors = [];
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
      // 开发态 FPS 叠层不属于产品页面；保留 StrictMode，仅在视觉采集时隐藏调试仪表。
      await page.addStyleTag({ content: '.h65-perf { display: none !important; }' });
      await page.locator('.h47n').waitFor();
      await page.waitForTimeout(400);
      const initialButtonsVisible = await page.locator('.h47n-foot').evaluate((el) => {
        const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
      });
      if (!initialButtonsVisible) {
        await page.screenshot({ path: path.join(out, `login-memory-${scene}-${width}-top.png`), fullPage: true });
        await page.locator('.h47n-foot').scrollIntoViewIfNeeded();
      }
      const check = await page.evaluate(() => {
        const foot = document.querySelector('.h47n-foot');
        const rect = foot?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          buttonsInViewport: Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight),
          buttonsUncovered: [...(foot?.querySelectorAll('button') ?? [])].every((button) => {
            const r = button.getBoundingClientRect();
            return [r.top + 2, r.bottom - 2].every((y) => button.contains(document.elementFromPoint(r.left + r.width / 2, y)));
          }),
          memoryExplained: document.querySelector('.h47n')?.textContent.includes('加密'),
          errorVisible: Boolean(document.querySelector('.h47n [role="alert"]')),
        };
      });
      const screenshot = `login-memory-${scene}-${width}.png`;
      await page.screenshot({ path: path.join(out, screenshot), fullPage: true });
      const ok = !check.overflow && check.buttonsInViewport && check.buttonsUncovered && check.memoryExplained && errors.length === 0
        && (scene !== 'settings-import-login-memory-error' || check.errorVisible);
      results.push({ scene, width, ok, initialButtonsVisible, ...check, errors, screenshot });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${scene}@${width} ${JSON.stringify(check)}`);
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  await page.goto(`${base}/fixtures.html?scene=settings-import-login-memory-error`, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '.h65-perf { display: none !important; }' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, 'login-memory-dark-1440.png'), fullPage: true });
  await page.close();
} finally { await browser.close(); }
await writeFile(path.join(out, 'login-memory-layout.json'), JSON.stringify({ results }, null, 2));
if (results.some((item) => !item.ok)) process.exitCode = 1;
