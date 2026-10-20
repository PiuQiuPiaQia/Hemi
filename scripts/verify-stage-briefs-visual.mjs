// 026 R-09 阶段简报时间线（2026-10-09）：三档截图＋DOM 断言。
// 用法：先起 fixtures（npm run dev:renderer 或 vite --port 5174），再
// HEMI_FIXTURES_BASE=http://127.0.0.1:5174 node scripts/verify-stage-briefs-visual.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || [
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'),
  path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright/index.mjs'),
].find(existsSync);
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const base = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5173';
const out = path.resolve('.visual/workflow/vision/stage-briefs');
mkdirSync(out, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
const errors = [];
const checks = [];
try {
  for (const width of [1440, 768, 375]) {
    for (const scene of ['task-stage-briefs', 'task-stage-briefs-done']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', (error) => errors.push(`${scene}@${width}: ${error.message}`));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`${scene}@${width}: ${message.text()}`); });
      await page.goto(`${base}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${scene}@${width} 横向溢出`);
      const groups = page.locator('.h24-stage-briefs');
      if (scene === 'task-stage-briefs') {
        // 紧跟任务卡的四条简报：一组、零任务名胶囊、最新一条为当前、收近卡下距。
        assert.equal(await groups.count(), 1);
        assert.equal(await page.locator('.h24-task-relation').count(), 0, '紧跟任务卡不该再挂任务名');
        assert.equal(await groups.locator('.h24-stage-item').count(), 4);
        assert.equal(await groups.locator('.h24-stage-item').last().getAttribute('data-current'), 'true');
        assert.equal(await groups.locator('[data-current]').count(), 1);
        assert.equal(await groups.getAttribute('data-after-card'), 'true');
        const gap = await page.evaluate(() => {
          const card = document.querySelector('.chat-task-inline').getBoundingClientRect();
          return Math.round(document.querySelector('.h24-stage-briefs').getBoundingClientRect().top - card.bottom);
        });
        assert.equal(gap, 12, `卡与时间线间距 ${gap}`);
        await page.screenshot({ path: path.join(out, `${scene}-${width}.png`) });
      } else {
        // 插话打断：两组；后一组离开任务上下文才挂一次胶囊；终态交代紧随不挂；
        // 收尾后无「当前」；5 条折叠成 3 条，展开全显、收起复原。
        assert.equal(await groups.count(), 2);
        assert.equal(await page.locator('.h24-task-relation').count(), 1);
        assert.equal(await groups.nth(1).locator('.h24-task-relation').count(), 1);
        assert.equal(await page.locator('.h24-stage-briefs [data-current]').count(), 0);
        const tail = groups.nth(1);
        const fold = tail.locator('.h24-stage-fold');
        assert.equal(await tail.locator('.h24-stage-item').count(), 3);
        assert.match(await fold.innerText(), /更早 2 条进展/);
        await page.screenshot({ path: path.join(out, `${scene}-${width}.png`) });
        await fold.click();
        assert.equal(await tail.locator('.h24-stage-item').count(), 5);
        assert.equal(await fold.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        if (width === 1440) await page.screenshot({ path: path.join(out, `${scene}-expanded-${width}.png`) });
        await fold.click();
        assert.equal(await tail.locator('.h24-stage-item').count(), 3);
        // 终态交代仍是正式回答：正文 15 号 chat-copy，不在时间线里。
        const answer = page.locator('.h24-hemi-message:not(.h24-stage-briefs) .chat-copy').last();
        assert.match(await answer.innerText(), /整体设计是合理的/);
      }
      checks.push(`${scene}@${width}`);
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(`stage-briefs visual ok：${checks.length} 场景，截图 ${out}`);
} finally {
  await browser.close();
}
