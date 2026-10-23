// Application navigation regression through the actual Electron preload and IPC.
// Uses fresh data only; an offline cache exercises Bot chat without a cloud host.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { createFlowSnapshot } from '../src/shared/conversation-flow.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.join(repo, '.visual/workflow/nav-rail', mode);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-nav-rail-'));
const profile = path.join(root, 'profile');
const playwright = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(playwright).href);
const labels = ['对话', 'Bot', '技能中心', '工作流', '换肤', '设置'];
const report = { mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, checks: [], errors: [], screenshots: [], sources: {} };
for (const file of ['src/renderer/src/windows/voice/nav-rail.tsx', 'src/renderer/src/windows/voice/page.tsx', 'src/renderer/src/windows/voice/lib/conversation-bridge.tsx', 'src/renderer/src/styles/037-shell.css', 'src/renderer/src/components/skin-picker.tsx', 'src/renderer/src/windows/bot/page.tsx', 'src/renderer/src/windows/bot/styles.css']) report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
await fs.mkdir(evidence, { recursive: true });
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'cafe-purple', mode: 'light' }));
const ssh = path.join(root, 'ssh');
await fs.writeFile(ssh, '#!/bin/sh\nexit 255\n', { mode: 0o700 });
let app, page;
const note = name => { report.checks.push(name); console.log('PASS', name); };
const rail = () => page.locator('nav.h24-navrail');
const button = name => rail().getByRole('button', { name, exact: true });
async function resize(width, height = 800) {
  await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(1, 1); win.setContentSize(size.width, size.height); win.show(); win.focus(); }, { width, height });
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height });
}
async function current(name) {
  await rail().locator(`button[aria-label="${name}"][aria-current="page"]`).waitFor();
  assert.deepEqual(await rail().locator('[aria-current="page"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))), [name]);
  assert.equal(await rail().locator('[data-current="true"]').count(), 1);
  const environment = await app.evaluate((_, file) => process.getBuiltinModule('node:module').createRequire(process.cwd() + '/package.json')(file).state.conversationEnvironment, path.join(repo, 'src/main/state.mjs'));
  assert.equal(environment, name === 'Bot' ? 'bot' : 'local', 'actual main-process runtime matches selected page');
  assert.deepEqual(await rail().locator('button').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))), labels);
}
async function navigate(name) { await button(name).click(); await current(name); }
async function layout(label) {
  const actual = await rail().evaluate(nav => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
    return { nav: rect(nav), frame: rect(nav.parentElement), items: [...nav.querySelectorAll('button')].map(rect), width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.equal(actual.nav.width, 48, label);
  assert.ok(Math.abs(actual.nav.bottom - actual.height) <= 1, `${label}: rail fills frame`);
  assert.ok(actual.items.at(-1).bottom <= actual.height && actual.items.at(-1).bottom >= actual.height - 16, `${label}: settings stays at bottom`);
  assert.ok(actual.items.every(r => r.width === 32 && r.height === 32 && r.x >= 0 && r.right <= 48 && r.y >= actual.nav.y && r.bottom <= actual.nav.bottom), `${label}: no icon clips or shrinks`);
  assert.ok(actual.items.every((r, i) => !i || r.y >= actual.items[i - 1].bottom), `${label}: no overlap`);
  assert.ok(actual.scrollWidth <= actual.width, `${label}: no horizontal overflow`);
  for (const icon of await rail().locator('svg').evaluateAll(nodes => nodes.map(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, hidden: n.getAttribute('aria-hidden') })))) assert.deepEqual(icon, { width: 16, height: 16, hidden: 'true' });
  note(label);
}
async function capture(name) { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file); }
async function launch() {
  app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env: { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_TEST_MIC_GRANT: '1' } });
  for (let n = 0; n < 300; n++) {
    page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'main window');
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('textarea.text-composer-input').waitFor();
  await resize(1440);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-startup="done"]'));
  console.log('Application ready', mode);
}
try {
  await launch();
  const draft = 'NAV_LOCAL_DRAFT';
  await page.locator('textarea.text-composer-input').fill(draft);
  await current('对话');
  for (const name of ['Bot', '技能中心', '工作流', '设置', 'Bot', '对话']) {
    await navigate(name);
    if (name === 'Bot') await page.getByRole('heading', { name: /让 Hemi 在云端持续工作/ }).waitFor();
    if (name === '技能中心') await page.locator('[data-market-open="true"]').waitFor();
    if (name === '工作流') await page.locator('[data-testid="workflow-studio"]').waitFor();
    if (name === '设置') await page.locator('[data-page="settings"]').first().waitFor();
    await layout(`${name}: stable order, one selected page, utilities pinned`);
  }
  assert.equal(await page.locator('textarea.text-composer-input').inputValue(), draft);
  note('Local draft survives navigation through all global destinations');
  await navigate('设置');
  await page.getByRole('navigation', { name: '设置导航', exact: true }).getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '添加记忆', exact: true }).first().click();
  await page.getByRole('textbox', { name: '记忆标题', exact: true }).fill('Navigation guard');
  await page.getByRole('textbox', { name: '记忆正文', exact: true }).fill('Unsaved content');
  await button('Bot').click();
  await page.getByRole('heading', { name: '还有修改没保存', exact: true }).waitFor();
  await current('设置');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '记忆正文', exact: true }).inputValue(), 'Unsaved content');
  await button('工作流').click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await current('工作流');
  note('Global navigation preserves the memory editor leave/cancel guard');
  await page.getByRole('button', { name: '新建工作流', exact: true }).first().click();
  await page.getByRole('textbox', { name: '工作流名称', exact: true }).fill('Unsaved navigation workflow');
  await button('Bot').click();
  await page.getByRole('heading', { name: '流程尚未保存', exact: true }).waitFor();
  await current('工作流');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await button('对话').click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await current('对话');
  note('Global navigation preserves the workflow editor leave/cancel guard');
  await navigate('Bot');
  await button('换肤').click();
  await page.getByRole('dialog', { name: '换肤', exact: true }).waitFor();
  await current('Bot');
  await page.getByRole('radio', { name: '经典', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'classic');
  await page.getByRole('button', { name: '关闭换肤', exact: true }).click();
  await page.locator('.skin-picker').waitFor({ state: 'detached' });
  await capture('bot-classic-1440');
  await button('换肤').click();
  await page.getByRole('radio', { name: '月见紫', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'cafe-purple');
  await page.getByRole('button', { name: '关闭换肤', exact: true }).click();
  await page.locator('.skin-picker').waitFor({ state: 'detached' });
  note('Skin popover never masquerades as a selected application page');
  await button('Bot').click();
  await current('Bot');
  for (const width of [1440, 768, 375]) {
    await resize(width);
    await layout(`Bot onboarding ${width}: layout fits viewport`);
    await capture(`bot-purple-${width}`);
    await navigate('对话');
    await layout(`Conversation ${width}: layout fits viewport`);
    await navigate('Bot');
  }
  await resize(375, 320);
  await layout('Short window 375×320: all icons reachable');
  await capture('bot-short');
  await resize(768);
  await button('技能中心').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await current('技能中心');
  note('Keyboard activation routes to the named page');
  await app.close(); app = null;

  // Seed public cache only. SSH is forced to fail locally, so this is an offline UI test.
  const instanceId = 'nav-offline-instance', id = 'nav-offline-session';
  const session = { id, title: '云端会话', dir: '/home/ubuntu/hemi-workspace', modelKey: 'fixture', thinking: 'default', createdAt: Date.now(), updatedAt: Date.now(), turnCount: 0, status: null, waitingPermission: false };
  const detail = { ...session, draft: { text: 'NAV_BOT_DRAFT', revision: 0, references: [], skills: [], attachmentIds: [] }, flow: createFlowSnapshot({ conversationId: id }), attachments: [], permissions: {}, usage: [] };
  await fs.mkdir(path.join(profile, 'bot'), { recursive: true });
  await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({ host: 'nav-fixture.invalid', instanceId, protocol: 1, version: '1.0.0', home: '/home/ubuntu', dataDir: '/home/ubuntu/.local/share/hemi-bot', boundAt: Date.now() }));
  await fs.writeFile(path.join(profile, 'bot/cache.json'), JSON.stringify({ selectedId: id, instanceId, revision: 0, enabled: true, defaultDir: session.dir, defaultModel: 'fixture', recentDirs: [session.dir], models: [], sessions: [session], details: { [id]: detail } }));
  await launch();
  await navigate('Bot');
  await page.locator('textarea.text-composer-input').waitFor();
  for (const width of [1440, 768, 375]) {
    await resize(width);
    await layout(`Offline Bot conversation ${width}: stable rail`);
    if (width <= 880) {
      const controls = await button('Bot').getAttribute('aria-controls');
      assert.ok(controls);
      assert.equal(await button('对话').getAttribute('aria-controls'), null);
      assert.ok(await page.evaluate(id => document.getElementById(id)?.classList.contains('h24-sidebar'), controls));
      const workspace = page.locator('.h24-workspace');
      const open = await workspace.getAttribute('data-nav-open') === 'true';
      await button('Bot').click();
      await page.waitForFunction(expected => document.querySelector('.h24-workspace')?.getAttribute('data-nav-open') === expected, open ? 'false' : 'true');
      await button('Bot').click();
      await page.waitForFunction(expected => document.querySelector('.h24-workspace')?.getAttribute('data-nav-open') === expected, open ? 'true' : 'false');
      if (open) await page.getByRole('button', { name: '关闭导航', exact: true }).click({ force: true });
      await page.mouse.move(width - 20, 40);
      await page.keyboard.press('Escape');
      await page.locator('.h24-sidebar').waitFor({ state: 'hidden' });
      note(`Bot ${width}: current icon toggles its own conversation drawer`);
    } else await button('Bot').click();
    await current('Bot');
    assert.equal(await page.locator('textarea.text-composer-input').inputValue(), 'NAV_BOT_DRAFT');
    await capture(`bot-conversation-${width}`);
  }
  await navigate('技能中心');
  await navigate('Bot');
  await navigate('工作流');
  await navigate('Bot');
  await navigate('设置');
  await navigate('Bot');
  assert.equal(await page.locator('textarea.text-composer-input').inputValue(), 'NAV_BOT_DRAFT');
  await navigate('对话');
  note('Connected-layout Bot routes to real global tools and preserves its draft');
  assert.deepEqual(report.errors, []);
  report.passed = true;
  for (const name of ['failure.png', 'failure.txt']) await fs.rm(path.join(evidence, name), { force: true });
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText()).catch(() => {}); }
  throw error;
} finally {
  if (app) await app.close();
  await fs.rm(root, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.profileRemoved = true;
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
}
