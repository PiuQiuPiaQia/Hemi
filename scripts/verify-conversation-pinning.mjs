// Focused real Electron/preload/IPC/storage and UI check; run in dev and built modes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import electronPath from 'electron';
import {_electron} from 'playwright-core';
import {createConversationStore} from '../src/main/history/conversation-store.mjs';
import {initializeRuntimeStorage, runtimeDataDir} from '../src/main/agent-runtime/storage-migration.mjs';

const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const out = path.resolve(`.visual/workflow/vision/conversation-pinning/${mode}`);
const userData = await fs.mkdtemp(path.join(os.tmpdir(), `hemi-pinning-${mode}-`));
await fs.mkdir(out, {recursive: true});
await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
await fs.writeFile(path.join(userData, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'cafe-orange', mode: 'light'}));
await initializeRuntimeStorage({userDataDir: userData});
const conversationDir = path.join(runtimeDataDir(userData), 'conversations');
const store = createConversationStore({dir: conversationDir});
for (const [id, title, age] of [
  ['conv-pin-old', '长期项目笔记', 30 * 86400_000],
  ['conv-pin-new', '整理本周任务', 0],
  ['conv-pin-other', '产品体验讨论', 1000],
]) {
  const now = Date.now() - age;
  assert.equal(store.saveSession({id, now, turns: [
    {id: `${id}-user`, author: 'user', text: title, createdAt: now},
    {id: `${id}-reply`, author: 'hemi', text: '已保存的历史回复。', createdAt: now},
  ]}).ok, true);
  store.renameSession(id, title);
}
await fs.writeFile(path.join(conversationDir, 'conv-pin-corrupt.json'), '{');
await fs.writeFile(path.join(userData, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(), workingTree: true,
  mode, node: process.version, platform: `${process.platform}/${process.arch}`, checks: [], errors: [], screenshots: []};
const check = (name, ok = true) => {assert.ok(ok, name); report.checks.push(name); console.log(`PASS ${name}`);};
let app, page;
const launch = async () => {
  app = await _electron.launch({executablePath: electronPath, args: ['.'], env: {...process.env, HEMI_USER_DATA_DIR: userData}});
  app.process().stderr.on('data', chunk => { report.mainErrors ??= []; report.mainErrors.push(String(chunk)); });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') report.errors.push(message.text());});
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED' && ['script', 'stylesheet', 'image'].includes(request.resourceType())) report.errors.push(request.url());
  });
  await page.locator('textarea.text-composer-input').waitFor();
  await app.evaluate(({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(1, 1); win.setContentSize(1440, 900); win.show();
  });
  await page.waitForFunction(() => document.querySelector('.appearance-stage')?.dataset.startup === 'done');
  report.rendererUrl = page.url();
};
const row = title => page.locator('.h24-sidebar-item').filter({hasText: title});
const pinned = () => page.locator('.h24-sidebar-group[aria-label="置顶"]');
const menu = name => page.getByRole('menuitem', {name, exact: true});
const closeMenu = async () => {await page.keyboard.press('Escape'); await page.locator('.h37-menu').waitFor({state: 'hidden'});};
const toggle = async (title, label) => {await row(title).click({button: 'right'}); await menu(label).click();};
const waitPins = ids => page.waitForFunction(ids => {
  const titles = [...document.querySelectorAll('.h24-sidebar-group[aria-label="置顶"] .h24-sidebar-item-text')].map(el => el.textContent);
  return JSON.stringify(titles) === JSON.stringify(ids);
}, ids);
const shot = async name => {
  await page.locator('.h37-menu').evaluateAll(menus => Promise.all(menus.flatMap(el => el.getAnimations().map(animation => animation.finished.catch(() => {})))));
  await page.screenshot({path: path.join(out, `${name}.png`), scale: 'css'});
  report.screenshots.push(`${name}.png`);
};
try {
  await launch();
  await row('长期项目笔记').waitFor();
  check('no empty pinned group', await pinned().count() === 0);
  const before = await page.evaluate(async () => (await window.hemiVoice.listConversations()).sessions.find(s => s.id === 'conv-pin-old'));
  await toggle('长期项目笔记', '置顶会话');
  await waitPins(['长期项目笔记']);
  check('right-click pin moves old conversation to first group', await page.locator('.h24-sidebar-group').first().getAttribute('aria-label') === '置顶');
  check('pinned conversation is not duplicated', await row('长期项目笔记').count() === 1);
  const after = await page.evaluate(async () => (await window.hemiVoice.listConversations()).sessions.find(s => s.id === 'conv-pin-old'));
  check('pin persists without changing activity timestamps', after.pinned && before.updatedAt === after.updatedAt && before.lastOpenedAt === after.lastOpenedAt);
  await row('长期项目笔记').click({button: 'right'});
  await menu('取消置顶').waitFor();
  await shot('pin-menu-1440');
  await closeMenu();
  await toggle('整理本周任务', '置顶会话');
  await page.waitForFunction(() => document.querySelectorAll('.h24-sidebar-group[aria-label="置顶"] .h24-sidebar-item').length === 2);
  check('multiple pinned conversations share one top group', await pinned().count() === 1);

  // Exercise the existing real pointer sensor inside the pinned group.
  const originalOrder = await pinned().locator('.h24-sidebar-item-text').allTextContents();
  await page.waitForTimeout(250);
  const from = await pinned().locator('.h24-sidebar-item').first().boundingBox();
  const to = await pinned().locator('.h24-sidebar-item').last().boundingBox();
  await page.mouse.move(from.x + 50, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2 + 8);
  await page.mouse.move(to.x + 50, to.y + to.height / 2, {steps: 10});
  await page.waitForTimeout(100); await page.mouse.up();
  await waitPins([...originalOrder].reverse());
  check('pinned group supports existing drag reorder');
  await page.reload(); await row('长期项目笔记').waitFor();
  await waitPins([...originalOrder].reverse());
  check('reload retains pin and manual order');
  await row('长期项目笔记').locator('.h24-sidebar-open').click();
  await page.waitForFunction(() => document.querySelector('.h24-conversation-title')?.textContent === '长期项目笔记');
  await waitPins([...originalOrder].reverse());
  check('opening pinned conversation keeps it in pinned group');
  await row('长期项目笔记').click({button: 'right'});
  await menu('取消置顶').focus(); await page.keyboard.press('Enter');
  await waitPins(['整理本周任务']);
  check('keyboard unpin returns conversation to its current time group', await row('长期项目笔记').evaluate(el => el.closest('section').getAttribute('aria-label')) === '今天');

  await page.getByRole('button', {name: '查看全部会话', exact: true}).click();
  const history = page.locator('.history-item').filter({hasText: '产品体验讨论'});
  await history.click({button: 'right'}); await menu('置顶会话').click();
  await page.waitForFunction(() => document.querySelectorAll('.h24-sidebar-group[aria-label="置顶"] .h24-sidebar-item').length === 2);
  check('history context menu pins and updates sidebar');
  await closeMenu();
  await toggle('产品体验讨论', '取消置顶');
  await waitPins(['整理本周任务']);
  await app.close(); app = null;
  await launch(); await waitPins(['整理本周任务']);
  check('full application restart retains pinned group');
  const saved = JSON.parse(await fs.readFile(path.join(conversationDir, 'conv-pin-new.json'), 'utf8'));
  check('pin exists in actual conversation file', saved.pinned === true);

  for (const width of [1440, 768, 375]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).setContentSize(width, 900), width);
    await page.waitForFunction(width => innerWidth === width, width);
    if (width <= 880) await page.getByRole('button', {name: '打开导航', exact: true}).click();
    await pinned().waitFor({state: 'visible'});
    await row('整理本周任务').click({button: 'right'}); await menu('取消置顶').waitFor();
    check(`${width}: pin menu fits viewport`, await menu('取消置顶').evaluate(el => {const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;}));
    check(`${width}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot(`pinned-${width}`); await closeMenu();
    if (width <= 880) await page.locator('textarea.text-composer-input').click({force: true});
  }
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).setContentSize(1440, 900));
  await page.waitForFunction(() => innerWidth === 1440);
  report.skipped = ['Dark mode: current appearance schema supports light mode only.'];
  await page.evaluate(() => window.hemiVoice.setAppearance({requestId: 'pinning-classic', skinId: 'classic', mode: 'light'}));
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'classic');
  await page.waitForTimeout(250); // Allow the appearance surface to finish replacing the old tree.
  await row('整理本周任务').click({button: 'right'}); await menu('取消置顶').waitFor();
  await shot('pinned-1440-classic'); await closeMenu();
  check('classic skin renders pinned group and menu');
  await row('(记录损坏)').click({button: 'right'});
  check('corrupt conversation cannot be pinned', await menu('置顶会话').isDisabled());
  await closeMenu();
  await assert.rejects(page.evaluate(() => window.hemiVoice.setConversationPinned('conv-missing', true)), /找不到该会话/);
  check('actual IPC rejects missing conversation');
  await toggle('整理本周任务', '取消置顶');
  await page.waitForFunction(() => !document.querySelector('.h24-sidebar-group[aria-label="置顶"]'));
  check('last unpin removes empty group');
  await toggle('产品体验讨论', '置顶会话');
  await waitPins(['产品体验讨论']);
  await row('产品体验讨论').click({button: 'right'});
  await menu('删除会话').click(); await menu('确认删除').click();
  await page.waitForFunction(() => !document.querySelector('.h24-sidebar-group[aria-label="置顶"]'));
  check('deleting pinned conversation removes row and empty group', await row('产品体验讨论').count() === 0);
  check('no renderer or asset errors', report.errors.length === 0);
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) report.debug = await page.evaluate(() => ({focus: document.activeElement?.outerHTML.slice(0, 1000), pinned: [...document.querySelectorAll('.h24-sidebar-group[aria-label="置顶"] .h24-sidebar-item-text')].map(el => el.textContent)})).catch(() => null);
  if (page && !page.isClosed()) await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(userData, {recursive: true, force: true});
}
