// 真实 Electron；不调用模型。分别验证 Vite dev renderer 与构建产物。
// VITE_DEV_SERVER_URL=http://127.0.0.1:5187 node scripts/verify-dev-performance-drag.mjs
// npm run build && node scripts/verify-dev-performance-drag.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const runtime = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(existsSync(runtime) ? pathToFileURL(runtime).href : 'playwright');
const dev = Boolean(process.env.VITE_DEV_SERVER_URL);
const mode = dev ? 'dev' : 'built';
const out = path.resolve(`.visual/workflow/vision/065-dev-performance-drag/${mode}`);
const userData = mkdtempSync(path.join(os.tmpdir(), 'hemi-perf-drag-'));
const evidence = { mode, checks: [], errors: [], screenshots: [] };
mkdirSync(out, { recursive: true });
writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
let electron, page;
const check = (name, ok, detail) => {
  evidence.checks.push({ name, ok, detail });
  assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${name}`);
};
const mainWindow = source => electron.evaluate(({ BrowserWindow, app }, source) => {
  const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
  return new Function('win', 'app', source)(win, app);
}, source);
const snapshot = async name => {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  evidence.screenshots.push(file);
};
const box = () => page.locator('[data-dev-performance]').boundingBox();
const waitAt = (x, y) => page.waitForFunction(({ x, y }) => {
  const r = document.querySelector('[data-dev-performance]').getBoundingClientRect();
  return Math.abs(r.x - x) < 1 && Math.abs(r.y - y) < 1;
}, { x, y }, { timeout: 5000 });
const inside = () => page.waitForFunction(() => {
  const r = document.querySelector('[data-dev-performance]').getBoundingClientRect();
  return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
});
const dragTo = async (x, y, attempt = 0) => {
  const handle = page.getByRole('button', { name: '移动性能监控', exact: true });
  const grip = await handle.boundingBox();
  const panel = await box();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const target = {
    x: Math.max(0, Math.min(panel.x + x - grip.x - grip.width / 2, viewport.width - panel.width)),
    y: Math.max(0, Math.min(panel.y + y - grip.y - grip.height / 2, viewport.height - panel.height)),
  };
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 4 });
  const captured = await handle.evaluate(el => el.hasPointerCapture(1));
  await page.mouse.up();
  evidence.drags ??= [];
  evidence.drags.push({ panel, target, captured, events: await page.evaluate(() => window.__dragEvents) });
  // macOS 切换应用或本机输入会取消 CDP 的捕获；重试被外部输入中断的手势。
  if (!captured && attempt < 4) return dragTo(x, y, attempt + 1);
  await waitAt(target.x, target.y);
  return captured;
};

try {
  electron = await _electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, HEMI_USER_DATA_DIR: userData } });
  const deadline = Date.now() + 45_000;
  while (!page && Date.now() < deadline) {
    page = electron.windows().find(p => (p.url().startsWith('http') || p.url().includes('index.html')) && !new URL(p.url()).searchParams.has('mode'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, '真实主窗口载入');
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('console', msg => { if (msg.text().includes('[perf]')) evidence.errors.push(msg.text()); });
  await page.locator('textarea.text-composer-input').waitFor();
  // 保持真实可见状态与渲染，移出屏幕以免本机鼠标／键盘打断指针捕获。
  await mainWindow('win.setFocusable(false);win.setMinimumSize(300,400);win.setContentSize(1440,900);win.showInactive();win.setPosition(-5000,0)');
  await page.waitForFunction(() => innerWidth === 1440);
  evidence.rendererUrl = page.url();

  if (dev) {
    await page.waitForFunction(() => Number(document.querySelector('[data-dev-performance]')?.dataset.fps) > 0);
    check('开发模式只有一个性能面板和实际绘制的 FPS 图', await page.locator('[data-dev-performance]').count() === 1 && await page.locator('[data-dev-performance] canvas:visible').count() === 1);
    check('使用真实窗口活动 IPC', await page.evaluate(async () => (await window.hemiVoice.getDevWindowActivity())?.visible === true));
    await page.evaluate(() => {
      const pending = new Set();
      window.__dragSampling = { pending };
      const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
      window.requestAnimationFrame = callback => {
        const owned = new Error().stack.includes('dev-performance-monitor');
        const id = raf(time => { pending.delete(id); callback(time); });
        if (owned) pending.add(id);
        return id;
      };
      window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
    });
    await page.locator('[data-dev-performance]').evaluate(el => { window.__dragPanel = el; });
    const original = await box();
    const grip = await page.getByRole('button', { name: '移动性能监控', exact: true }).boundingBox();
    await page.getByRole('button', { name: '移动性能监控', exact: true }).evaluate(el => {
      window.__dragEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        el.addEventListener(type, event => window.__dragEvents.push({ type, x: event.clientX, y: event.clientY, id: event.pointerId, capture: el.hasPointerCapture(event.pointerId), buttons: event.buttons }));
      }
    });
    const captured = await dragTo(grip.x + grip.width / 2 - 440, grip.y + grip.height / 2 - 320);
    evidence.firstDrag = { original, actual: await box(), captured, events: await page.evaluate(() => window.__dragEvents) };
    await waitAt(original.x - 440, original.y - 320);
    check('按住 FPS 图可拖动，离开手柄仍捕获指针', captured, { original, moved: await box() });
    const moved = await box();
    await page.mouse.move(120, 200);
    check('松手后不跟随鼠标', (await box()).x === moved.x && (await box()).y === moved.y);
    const handle = page.getByRole('button', { name: '移动性能监控', exact: true });
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await waitAt(moved.x - 8, moved.y - 32);
    check('方向键和 Shift 支持键盘移动', true, await box());
    const keyed = await box();
    const nextGrip = await handle.boundingBox();
    await page.mouse.move(nextGrip.x + nextGrip.width / 2, nextGrip.y + nextGrip.height / 2);
    await page.mouse.down();
    await handle.evaluate(el => el.releasePointerCapture(1));
    await page.mouse.move(120, 200);
    await page.mouse.up();
    check('丢失捕获后结束拖动', (await box()).x === keyed.x && (await box()).y === keyed.y);
    check('拖动没有重新挂载性能组件', await page.locator('[data-dev-performance]').evaluate(el => el === window.__dragPanel));
    await snapshot('dragged-monitor');
  } else {
    check('构建模式没有开发性能面板', await page.locator('[data-dev-performance]').count() === 0);
    check('构建模式真实 IPC 不返回开发窗口状态', await page.evaluate(async () => await window.hemiVoice.getDevWindowActivity() === null));
    const assets = readdirSync('dist-renderer/assets').filter(f => f.endsWith('.js'));
    check('生产 JS 不包含监控或拖动代码', assets.every(f => !/data-dev-performance|h65-perf|dev-performance-monitor|移动性能监控/.test(readFileSync(path.join('dist-renderer/assets', f), 'utf8'))));
  }

  for (const width of [375, 768, 1440]) {
    await mainWindow(`win.setContentSize(${width},900);win.setPosition(-5000,0)`);
    await page.waitForFunction(width => innerWidth === width, width);
    check(`${width} 主界面没有横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (dev) {
      await inside();
      check(`${width} 窗口缩放后面板完整可见`, true, await box());
      const hit = await page.locator('[data-dev-performance]').evaluate(panel => {
        const grip = panel.querySelector('button').getBoundingClientRect();
        const counts = panel.querySelector('.h65-perf-counts').getBoundingClientRect();
        return {
          handle: document.elementFromPoint(grip.x + grip.width / 2, grip.y + grip.height / 2) === panel.querySelector('button'),
          clickThrough: !panel.contains(document.elementFromPoint(counts.x + counts.width / 2, counts.y + counts.height / 2)),
          portal: panel.parentElement === document.body,
        };
      });
      check(`${width} FPS 手柄可抓取，数值区域鼠标穿透`, hit.handle && hit.clickThrough && hit.portal, hit);
      await dragTo(0, 100);
      await page.waitForFunction(() => document.querySelector('[data-dev-performance]').getBoundingClientRect().left === 0);
      await inside();
      check(`${width} 左侧边界限制有效`, true, await box());
      const height = await page.evaluate(() => innerHeight);
      await dragTo(width - 1, height - 1);
      await page.waitForFunction(() => {
        const r = document.querySelector('[data-dev-performance]').getBoundingClientRect();
        return Math.abs(r.right - innerWidth) < 1 && Math.abs(r.bottom - innerHeight) < 1;
      });
      await inside();
      check(`${width} 右下边界限制有效`, true, await box());
      await page.waitForFunction(() => Number(document.querySelector('[data-dev-performance]')?.dataset.fps) > 0);
    }
    await snapshot(`main-${width}`);
  }
  if (dev) {
    await page.waitForFunction(() => window.__dragSampling.pending.size === 1);
    check('拖动和缩放后只保留一个采样循环', true);
  }
  check('没有 renderer 错误或监控加载错误', evidence.errors.length === 0, evidence.errors);
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  if (page && !page.isClosed()) await snapshot('failure').catch(() => {});
  console.error(error.stack);
} finally {
  if (electron) await electron.close();
  rmSync(userData, { recursive: true, force: true });
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`HEMI_PERF_DRAG_RESULT=${JSON.stringify({ passed: evidence.passed === true, mode, checks: evidence.checks.length })}`);
  process.exitCode = evidence.passed ? 0 : 1;
}
