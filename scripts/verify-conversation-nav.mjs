// Focused real Electron/IPC check. Run with and without VITE_DEV_SERVER_URL.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const out = path.resolve(process.env.HEMI_NAV_EVIDENCE ?? `.visual/workflow/vision/conversation-nav/${mode}`);
const userData = await fs.mkdtemp(path.join(os.tmpdir(), `hemi-conversation-nav-${mode}-`));
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
await fs.writeFile(path.join(userData, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'cafe-orange', mode: 'light' }));
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`,
  mode, userData, checks: [], errors: [], screenshots: [],
};
const check = (name, value = true) => { assert.ok(value, name); report.checks.push(name); console.log(`PASS ${name}`); };
let app, page;
try {
  app = await _electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, HEMI_USER_DATA_DIR: userData } });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED' && ['script', 'stylesheet', 'image'].includes(request.resourceType())) report.errors.push(request.url());
  });
  await page.locator('textarea.text-composer-input').waitFor();
  // A reload completes cold startup before exercising only the navigation lifecycle.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.appearance-stage')?.dataset.startup === 'done');
  await page.evaluate(async () => {
    for (let i = 1; i <= 35; i++) {
      const id = `conv-nav-check-${i}`;
      const saved = await window.hemiVoice.saveConversation({ id, turns: [
        { id: `user-${i}`, author: 'user', text: `验证消息 ${i}`, createdAt: Date.now() },
        { id: `reply-${i}`, author: 'hemi', text: `历史回复 ${i}`, createdAt: Date.now() },
      ] });
      if (!saved.ok) throw new Error(`Failed to seed ${id}`);
      await window.hemiVoice.renameConversation(id, `悬浮列表验证 ${String(i).padStart(2, '0')}`);
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.h24-sidebar-item').length === 35);
  const resize = async width => {
    await page.bringToFront();
    await app.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
      win.setMinimumSize(1, 1); win.setContentSize(width, 860); win.show();
    }, width);
    await page.waitForFunction(width => innerWidth === width, width);
    await page.mouse.move(width - 30, 430);
    await page.locator('textarea.text-composer-input').click();
    if (width <= 880) await sidebar.waitFor({ state: 'hidden' });
  };
  const sidebar = page.locator('.h24-sidebar');
  const workspace = page.locator('.h24-workspace');
  const trigger = page.getByRole('button', { name: '对话', exact: true });
  const openPreview = async () => {
    await page.bringToFront();
    await trigger.hover();
    await page.waitForFunction(() => document.querySelector('.h24-workspace').dataset.navPreview === 'true');
    await sidebar.waitFor({ state: 'visible' });
    // Wait for the actual drawer animation before measuring or crossing its edge.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.h24-sidebar')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
  };
  const closed = () => page.waitForFunction(() => document.querySelector('.h24-workspace').dataset.navOpen === 'false');
  const shot = async name => { await page.screenshot({ path: path.join(out, `${name}.png`), scale: 'css' }); report.screenshots.push(`${name}.png`); };
  await page.evaluate(() => {
    window.__navEvents = [];
    for (const type of ['pointerenter', 'pointerleave', 'focus', 'blur']) document.addEventListener(type, event => {
      if (event.target.matches?.('.h24-sidebar, .h24-navrail-item')) {
        window.__navEvents.push({ type, target: event.target.className, related: event.relatedTarget?.className, at: performance.now(), width: innerWidth });
      }
    }, true);
  });

  for (const width of [768, 880, 560, 375]) {
    await resize(width);
    check(`${width}: collapsed list starts hidden`, !(await sidebar.isVisible()));
    const before = await page.locator('.h24-main').boundingBox();
    await openPreview();
    const geometry = await sidebar.evaluate(el => {
      const r = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
      return { absolute: getComputedStyle(el).position === 'absolute', x: r.x, y: r.y, width: r.width, height: r.height, parentHeight: parent.height, right: r.right, viewport: innerWidth };
    });
    check(`${width}: full-height overlay stays within viewport`, geometry.absolute && geometry.y >= 50 && Math.abs(geometry.height - geometry.parentHeight) < 1 && geometry.right <= geometry.viewport);
    check(`${width}: hover does not dim or shift conversation`, !(await page.locator('.h24-backdrop').isVisible()) && JSON.stringify(before) === JSON.stringify(await page.locator('.h24-main').boundingBox()));
    check(`${width}: trigger exposes expanded list`, await trigger.getAttribute('aria-expanded') === 'true');
    const box = await sidebar.boundingBox();
    await page.mouse.move(box.x + 25, box.y + 100, { steps: 12 });
    await page.waitForTimeout(300);
    check(`${width}: crossing from icon keeps list open`, await workspace.getAttribute('data-nav-open') === 'true');
    await shot(`orange-hover-${width}`);
    await page.mouse.move(width - 20, 440);
    await closed();
    await sidebar.waitFor({ state: 'hidden' });
    check(`${width}: leaving hover closes the list`);
  }

  await resize(768);
  await openPreview();
  await page.locator('.h24-sidebar-nav').hover();
  await page.mouse.wheel(0, 1600);
  await page.waitForFunction(() => document.querySelector('.h24-sidebar-nav').scrollTop > 0);
  await page.waitForTimeout(300);
  check('long history scrolls while preview stays open', await workspace.getAttribute('data-nav-open') === 'true');
  const row = sidebar.locator('.h24-sidebar-open').last();
  const selected = (await row.innerText()).trim();
  await row.click();
  await closed();
  await page.waitForFunction(title => document.querySelector('.h24-conversation-title').textContent === title, selected);
  check('selecting real persisted history opens conversation and closes preview');
  await openPreview();
  await shot('orange-history-hover-768');
  await sidebar.getByRole('button', { name: '查看全部会话', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await closed();
  await sidebar.waitFor({ state: 'hidden' });
  check('full history dialog does not reopen collapsed list on focus');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('textarea.text-composer-input').click();
  await openPreview();
  await page.locator('.h24-sidebar-nav').evaluate(el => { el.scrollTop = 0; });
  await sidebar.locator('.h24-sidebar-open').first().click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  await page.getByRole('menuitem', { name: '复制会话 ID' }).hover();
  await page.waitForTimeout(350);
  check('portalled context menu keeps preview available', await sidebar.isVisible());
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.locator('textarea.text-composer-input').click();
  await closed();

  await page.keyboard.press('Tab');
  await trigger.focus();
  await sidebar.waitFor({ state: 'visible' });
  await sidebar.locator('.h24-sidebar-new').focus();
  await page.mouse.move(740, 430);
  await page.waitForTimeout(350);
  check('keyboard focus retains preview without pointer', await sidebar.isVisible() && await workspace.getAttribute('data-nav-open') === 'true');
  await page.keyboard.press('Escape');
  await closed();
  check('Escape closes preview and returns focus to icon', await trigger.evaluate(el => el === document.activeElement));
  await trigger.click();
  await page.waitForFunction(() => document.querySelector('.h24-workspace').dataset.navOpen === 'true');
  await page.mouse.move(740, 430);
  await page.waitForTimeout(350);
  check('click keeps drawer open with dismissible backdrop', await page.locator('.h24-backdrop').isVisible());
  await page.locator('.h24-backdrop').click({ position: { x: 600, y: 350 } });
  await closed();
  await trigger.click();
  await trigger.click();
  await closed();
  await page.mouse.move(740, 430);
  await sidebar.waitFor({ state: 'hidden' });
  await openPreview();
  await page.mouse.move(740, 430);
  await closed();
  check('mouse focus on icon does not prevent later hover dismissal');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await sidebar.waitFor({ state: 'visible' });
  await sidebar.locator('.h24-sidebar-new').click();
  await closed();
  check('topbar drawer and new conversation still work');

  await page.getByRole('button', { name: '技能中心', exact: true }).click();
  await trigger.hover();
  await page.waitForTimeout(300);
  check('hover does not navigate away from skills or reveal hidden list', !(await sidebar.isVisible()) && await workspace.getAttribute('data-nav-open') === 'false');
  await trigger.click();
  await page.locator('textarea.text-composer-input').click();
  await page.evaluate(() => window.hemiVoice.setAppearance({ requestId: 'nav-check-classic', skinId: 'classic', mode: 'light' }));
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'classic');
  await openPreview();
  await shot('classic-hover-768');
  check('classic skin also supports hover preview');
  await resize(1440);
  check('wide layout keeps sidebar in normal flow', await sidebar.isVisible() && await sidebar.evaluate(el => getComputedStyle(el).position !== 'absolute'));
  await shot('classic-wide-1440');
  await resize(768);
  check('returning to narrow layout clears stale drawer state', await workspace.getAttribute('data-nav-open') === 'false');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPreview();
  check('reduced motion still exposes complete list');
  check('no horizontal document overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('no renderer or asset errors', report.errors.length === 0);
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) report.debug = await page.evaluate(() => ({
    events: window.__navEvents, focused: document.activeElement?.outerHTML,
    state: document.querySelector('.h24-workspace')?.dataset.navOpen,
    hovered: [...document.querySelectorAll(':hover')].map(el => el.className),
  })).catch(() => null);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png'), scale: 'css' }).catch(() => {});
  throw error;
} finally {
  if (app) { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(userData, { recursive: true, force: true });
}
