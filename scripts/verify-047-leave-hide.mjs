// 047 离开导入页隐藏站点页（防「浏览器悬浮」回归）：到登录阶段（站点页可见）后
// ①切设置侧栏到别的分类 → 原生站点页必须隐藏；切回并重新进入导入 → 接回活动操作恢复可见；
// ②关闭设置回主窗口 → 站点页必须隐藏。全链路真实 DOM 驱动。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-047-leave-ud npx electron scripts/verify-047-leave-hide.mjs
import { app } from 'electron';
import path from 'node:path';

const { startMockSite } = await import('./mock-newapi-site.mjs');
const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('ui047leave');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};
let finished = false;
const finish = (code, summary) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_047_LEAVE_RESULT=${JSON.stringify({ summary, passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 600);
};

const exec = (code, ms = 8000) => {
  const contents = appState.mainWindow.webContents;
  return Promise.race([
    contents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ]).catch((error) => `__error__:${error?.message}`);
};

/** 点真实按钮（按文本/aria-label/title——034 后导航栏是纯图标按钮），返回是否找到。 */
const clickByText = async (text, scope = 'document') => {
  const out = await exec(`(function () {
    const root = ${scope};
    const nodes = [...root.querySelectorAll('button')];
    const target = nodes.find((node) => {
      const label = (node.textContent ?? '') + ' '
        + (node.getAttribute('aria-label') ?? '') + ' '
        + (node.getAttribute('title') ?? '');
      return label.includes(${JSON.stringify(text)}) && !node.disabled;
    });
    if (!target) return 'missing';
    target.click();
    return 'clicked';
  })()`);
  return out === 'clicked';
};

/** React 受控输入：原生 setter＋input/change 事件。 */
const setNativeValue = (selector, value) => exec(`(function () {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()`);

const waitFor = async (predicateScript, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await exec(predicateScript);
    if (out === true) return true;
    await sleep(250);
  }
  log.warn(`等待超时：${label}`);
  return false;
};

/** 导入站点页＝主窗 contentView 里 UA 带 HemiImport/ 的子 View（判断是否还挂着）。 */
const findImportView = () => {
  const children = appState.mainWindow?.contentView?.children ?? [];
  return children.find((child) => {
    try {
      return child.webContents?.getUserAgent?.().includes('HemiImport/');
    } catch {
      return false;
    }
  }) ?? null;
};

const waitForViewVisible = async (want, label, timeoutMs = 8000) => {
  const service = (await import('../src/main/ipc/provider-import.ipc.mjs')).getProviderImportService();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.testBrowserVisible() === want) return true;
    await sleep(200);
  }
  log.warn(`等待站点页可见性=${want} 超时（${label}，现状 visible=${service.testBrowserVisible()}）`);
  return false;
};

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-047-leave-ud'));

app.whenReady().then(async () => {
  try {
    const site = await startMockSite({});
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1200); // 等渲染层就绪

    // 进导入登录阶段
    check('打开设置', await clickByText('设置', 'document'));
    await waitFor(`Boolean(document.querySelector('.settings-nav'))`, '设置导航');
    check('进模型与路由页', await clickByText('模型与路由', 'document.querySelector(".settings-nav") ?? document')
      || await waitFor(`Boolean(document.body.textContent.includes("添加供应商"))`, '添加入口', 10000));
    await waitFor(`Boolean(document.body.textContent.includes("添加供应商"))`, '添加入口');
    check('点添加供应商', await clickByText('添加供应商'));
    await waitFor(`Boolean(document.querySelector('#h47n-url'))`, '站点地址输入');
    check('填站点地址', (await setNativeValue('#h47n-url', site.origin)) === 'set');
    check('点打开站点并登录', await clickByText('打开站点并登录'));
    await waitFor(`Boolean(document.querySelector('.h47n-browser'))`, '浏览器占位出现');
    await sleep(800); // 等视口上报落地
    check('登录阶段站点页可见（前置）', await waitForViewVisible(true, 'login'), '不可见则本脚本前提不成立');

    // ① 切设置侧栏到「通用」：导入视图卸载 → 站点页必须隐藏
    check('切到通用分类', await clickByText('通用', 'document.querySelector(".settings-nav") ?? document'));
    check('通用页已挂载（导入视图卸载）', await waitFor(`!document.querySelector('.h47n-browser')`, 'import view gone', 8000));
    await sleep(600);
    check('离开导入页后站点页隐藏（侧栏切换）', await waitForViewVisible(false, 'sidebar-away'));

    // 切回模型页并重新进入导入：接回活动操作，站点页恢复可见
    check('切回模型与路由', await clickByText('模型与路由', 'document.querySelector(".settings-nav") ?? document'));
    await waitFor(`Boolean(document.body.textContent.includes("添加供应商"))`, '添加入口');
    check('重新点添加供应商', await clickByText('添加供应商'));
    await waitFor(`Boolean(document.querySelector('.h47n-browser'))`, '接回活动操作');
    check('接回后站点页恢复可见', await waitForViewVisible(true, 're-adopt'));

    // ② 关闭设置回主窗口：站点页必须隐藏
    check('关闭设置', await clickByText('返回主窗口'));
    check('设置已关闭', await waitFor(`!document.querySelector('.settings-nav')`, 'settings closed', 8000));
    await sleep(600);
    check('离开设置后站点页隐藏（关闭设置）', await waitForViewVisible(false, 'settings-close'));

    // 收尾：取消挂着的导入操作，浏览器资源回收
    const service = (await import('../src/main/ipc/provider-import.ipc.mjs')).getProviderImportService();
    const activeId = service.activeOperationId?.();
    if (activeId) {
      const mainWindow = appState.mainWindow;
      const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
      await service.cancel(event, { operationId: activeId }).catch(() => undefined);
      await waitForViewVisible(false, 'after-cancel', 4000).catch(() => undefined);
    }
    check('取消后站点页移除', !findImportView());

    finish(results.every((item) => item.ok) ? 0 : 1, results.every((item) => item.ok) ? 'all-pass' : 'failed');
  } catch (error) {
    console.error('脚本异常', error);
    finish(1, 'exception');
  }
});
