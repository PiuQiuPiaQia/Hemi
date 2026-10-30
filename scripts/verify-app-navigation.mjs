// Desktop navigation regression: real Electron preload/IPC plus both renderer builds.
// Windows layout is emulated on macOS; native Windows caption behavior needs Windows.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { initializeRuntimeStorage, runtimeDataDir } from '../src/main/agent-runtime/storage-migration.mjs';
import { createConversationStore } from '../src/main/history/conversation-store.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-navigation-'));
const output = path.join(repo, '.visual/workflow/vision/app-navigation');
await fs.mkdir(output, { recursive: true });
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, results: [],
  gaps: ['Native Windows caption buttons, Snap Layouts and DPI changes require a Windows machine; win32 renderer safe areas are emulated here.'],
};
let app, vite;
const resize = (width) => app.evaluate(({ BrowserWindow }, width) => {
  const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
  win.setContentSize(width, 800);
}, width);
try {
  vite = await createServer({ configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(temporary, 'vite'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    const profile = path.join(temporary, mode);
    await initializeRuntimeStorage({ userDataDir: profile });
    const store = createConversationStore({ dir: path.join(runtimeDataDir(profile), 'conversations') });
    store.saveSession({ id: 'conv-navigation', turns: [{ id: 'u-navigation', author: 'user', text: '导航布局验证', createdAt: Date.now() }] });
    store.renameSession('conv-navigation', '一段很长的会话标题，用来检查窗口缩窄以后标题省略、按钮留位和导航交互是否正常，以及原生窗口控件是否受到遮挡');
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({ globalPushToTalkEnabled: false }));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
    const env = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0' };
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = { mode, checks: [], screenshots: [], errors: [] }; report.results.push(result);
    app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env });
    let page;
    for (let attempt = 0; attempt < 200 && !page; attempt++) {
      page = app.windows().find(win => /^(http|file):/.test(win.url()) && !new URL(win.url()).searchParams.has('mode'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, 'main window opens');
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.errors.push(error.message));
    await page.locator('textarea.text-composer-input').waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
      win.setMinimumSize(560, 620); win.setContentSize(1440, 800); win.show();
    });
    await assert.rejects(() => page.evaluate(() => window.hemiVoice.showAppMenu({ menu: 'invalid', x: 0, y: 0, enabledCommands: [] })), /INVALID_MENU/);
    result.checks.push('real IPC rejects unknown menu IDs');
    const navigate = async (label, target) => {
      await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: label, exact: true }).click();
      await page.locator(`.h24-navrail-item[data-page="${target}"][aria-current="page"]`).waitFor();
    };
    const inspect = async (name, width, platform) => {
      await resize(width);
      await page.locator('.app-topbar').evaluate((el, platform) => { el.dataset.platform = platform; }, platform);
      await page.waitForTimeout(100);
      const metrics = await page.locator('.app-topbar').evaluate(el => {
        const s = getComputedStyle(el), rect = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button,input,a')].filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden').map(item => {
          const r = item.getBoundingClientRect();
          return { label: item.getAttribute('aria-label') || item.textContent, x: r.x, right: r.right, y: r.y, bottom: r.bottom, drag: getComputedStyle(item).webkitAppRegion };
        });
        return { height: rect.height, width: rect.width, left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight),
          scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, drag: s.webkitAppRegion, buttons,
          bg: s.backgroundColor, rail: document.querySelector('.h24-navrail') ? getComputedStyle(document.querySelector('.h24-navrail')).backgroundColor : null,
          title: el.querySelector('.app-topbar-title').getBoundingClientRect().toJSON() };
      });
      assert.equal(metrics.height, 52, `${name}: common row height`);
      if (metrics.rail) assert.equal(metrics.bg, metrics.rail, `${name}: continuous navigation surface`);
      assert.equal(metrics.drag, 'drag', `${name}: window drag area`);
      assert.ok(metrics.scrollWidth <= metrics.viewport, `${name}: no horizontal overflow`);
      assert.equal(metrics.left, platform === 'darwin' ? 96 : 16, `${name}: platform-specific leading inset`);
      if (platform === 'win32') assert.ok(metrics.right >= 154, `${name}: native caption safe area`);
      for (const button of metrics.buttons) {
        assert.ok(button.x >= metrics.left - 1 && button.right <= metrics.width - metrics.right + 1 && button.y >= 0 && button.bottom <= 52,
          `${name}: action stays inside native safe area: ${JSON.stringify(button)} (${JSON.stringify(metrics)})`);
        assert.equal(button.drag, 'no-drag', `${name}: clickable controls are not draggable`);
      }
      const filename = `${mode}-${name}-${platform}-${width}.png`;
      await page.screenshot({ path: path.join(output, filename), scale: 'css' });
      result.screenshots.push(filename);
      result.checks.push({ name, width, platform, metrics });
      console.log('PASS', mode, name, platform, width);
    };
    const matrix = async name => {
      for (const width of [1440, 980, 560]) for (const platform of ['darwin', 'win32']) await inspect(name, width, platform);
    };
    await page.locator('.h24-sidebar-open').first().click();
    await matrix('conversation-long-title');
    // Instrument the real Electron Menu.popup only to drive deterministic native
    // command selection. The actual popup, callback, preload and IPC handler run.
    await app.evaluate(({ app, BrowserWindow, Menu }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode')).focus();
      globalThis.__navigationMenuTrace = [];
      globalThis.__navigationMenuOriginal = Menu.prototype.popup;
      Menu.prototype.popup = function(options) {
        const target = globalThis.__navigationMenuTarget;
        const record = { target, shown: false, selected: false, items: this.items.map(item => ({ id: item.id, role: item.role, label: item.label, enabled: item.enabled })) };
        globalThis.__navigationMenuTrace.push(record);
        this.once('menu-will-show', () => {
          record.shown = true;
          setTimeout(() => {
            const item = target ? this.getMenuItemById(target) : null;
            if (item?.enabled) {
              record.selected = true;
              item.click({}, options.window, options.window.webContents);
            }
            this.closePopup(options.window);
          }, 80);
        });
        return globalThis.__navigationMenuOriginal.call(this, { ...options, callback: () => { record.closed = true; options.callback?.(); } });
      };
    });
    const menuAction = async (group, target) => {
      await resize(980);
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode')).focus(); });
      await page.locator('.app-topbar').evaluate(el => { el.dataset.platform = 'win32'; });
      await app.evaluate((_, target) => { globalThis.__navigationMenuTarget = target; }, target);
      await page.getByRole('menubar', { name: '应用菜单' }).getByRole('menuitem', { name: group, exact: true }).click();
      try { await page.waitForFunction(() => !document.querySelector('.app-menubar [aria-expanded="true"]')); } catch (error) { console.log(JSON.stringify(await app.evaluate(() => globalThis.__navigationMenuTrace))); throw error; }
    };
    const composer = page.locator('textarea.text-composer-input');
    await composer.fill('菜单验证保留的草稿');
    await menuAction('文件', 'settings');
    await page.locator('.h37-settings-shell').waitFor();
    await page.locator('.app-topbar-back').click();
    await composer.waitFor();
    assert.equal(await composer.inputValue(), '菜单验证保留的草稿', 'native menu navigation preserves the previous draft');
    await app.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.__navigationMenuOriginal; });
    const nativeMenus = await app.evaluate(() => globalThis.__navigationMenuTrace);
    assert.ok(nativeMenus.every(menu => menu.shown && (menu.target === null || menu.selected)), 'real native popups show and selected commands execute');
    result.checks.push({ name: 'native-menu-preload-ipc', nativeMenus });
    console.log('PASS', mode, 'real native File menu, preload/IPC and settings navigation');
    await navigate('使用记录', 'usage'); await matrix('usage');
    assert.equal(await page.locator('.app-topbar-back').getAttribute('aria-label'), '返回对话');
    const back = page.locator('.app-topbar-back');
    await back.hover(); await page.waitForTimeout(160);
    assert.notEqual(await back.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode')).focus(); });
    await page.mouse.move(500, 400);
    await back.focus(); await page.keyboard.press('Alt+Tab'); await page.keyboard.press('Alt+Shift+Tab');
    const focusState = await back.evaluate(el => ({ focused: document.activeElement === el, keyboard: document.documentElement.classList.contains('kb-nav'), background: getComputedStyle(el).backgroundColor }));
    assert.equal(focusState.focused && focusState.keyboard && focusState.background !== 'rgba(0, 0, 0, 0)', true, 'keyboard focus has a visible background');
    await page.keyboard.press('Enter');
    await page.locator('textarea.text-composer-input').waitFor();
    result.checks.push('shared back control supports hover, keyboard focus and Enter navigation');
    await navigate('设置', 'settings'); await matrix('settings');
    await page.getByRole('button', { name: /分类 ·/ }).click();
    await page.locator('.h37-settings-drawer').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.h37-settings-drawer').waitFor({ state: 'hidden' });
    await page.locator('.app-topbar-back').click(); await page.locator('textarea.text-composer-input').waitFor();
    result.checks.push('settings drawer and common back action work at narrow width');
    await navigate('工作流', 'workflows'); await matrix('workflows');
    await page.getByRole('button', { name: '新建工作流', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('textbox', { name: '工作流名称', exact: true }).waitFor();
    await page.getByRole('textbox', { name: '工作流名称', exact: true }).fill('用于验证导航布局的长工作流名称，窗口缩窄以后仍然能够编辑并保存');
    assert.equal(await page.locator('.app-topbar .h24-conversation-title').isVisible(), false, 'editor has a single editable title');
    await matrix('workflow-editor');
    await page.getByRole('button', { name: '保存工作流', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.app-topbar .h59-dirty'));
    result.checks.push('workflow editor has one title and supports editing and saving through real IPC');
    await navigate('Bot', 'bot'); await matrix('bot');
    await navigate('对话', 'home');
    await page.locator('textarea.text-composer-input').waitFor();
    await resize(980);
    await page.getByRole('button', { name: '换肤', exact: true }).click();
    const theme = page.getByRole('radio').nth(1); await theme.click(); await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await inspect('themed-conversation', 980, 'darwin');
    await navigate('使用记录', 'usage'); await inspect('themed-usage', 980, 'darwin');
    assert.deepEqual(result.errors, [], `${mode}: no renderer exceptions`);
    await app.evaluate(({ app }) => app.quit()); await app.close(); app = null;
    const onboarding = path.join(temporary, `${mode}-onboarding`);
    await initializeRuntimeStorage({ userDataDir: onboarding });
    await fs.writeFile(path.join(onboarding, 'doubao-asr.json'), JSON.stringify({ globalPushToTalkEnabled: false }));
    app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env: { ...env, HEMI_USER_DATA_DIR: onboarding } });
    page = await app.firstWindow();
    await page.locator('.setup-shell').waitFor();
    await matrix('onboarding-welcome');
    await page.getByRole('button', { name: '开始设置', exact: true }).click();
    await page.getByRole('heading', { name: '连接模型', exact: true }).waitFor();
    await matrix('onboarding-model');
    await page.getByRole('button', { name: '返回上一步', exact: true }).click();
    await page.getByRole('button', { name: '开始设置', exact: true }).waitFor();
    result.checks.push('onboarding shares the platform safe areas and working back navigation');
    await app.evaluate(({ app }) => app.quit()); await app.close(); app = null;
  }
} catch (error) {
  report.failure = error.stack || String(error);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await vite?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(temporary, { recursive: true, force: true });
}
