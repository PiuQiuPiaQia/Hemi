// Scale/selection/leak diagnostic using the real VoiceScreen fixture; not an IPC product substitute.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const base = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5182';
const output = path.resolve('.visual/workflow/vision/067/scale'); fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: false, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ?? 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [], results = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const vp = '[data-transcript-scroll] [data-slot="scroll-area-viewport"]';
const pause = () => page.waitForTimeout(160);
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  for (const count of [150, 1500]) {
    await page.goto(`${base}/fixtures.html?scene=conversation-virtual-${count}`);
    await page.locator('[data-virtual-total]').waitFor(); await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
    const cycles = async n => {
      for (let i = 0; i < n; i++) for (const fraction of [0, .25, .5, .75, 1]) {
        await page.locator(vp).evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction; }, fraction);
        await pause();
        const sample = await page.locator(vp).evaluate(el => {
          const rect = el.getBoundingClientRect(), rows = [...el.querySelectorAll('[data-virtual-row]')];
          return { mounted: rows.length, visible: rows.filter(r => { const b = r.getBoundingClientRect(); return b.bottom > rect.top && b.top < rect.bottom; }).length,
            entries: Number(el.querySelector('[data-virtual-total]').dataset.markdownCacheEntries ?? 0), bytes: Number(el.querySelector('[data-virtual-total]').dataset.markdownCacheBytes ?? 0) };
        });
        assert.ok(sample.mounted <= sample.visible + 10, JSON.stringify(sample));
        assert.ok(sample.entries <= 128 && sample.bytes <= 4 * 1024 * 1024, JSON.stringify(sample));
      }
    };
    const memory = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      return { heap: metrics.JSHeapUsedSize, ...await cdp.send('Memory.getDOMCounters') };
    };
    await cycles(2); const warm = await memory();
    await cycles(5); const end = await memory();
    assert.ok(end.heap - warm.heap <= 8 * 1024 * 1024, JSON.stringify({ warm, end }));
    assert.ok(end.nodes <= warm.nodes + 200 && end.jsEventListeners <= warm.jsEventListeners + 32, JSON.stringify({ warm, end }));
    results.push({ count, warm, end }); check(`${count} 行：挂载与缓存预算、五轮 GC 后堆／DOM／监听器边界`);
    await page.locator(vp).evaluate(el => { el.scrollTop = 0; }); await pause();
    const row = page.locator('[data-virtual-row="virtual-1"]');
    await row.locator('.turn-activity-head').click();
    await row.locator('.h48-thinking-head').click();
    await page.locator('textarea.text-composer-input').focus();
    await page.locator(vp).evaluate(el => { el.scrollTop = el.scrollHeight; }); await pause();
    assert.equal(await row.count(), 0, '已展开行必须真正卸载');
    await page.locator(vp).evaluate(el => { el.scrollTop = 0; }); await pause();
    assert.equal(await row.locator('.h48-thinking-head').getAttribute('aria-expanded'), 'true');
    assert.equal(await row.locator('.turn-activity-head').getAttribute('aria-expanded'), 'true');
    check(`${count} 行：过程组／思考展开状态跨实际卸载恢复`);
    await page.locator(vp).evaluate(el => { el.scrollTop = el.scrollHeight * .5; }); await pause();
    const anchor = () => page.locator(vp).evaluate(el => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll('[data-virtual-row]')].find(r => r.getBoundingClientRect().bottom > top && r.getBoundingClientRect().top < top + el.clientHeight);
      return { id: row?.dataset.virtualRow, top: row?.getBoundingClientRect().top - top - parseFloat(getComputedStyle(el.querySelector('.conversation-list')).paddingTop) };
    });
    const beforeWidth = await anchor();
    await page.setViewportSize({ width: 375, height: 900 }); await page.waitForTimeout(300);
    const afterWidth = await anchor();
    assert.equal(afterWidth.id, beforeWidth.id); assert.ok(Math.abs(afterWidth.top - beforeWidth.top) <= 2, JSON.stringify({ beforeWidth, afterWidth }));
    await page.setViewportSize({ width: 1440, height: 900 }); await pause();
    await page.locator(vp).evaluate(el => { el.scrollTop = 0; }); await pause();
    check(`${count} 行：上翻阅读时从 1440 缩至 375 保持内容与像素锚点`);
    // Native Selection with retained endpoints and unloaded middle rows.
    await page.evaluate(() => { const n = document.querySelector('[data-virtual-row="virtual-0"] .h24-user-bubble span').firstChild; window.getSelection().setBaseAndExtent(n, 0, n, 2); });
    await pause();
    await page.locator(vp).evaluate(el => { el.scrollTop = el.scrollHeight; }); await pause();
    await page.evaluate(count => {
      const first = document.querySelector('[data-virtual-row="virtual-0"] .h24-user-bubble span').firstChild;
      const last = document.querySelector(`[data-virtual-row="virtual-${count - 2}"] .h24-user-bubble span`).firstChild;
      window.getSelection().setBaseAndExtent(first, 0, last, last.textContent.length);
    }, count);
    await pause();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    await pause();
    const copy = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copy.includes('VIRTUAL_MARKER_0') && copy.includes(`VIRTUAL_MARKER_${count / 2}`) && copy.includes(`VIRTUAL_MARKER_${count - 2}`));
    await page.evaluate(() => window.getSelection().removeAllRanges()); check(`${count} 行：跨屏外选区原生复制包含中间唯一标记`);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 }); await pause();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `${count}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' }); await pause();
    await page.screenshot({ path: path.join(output, `${count}-1440-dark.png`) });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await page.goto(`${base}/fixtures.html?scene=conversation-virtual-human-input`);
  await page.locator('[data-virtual-total]').waitFor();
  await page.locator(vp).evaluate(el => { el.scrollTop = 0; }); await pause();
  const formRow = page.locator('[data-virtual-row="virtual-3"]');
  const feedback = formRow.locator('.h59-hi textarea');
  await feedback.fill('未到防抖期限的唯一草稿 VIRTUAL_INPUT_DRAFT');
  await page.locator('textarea.text-composer-input').focus();
  await page.locator(vp).evaluate(el => { el.scrollTop = el.scrollHeight; }); await pause();
  assert.equal(await formRow.count(), 0, '人工输入行必须实际卸载');
  await page.locator(vp).evaluate(el => { el.scrollTop = 0; }); await pause();
  assert.equal(await feedback.inputValue(), '未到防抖期限的唯一草稿 VIRTUAL_INPUT_DRAFT');
  check('新合入人工输入表单：防抖保存前实际卸载、返回后草稿保留');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ checks, results, errors, base }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') });
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, results, errors, error: error.stack }, null, 2));
  throw error;
} finally { await browser.close(); }
