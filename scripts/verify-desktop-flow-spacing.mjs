// Isolated renderer fixture; never starts Electron or accesses application data.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createServer, build, preview} from 'vite';
import {chromium} from 'playwright-core';

const mode = process.argv[2] ?? 'dev';
const baseline = process.argv.includes('--baseline');
const out = path.resolve('.visual/desktop-flow-spacing');
mkdirSync(out, {recursive: true});
if (mode === 'built') await build({build: {outDir: path.join(out, 'renderer'), emptyOutDir: true,
  rollupOptions: {input: path.resolve('src/renderer/fixtures.html')}}});
const server = mode === 'built'
  ? await preview({build: {outDir: path.join(out, 'renderer')}, preview: {host: '127.0.0.1', port: 5197, strictPort: true}})
  : await createServer({server: {host: '127.0.0.1', port: 5197, strictPort: true}});
if (mode !== 'built') await server.listen();
const browser = await chromium.launch({headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results = [];
try {
  for (const width of [1440, 900, 600]) {
    const page = await browser.newPage({viewport: {width, height: 950}, reducedMotion: 'reduce'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5197/fixtures.html?scene=desktop-flow-spacing', {waitUntil: 'networkidle'});
    await page.locator('.turn-activity-head').waitFor();
    const measure = () => page.evaluate(() => {
      const rect = selector => {
        const el = document.querySelector(selector), box = el.getBoundingClientRect(), css = getComputedStyle(el);
        return {top: box.top, bottom: box.bottom, height: box.height, marginTop: css.marginTop, marginBottom: css.marginBottom, paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, fontSize: css.fontSize};
      };
      return {task: rect('.h56-delegation'), recovery: rect('.model-recovery-notice'),
        activity: rect('.turn-activity'), head: rect('.turn-activity-head'), text: rect('[data-flow-row="spacing-reply"] .chat-copy'),
        rows: [...document.querySelectorAll('.h67-virtual-row')].map(el => ({top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom})),
        overflow: document.documentElement.scrollWidth > innerWidth};
    });
    const metrics = await measure();
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.text.fontSize, '15px');
    if (!baseline) {
      assert.equal(metrics.activity.marginTop, '4px');
      assert.equal(metrics.activity.marginBottom, '6px');
      assert.equal(metrics.recovery.paddingTop, '0px');
      assert.equal(metrics.recovery.height, 28);
      assert.ok(metrics.text.top - metrics.head.bottom <= 6.1);
    }
    await page.screenshot({path: path.join(out, `${mode}-${baseline ? 'before' : 'after'}-${width}.png`), fullPage: true});
    await page.locator('.turn-activity-head').click();
    assert.equal(await page.locator('.turn-activity-head').getAttribute('aria-expanded'), 'true');
    await page.locator('.model-recovery-toggle').click();
    assert.equal(await page.locator('.model-recovery-toggle').getAttribute('aria-expanded'), 'true');
    await page.screenshot({path: path.join(out, `${mode}-${baseline ? 'before' : 'after'}-expanded-${width}.png`), fullPage: true});
    await page.locator('.model-recovery-toggle').click();
    await page.locator('.turn-activity-head').click();
    if (!baseline) {
      // Scope guard: without the desktop host marker the shared/iOS cascade is unchanged.
      await page.locator('.desktop-conversation-flow').evaluate(el => { el.dataset.spacingHost = 'true'; el.classList.remove('desktop-conversation-flow'); });
      const shared = await measure();
      assert.equal(shared.activity.marginTop, '8px');
      assert.equal(shared.activity.marginBottom, '12px');
      assert.equal(shared.recovery.height, 40);
      await page.locator('[data-spacing-host]').evaluate(el => el.classList.add('desktop-conversation-flow'));
      // Active recovery retains the original padding and row target.
      await page.locator('.model-recovery-notice').evaluate(el => el.dataset.phase = 'waiting');
      const active = await measure();
      assert.equal(active.recovery.height, 40);
      assert.equal(active.recovery.paddingTop, '4px');
    }
    assert.deepEqual(errors, []);
    results.push({width, metrics, errors});
    await page.close();
  }
  if (!baseline) {
    // Sub-agent conversation shares the same desktop rhythm via the host scope class.
    const page = await browser.newPage({viewport: {width: 900, height: 950}, reducedMotion: 'reduce'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5197/fixtures.html?scene=subagent-conversation', {waitUntil: 'networkidle'});
    await page.locator('.h25-process-conversation').waitFor();
    const task = await page.evaluate(() => {
      const host = document.querySelector('.h25-process-conversation');
      const margins = selector => {
        const el = host.querySelector(selector);
        return el ? {top: getComputedStyle(el).marginTop, bottom: getComputedStyle(el).marginBottom} : null;
      };
      return {scoped: host.classList.contains('desktop-conversation-flow'), message: margins('.h24-hemi-message'),
        activity: margins('.turn-activity'), overflow: document.documentElement.scrollWidth > innerWidth};
    });
    assert.equal(task.scoped, true);
    assert.equal(task.message.bottom, '6px');
    // The thinking block leads the reply in this scene, so it sits flush like the main flow.
    assert.equal(task.activity.top, '0px');
    assert.equal(task.activity.bottom, '6px');
    assert.equal(task.overflow, false);
    assert.deepEqual(errors, []);
    await page.screenshot({path: path.join(out, `${mode}-subagent-900.png`), fullPage: true});
    await page.close();
  }
  if (!baseline) {
    const page = await browser.newPage({viewport: {width: 900, height: 950}, hasTouch: true});
    await page.goto('http://127.0.0.1:5197/fixtures.html?scene=desktop-flow-spacing', {waitUntil: 'networkidle'});
    assert.ok(await page.locator('.model-recovery-toggle').evaluate(el => el.getBoundingClientRect().height >= 44));
    await page.close();
  }
} finally {
  await browser.close();
  if (mode === 'built') await new Promise(resolve => server.httpServer.close(resolve));
  else await server.close();
  writeFileSync(path.join(out, `${mode}-${baseline ? 'before' : 'after'}.json`), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({mode, baseline, results}, null, 2));
