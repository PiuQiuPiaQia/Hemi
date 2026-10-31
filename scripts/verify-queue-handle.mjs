// Focused renderer fixture check; no application data or model connections.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build, createServer, preview} from 'vite';
import {chromium} from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, '.visual/queue-handle');
await mkdir(evidence, {recursive: true});
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(),
  workingTree: true, node: process.version, environment: `${process.platform}/${process.arch}`,
  command: 'node scripts/verify-queue-handle.mjs', results: [], traces: [],
  gaps: ['Renderer fixtures only; host queue dispatch is unchanged and not exercised.'],
};
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.HEMI_DESIGN_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  for (const mode of ['dev', 'built']) {
    let server, directory, context;
    const errors = [];
    try {
      if (mode === 'built') {
        directory = await mkdtemp(path.join(os.tmpdir(), 'hemi-queue-handle-'));
        await build({configFile: path.join(root, 'vite.config.ts'), build: {outDir: directory, rollupOptions: {input: path.join(root, 'src/renderer/fixtures.html')}}});
        server = await preview({configFile: path.join(root, 'vite.config.ts'), build: {outDir: directory}, preview: {host: '127.0.0.1', port: 0, strictPort: false}});
      } else {
        server = await createServer({configFile: path.join(root, 'vite.config.ts'), server: {host: '127.0.0.1', port: 0, strictPort: false}});
        await server.listen();
      }
      const base = `http://127.0.0.1:${server.httpServer.address().port}`;
      context = await browser.newContext({viewport: {width: 1000, height: 800}});
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/fixtures.html?scene=composer-queue-sortable`);
      const rows = page.locator('.h24-queue-item');
      await rows.first().waitFor();
      assert.equal(await rows.count(), 3);
      assert.equal(await page.locator('.h24-queue-order').count(), 0);
      assert.equal(await page.locator('.h24-queue-drag svg').count(), 3);
      const before = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.queueItemId));
      const handle = page.locator('.h24-queue-drag').first();
      assert.equal(await handle.isEnabled(), true);
      const from = await handle.boundingBox(), to = await rows.nth(1).boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, {steps: 3});
      await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, {steps: 10});
      await page.mouse.up();
      await page.waitForFunction(first => document.querySelector('.h24-queue-item')?.dataset.queueItemId !== first, before[0]);
      assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.queueItemId)), [before[1], before[0], before[2]]);
      await page.screenshot({path: path.join(evidence, `${mode}-multiple.png`)});
      await page.getByRole('button', {name: '撤回这条', exact: true}).first().click();
      await page.getByRole('button', {name: '撤回这条', exact: true}).first().click();
      assert.equal(await rows.count(), 1);
      assert.equal(await page.locator('.h24-queue-order').count(), 0);
      assert.equal(await page.locator('.h24-queue-drag svg').count(), 1);
      assert.equal(await handle.isDisabled(), true);
      assert.equal(await handle.isVisible(), true);
      assert.ok(Number(await handle.evaluate(node => getComputedStyle(node).opacity)) > 0);
      await page.screenshot({path: path.join(evidence, `${mode}-single.png`)});
      // 慢回执场景：落手后不许先弹回旧顺序（拖拽完抖动的回归检查）。
      await page.goto(`${base}/fixtures.html?scene=composer-queue-slow-sort`);
      await rows.first().waitFor();
      assert.equal(await rows.count(), 3);
      const slowBefore = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.queueItemId));
      await page.evaluate(() => {
        window.__sortTrace = [];
        const sample = () => {
          const items = [...document.querySelectorAll('.h24-queue-item')];
          window.__sortTrace.push({
            dropped: Boolean(window.__sortDropped),
            dom: items.map(node => node.dataset.queueItemId),
            visual: items.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map(node => node.dataset.queueItemId),
          });
          if (!window.__sortTraceStop) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const dragFrom = await page.locator('.h24-queue-drag').first().boundingBox();
      const dragTo = await rows.nth(1).boundingBox();
      await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2);
      await page.mouse.down();
      await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2 + 8, {steps: 3});
      await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragTo.y + dragTo.height / 2, {steps: 10});
      // 拖拽中：滚动容器横向裁剪，被拖卡片两侧须留出线框余量（边框不被遮）。
      const midDrag = await page.evaluate(() => {
        const active = document.querySelector('.h24-queue-item[data-dragging="true"]');
        const list = document.querySelector('.h24-queue-list');
        if (!active || !list) return null;
        const a = active.getBoundingClientRect(), l = list.getBoundingClientRect();
        return { leftInset: a.left - l.left, rightInset: l.right - a.right, overflowX: getComputedStyle(list).overflowX };
      });
      assert.ok(midDrag, 'dragging card found');
      assert.equal(midDrag.overflowX, 'auto', 'list clips horizontally');
      assert.ok(midDrag.leftInset >= 1 && midDrag.rightInset >= 1, `side frame room missing: ${JSON.stringify(midDrag)}`);
      await page.screenshot({path: path.join(evidence, `${mode}-dragging.png`)});
      await page.mouse.up();
      await page.evaluate(() => { window.__sortDropped = true; });
      await page.waitForTimeout(700);
      const trace = await page.evaluate(() => { window.__sortTraceStop = true; return window.__sortTrace; });
      const oldOrder = slowBefore.join(',');
      const finalOrder = [slowBefore[1], slowBefore[0], slowBefore[2]].join(',');
      const postDrop = trace.filter(frame => frame.dropped);
      const bounced = postDrop.filter(frame => frame.visual.join(',') === oldOrder);
      assert.ok(postDrop.length > 10, `expected sampled frames after drop, got ${postDrop.length}`);
      assert.deepEqual(bounced, []);
      assert.equal(trace.at(-1).dom.join(','), finalOrder);
      assert.equal(trace.at(-1).visual.join(','), finalOrder);
      report.traces.push({mode, frames: trace.length, postDrop: postDrop.length, bounced: bounced.length});
      await page.screenshot({path: path.join(evidence, `${mode}-slow-sort.png`)});
      assert.deepEqual(errors, []);
      report.results.push({mode, checks: ['no row numbers', 'visible grip for single and multiple items', 'pointer drag reorders multiple items', 'single item cannot reorder', 'slow ack does not bounce back to old order'], errors});
      console.log(`PASS ${mode}: queue handles, pointer reorder and no bounce on slow ack`);
    } finally {
      await context?.close();
      await server?.close();
      if (directory) await rm(directory, {recursive: true, force: true});
    }
  }
} finally {
  await browser?.close();
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
