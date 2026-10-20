// 2026-10-08 设置页打开落位验证（用户反馈「每次打开选中的都不是第一个 tab」）：
// 隔离 userData＋合成配置，真实 DOM 驱动——
//   1. 图标栏「设置」打开 → 选中态必须是第一分类「通用」；
//   2. 切到「模型与路由」→ 关闭 → 再开 → 仍回「通用」（不再记住上次页）；
//   3. 记忆提示等定向直达不受影响（onOpenModelSettings 路径：模型未配置
//      「去设置」→ 模型与路由）——这里用无模型目录形态验「去设置」直达。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-st-ud npx electron scripts/verify-settings-tab.mjs
import { app } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('st-verify');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_SETTINGS_TAB_RESULT=${JSON.stringify({ passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 400);
};

const exec = (code, ms = 8000) => {
  const contents = appState.mainWindow.webContents;
  return Promise.race([
    contents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ]).catch((error) => `__error__:${error?.message}`);
};

const waitFor = async (predicateScript, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await exec(predicateScript)) === true) return true;
    await sleep(250);
  }
  log.warn(`等待超时：${label}`);
  return false;
};

/** 当前选中的设置分类文案（aria-current 的导航项）。 */
const activeSettingsPage = () => exec(`(function () {
  const item = document.querySelector('.settings-nav [aria-current="true"], .h37-settings-navitem[aria-current="true"]');
  return item ? (item.textContent ?? '').trim() : 'missing';
})()`);

const clickNavRailSettings = () => exec(`(function () {
  const btn = document.querySelector('button[aria-label="设置"]');
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
}())`);

const clickSettingsNavItem = (label) => exec(`(function () {
  const item = [...document.querySelectorAll('.settings-nav button, .h37-settings-side button')]
    .find((node) => (node.textContent ?? '').includes(${JSON.stringify(label)}));
  if (!item) return 'missing';
  item.click();
  return 'clicked';
}())`);

const closeSettings = () => exec(`(function () {
  const btn = document.querySelector('button[aria-label="返回主窗口"]');
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
}())`);

app.setName('hemi');
const userDataDir = path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-st-ud');
await rm(userDataDir, { recursive: true, force: true });
app.setPath('userData', userDataDir);

app.whenReady().then(async () => {
  try {
    // 引导完成即可（设置页行为与模型配置无关）。
    initializeStableSafeStorageIdentity();
    const now = Date.now();
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      path.join(userDataDir, 'onboarding.json'),
      `${JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: now, completedAt: now })}\n`,
    );

    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1200);

    check('打开设置', (await clickNavRailSettings()) === 'clicked');
    const navReady = await waitFor(`Boolean(document.querySelector('.settings-nav, .h37-settings-side'))`, '设置导航');
    check('设置导航渲染', navReady);
    if (!navReady) return finish(1);

    check('打开即第一分类「通用」', (await activeSettingsPage()) === '通用', await activeSettingsPage());

    check('切到「模型与路由」', (await clickSettingsNavItem('模型与路由')) === 'clicked');
    await sleep(400);
    check('切换生效', (await activeSettingsPage()) === '模型与路由', await activeSettingsPage());

    check('关闭设置', (await closeSettings()) === 'clicked');
    await waitFor(`Boolean(!document.querySelector('.settings-nav') && !document.querySelector('.h37-settings-side'))`, '设置关闭');
    await sleep(400);

    check('再次打开设置', (await clickNavRailSettings()) === 'clicked');
    await waitFor(`Boolean(document.querySelector('.settings-nav, .h37-settings-side'))`, '设置导航');
    check('重开仍落「通用」（不记上次页）', (await activeSettingsPage()) === '通用', await activeSettingsPage());

    // 定向直达不受影响：本形态无模型目录 → 输入区「去设置」提示可见，点击应落「模型与路由」。
    check('关闭设置（回主界面）', (await closeSettings()) === 'clicked');
    await waitFor(`Boolean(!document.querySelector('.settings-nav') && !document.querySelector('.h37-settings-side'))`, '设置关闭');
    check('点输入区「去设置」直达', (await exec(`(function () {
      const link = document.querySelector('button.text-composer-hint-link');
      if (!link) return 'missing';
      link.click();
      return 'clicked';
    })()`)) === 'clicked');
    await waitFor(`Boolean(document.querySelector('.settings-nav, .h37-settings-side'))`, '设置导航');
    check('直达落「模型与路由」', (await activeSettingsPage()) === '模型与路由', await activeSettingsPage());

    finish(results.every((item) => item.ok) ? 0 : 1);
  } catch (error) {
    log.warn(`验证脚本异常：${error?.stack ?? error}`);
    check('脚本无异常', false, error?.message);
    finish(1);
  }
});
