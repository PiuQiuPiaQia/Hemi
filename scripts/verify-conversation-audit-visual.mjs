// 会话审计修复：三档截图、长核验展开、用量筛选、异常图标与真实 DOM 用时。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || [
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'),
  path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright/index.mjs'),
].find(existsSync);
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const base = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5186';
const out = path.resolve('.visual/workflow/vision/conversation-audit-fix');
mkdirSync(out, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
const errors = [];
const checks = [];
try {
  for (const width of [1440, 768, 375]) {
    for (const scene of ['audit-session-partial', 'audit-session-process', 'usage-panel']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', (error) => errors.push(`${scene}@${width}: ${error.message}`));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`${scene}@${width}: ${message.text()}`); });
      await page.goto(`${base}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${scene}@${width} 横向溢出`);
      if (scene === 'audit-session-partial') {
        const card = page.locator('.chat-task-inline .task-card');
        assert.match(await card.getAttribute('aria-label'), /部分完成/);
        assert.match(await card.locator('.task-meta').innerText(), /4 分 12 秒/);
        assert.ok((await card.locator('.task-conclusion').innerText()).length < 220);
        assert.equal(await card.locator('.task-conclusion').getAttribute('data-tone'), null);
        const details = card.locator('.task-result-detail');
        await page.screenshot({ path: path.join(out, `${scene}-${width}.png`), fullPage: true });
        await details.locator('summary').click();
        assert.ok((await details.locator('.md').innerText()).length > 600);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(out, `${scene}-expanded-${width}.png`), fullPage: true });
        await details.locator('summary').click();
        assert.equal(await details.getAttribute('open'), null);
      } else if (scene === 'audit-session-process') {
        const timeout = page.locator('.h25-timeline li').filter({ hasText: '确认超时' });
        assert.equal(await timeout.getAttribute('data-state'), 'attention');
        assert.equal(await timeout.locator('.h25-timeline-node svg').count(), 1);
        await page.screenshot({ path: path.join(out, `${scene}-${width}.png`), fullPage: true });
      } else {
        assert.match(await page.locator('.h48-usage-panel-sub').innerText(), /11 次调用/);
        await page.getByRole('button', { name: '任务执行 7', exact: true }).click();
        assert.equal(await page.locator('.h48-usage-row:not([data-head])').count(), 1);
        assert.match(await page.locator('.h48-usage-row:not([data-head])').innerText(), /7/);
        await page.getByRole('button', { name: '全部 11', exact: true }).click();
        if (width === 375) {
          const row = page.locator('.h48-usage-row:not([data-head])').first();
          assert.equal(await row.locator('.h48-usage-cards-line').isVisible(), true);
          assert.equal(await row.locator(':scope > span').nth(1).isVisible(), false);
        }
        await page.screenshot({ path: path.join(out, `${scene}-${width}.png`), fullPage: true });
      }
      if (width === 1440) {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.screenshot({ path: path.join(out, `${scene}-${width}-dark-preference.png`), fullPage: true });
      }
      checks.push({ scene, width, passed: true });
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ checks, errors }, null, 2));
}
console.log(`HEMI_CONVERSATION_VISUAL_RESULT ${JSON.stringify({ ok: true, checks: checks.length, errors: errors.length, out })}`);
