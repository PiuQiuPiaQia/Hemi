// 真实 Electron + dev/build renderer；合成长历史为外部测试资源，不调用模型。
// VITE_DEV_SERVER_URL=http://127.0.0.1:5181 node scripts/verify-065-dev-performance.mjs
// npm run build && node scripts/verify-065-dev-performance.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { createConversationStore } from '../src/main/history/conversation-store.mjs';

const runtime = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(existsSync(runtime) ? pathToFileURL(runtime).href : 'playwright');
const dev = Boolean(process.env.VITE_DEV_SERVER_URL);
const mode = dev ? 'dev' : 'built';
const out = path.resolve(`.visual/workflow/vision/065-dev-performance/${mode}`);
const ud = mkdtempSync(path.join(os.tmpdir(), 'hemi-perf-'));
mkdirSync(out, { recursive: true });
const evidence = { mode, checks: [], errors: [], samples: [], screenshots: [], userData: ud };
let electron, page;
const check = (name, ok, detail) => {
  evidence.checks.push({ name, ok, detail });
  assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${name}`);
};
const mainWindow = fn => electron.evaluate(({ BrowserWindow, app }, source) => {
  const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
  return new Function('win', 'app', source)(win, app);
}, fn);
const monitor = () => page.locator('[data-dev-performance]');
const sample = () => monitor().evaluate(el => ({
  fps: Number(el.dataset.fps), maxMs: Number(el.dataset.frameMax), longFrames: Number(el.dataset.longFrames),
  paused: el.dataset.paused, text: el.innerText,
}));
const openLong = async () => {
  const nav = page.getByRole('button', { name: '打开导航', exact: true });
  if (await nav.isVisible()) await nav.click();
  await page.locator('.h24-sidebar-open').filter({ hasText: '性能长对话' }).click();
  await page.waitForFunction(() => document.querySelector('.conversation-list')?.textContent.includes('PERF_HISTORY_159'));
};

writeFileSync(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
writeFileSync(path.join(ud, 'text-model-profiles.json'), JSON.stringify({
  version: 3, defaultModelId: 'perf/main', providers: [{ id: 'perf', name: '性能验证（不调用）', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'main', model: 'perf-test', thinkingLevel: 'off' }] }],
}));
const store = createConversationStore({ dir: path.join(ud, 'conversations') });
const turns = Array.from({ length: 160 }, (_, i) => ({
  id: `perf-${i}`, author: i % 2 ? 'hemi' : 'user', createdAt: Date.now() - 200_000 + i * 1000,
  text: `PERF_HISTORY_${i}\n\n${i % 2 ? `### 第 ${i} 条回复\n\n${'长会话的性能观测内容，包含 **Markdown** 与代码 `sample()`。'.repeat(24)}\n\n- 核对滚动\n- 核对输入\n` : '检查这一轮长对话。'}`,
}));
assert.ok(store.saveSession({ id: 'conv-perf-long', turns, profileId: 'perf/main', workspaceId: 'default' }).ok);
assert.ok(store.renameSession('conv-perf-long', '性能长对话').ok);

try {
  electron = await _electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, HEMI_USER_DATA_DIR: ud } });
  const deadline = Date.now() + 45_000;
  while (!page && Date.now() < deadline) {
    page = electron.windows().find(p => (p.url().startsWith('http') || p.url().includes('index.html')) && !new URL(p.url()).searchParams.has('mode'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, '真实主窗口载入');
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error' || msg.text().includes('[perf]')) evidence.errors.push(msg.text()); });
  // 诊断探针只数监控自己的活跃 rAF／observer，用于发现 StrictMode 重复注册。
  await page.context().addInitScript(() => {
    const raf = requestAnimationFrame, cancel = cancelAnimationFrame;
    const pending = new Set(), observers = new Set();
    window.__perfProbe = { pending, observers };
    window.requestAnimationFrame = cb => {
      const owned = new Error().stack.includes('dev-performance-monitor');
      const id = raf(t => { pending.delete(id); cb(t); });
      if (owned) pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
    const NativeObserver = PerformanceObserver;
    window.PerformanceObserver = class extends NativeObserver {
      observe(options) { if (options.type === 'long-animation-frame') observers.add(this); super.observe(options); }
      disconnect() { observers.delete(this); super.disconnect(); }
    };
  });
  await mainWindow('win.setMinimumSize(300,400);win.setContentSize(1440,900);win.show();app.focus({steal:true});win.focus()');
  await page.reload();
  await page.locator('textarea.text-composer-input').waitFor();
  evidence.rendererUrl = page.url();
  await openLong();
  check('生产会话入口打开完整长历史', await page.locator('[data-flow-row]').count() >= 160);
  const draft = 'PERF_DRAFT 编辑保存唯一标记';
  await page.locator('textarea.text-composer-input').fill(draft);
  await page.waitForTimeout(800);

  if (dev) {
    await mainWindow('win.show();app.focus({steal:true});win.focus()');
    await page.waitForTimeout(250);
    evidence.initialWindow = await page.evaluate(async () => ({ native: await window.hemiVoice.getDevWindowActivity(), hidden: document.hidden, focused: document.hasFocus(), paused: document.querySelector('[data-dev-performance]')?.dataset.paused }));
    await page.waitForFunction(() => Number(document.querySelector('[data-dev-performance]')?.dataset.fps) > 0, null, { timeout: 5000 });
    check('dev 顶栏单面板且 FPS 图实际绘制', await monitor().count() === 1 && await monitor().locator('canvas:visible').count() === 1);
    const before = await sample(); evidence.samples.push({ phase: 'before-block', ...before });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const start = performance.now(); while (performance.now() - start < 240) { /* 明确注入 renderer 故障 */ }
      resolve();
    })));
    await page.waitForFunction(previous => {
      const el = document.querySelector('[data-dev-performance]');
      return Number(el?.dataset.frameMax) >= 180 && Number(el?.dataset.longFrames) > previous;
    }, before.longFrames);
    const blocked = await sample(); evidence.samples.push({ phase: 'injected-240ms-block', ...blocked });
    check('明确阻塞反映在帧间隔和长帧增量', blocked.maxMs >= 180 && blocked.longFrames > before.longFrames, blocked);
    const probes = await page.evaluate(() => ({ raf: window.__perfProbe.pending.size, observers: window.__perfProbe.observers.size }));
    check('StrictMode 后只有一个采样循环与 observer', probes.raf === 1 && probes.observers === 1, probes);
    await mainWindow('win.hide()');
    await page.waitForTimeout(200);
    evidence.hiddenWindow = { native: await mainWindow('return {visible:win.isVisible(),focused:win.isFocused()}'), renderer: await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), paused: document.querySelector('[data-dev-performance]')?.dataset.paused })) };
    await page.waitForFunction(() => document.querySelector('[data-dev-performance]')?.dataset.paused === 'true', null, { polling: 100, timeout: 5000 });
    check('确实隐藏了真实主窗', await mainWindow('return !win.isVisible()'));
    const hidden = await page.evaluate(() => ({ raf: window.__perfProbe.pending.size, observers: window.__perfProbe.observers.size }));
    check('真实隐藏窗口释放采样与 observer', hidden.raf === 0 && hidden.observers === 0, hidden);
    await page.waitForTimeout(1500);
    await mainWindow('win.show();app.focus({steal:true});win.focus()');
    await page.waitForFunction(() => Number(document.querySelector('[data-dev-performance]')?.dataset.fps) > 0);
    const resumed = await sample(); evidence.samples.push({ phase: 'resumed', ...resumed });
    check('恢复不把后台时长计成慢帧', resumed.maxMs < 1000, resumed);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-page="settings"]'));
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.locator('textarea.text-composer-input').waitFor();
    await page.waitForFunction(() => Number(document.querySelector('[data-dev-performance]')?.dataset.fps) > 0);
    const remounted = await page.evaluate(() => ({ panels: document.querySelectorAll('[data-dev-performance]').length, raf: window.__perfProbe.pending.size, observers: window.__perfProbe.observers.size }));
    check('页面重开无重复循环或残留 observer', remounted.panels === 1 && remounted.raf === 1 && remounted.observers === 1, remounted);
  } else {
    check('构建产物没有监控面板或采样', await monitor().count() === 0 && await page.evaluate(() => window.__perfProbe.pending.size === 0 && window.__perfProbe.observers.size === 0));
    check('构建模式原生 dev 状态查询不提供活动数据', await page.evaluate(async () => await window.hemiVoice.getDevWindowActivity() === null));
    const assets = readdirSync('dist-renderer/assets').filter(f => f.endsWith('.js'));
    check('生产 JS 不含监控模块和 stats.js', assets.every(f => !/data-dev-performance|h65-perf|dev-performance-monitor|开发性能监控/.test(readFileSync(path.join('dist-renderer/assets', f), 'utf8'))));
  }
  await page.reload();
  await page.locator('textarea.text-composer-input').waitFor();
  await openLong();
  await page.waitForFunction(expected => document.querySelector('textarea.text-composer-input')?.value === expected, draft);
  check('重载重开后草稿编辑已保存', await page.locator('textarea.text-composer-input').inputValue() === draft);
  if (dev) await page.waitForFunction(() => Number(document.querySelector('[data-dev-performance]')?.dataset.fps) > 0);
  else check('构建产物重开会话仍无面板', await monitor().count() === 0);

  for (const width of [1440, 768, 375]) {
    await mainWindow(`win.setContentSize(${width},900);win.show();app.focus({steal:true});win.focus()`);
    await page.waitForTimeout(400);
    const viewport = page.locator('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
    const before = await viewport.evaluate(el => el.scrollTop);
    await viewport.hover(); await page.mouse.wheel(0, -400); await page.waitForTimeout(180);
    check(`${width} 长历史实际可以滚动`, await viewport.evaluate(el => el.scrollTop) < before);
    const layout = await page.evaluate(() => {
      const rect = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, monitor: rect('[data-dev-performance]'), call: rect('.h24-call-nav'), title: rect('.app-topbar-title'), header: rect('.app-topbar') };
    });
    const inside = r => r && r.left >= 0 && r.right <= layout.width && r.top >= 0 && r.bottom <= layout.header.bottom;
    const overlayInside = layout.monitor && layout.monitor.left >= 0 && layout.monitor.right <= layout.width && layout.monitor.top >= layout.header.bottom;
    check(`${width} 调试浮层和通话按钮无溢出`, !layout.overflow && inside(layout.call) && (!dev || overlayInside), layout);
    if (dev) {
      const isolation = await page.evaluate(() => {
        const panel = document.querySelector('[data-dev-performance]');
        const selectors = ['.app-topbar-title', '.app-topbar-actions', '.conversation-list', 'textarea.text-composer-input'];
        const rects = () => selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
        const before = rects();
        panel.style.display = 'none';
        const without = rects();
        panel.style.removeProperty('display');
        const r = panel.getBoundingClientRect();
        const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { sameLayout: JSON.stringify(before) === JSON.stringify(without), clickThrough: !panel.contains(target), portal: panel.parentElement === document.body };
      });
      check(`${width} 浮层不改变标题、按钮、消息和输入布局且鼠标穿透`, isolation.sameLayout && isolation.clickThrough && isolation.portal, isolation);
    }
    check(`${width} 通话按钮可以命中`, await page.locator('.h24-call-nav').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
    const image = path.join(out, `long-conversation-${width}.png`);
    await page.screenshot({ path: image }); evidence.screenshots.push(image);
    if (dev) evidence.samples.push({ phase: `scroll-${width}`, ...await sample() });
    if (width <= 880) {
      const nav = page.getByRole('button', { name: '打开导航', exact: true });
      await nav.click();
      const close = page.locator('.h24-nav-toggle[aria-label="关闭导航"]');
      check(`${width} 导航按钮可以打开和关闭抽屉`, await close.getAttribute('aria-expanded') === 'true');
      await close.click();
    }
  }
  check('无 renderer 错误或监控加载失败', evidence.errors.length === 0, evidence.errors);
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  console.error(error.stack);
} finally {
  if (electron) await electron.close();
  rmSync(ud, { recursive: true, force: true });
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`HEMI_PERF_RESULT=${JSON.stringify({ passed: evidence.passed === true, mode, rendererUrl: evidence.rendererUrl, checks: evidence.checks.length, error: evidence.error })}`);
  process.exitCode = evidence.passed ? 0 : 1;
}
