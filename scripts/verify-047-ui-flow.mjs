// 047 UI 驱动端到端（补提交按钮缺口后的回归）：不直驱 IPC，全部经主窗口真实
// DOM 点出来——设置 → 模型与路由 → 添加供应商 → 填站点地址 → 打开并登录
// （导入浏览器里模拟用户填表）→ 我已登录 → 选组 → 点型号 chip → 等预览 →
// 点「创建 Key 并导入」→ 等「已导入」回执。React 控件用原生 setter＋事件。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-047-ui-ud npx electron scripts/verify-047-ui-flow.mjs
import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

const { startMockSite, TEST_USER } = await import('./mock-newapi-site.mjs');
const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { getProviderImportService } = await import('../src/main/ipc/provider-import.ipc.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('ui047');
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
  console.log(`HEMI_047_UI_RESULT=${JSON.stringify({ summary, passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 600);
};

/** 主窗渲染层注入（同步短脚本＋超时竞速）。 */
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

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-047-ui-ud'));

app.whenReady().then(async () => {
  try {
    const site = await startMockSite({});
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    appState.mainWindow.setSize(1440, 1000);
    appState.mainWindow.show();
    await sleep(1200); // 等渲染层就绪

    // 隔离目录首启也从真实 UI 完成引导，不预写 ready/onboarding 状态。
    if (await exec(`Boolean(document.querySelector('.onboarding-page'))`)) {
      check('首启开始设置', await clickByText('开始设置'));
      await waitFor(`Boolean(document.querySelector('[data-step="microphone"]'))`, '麦克风步骤');
      await clickByText('稍后开启');
      await clickByText('继续');
      await waitFor(`Boolean(document.querySelector('#onboarding-asr-key'))`, '语音服务表单');
      await setNativeValue('#onboarding-asr-key', 'isolated-offline-asr-test-key');
      check('首启保存语音配置', await clickByText('保存并继续'));
      await waitFor(`Boolean(document.querySelector('#onboarding-model-url'))`, '模型表单');
      await setNativeValue('#onboarding-model-url', `${site.origin}/v1`);
      await setNativeValue('#onboarding-model-name', 'mock-gpt-5.2');
      await setNativeValue('#onboarding-model-key', 'isolated-offline-model-test-key');
      check('首启保存模型配置', await clickByText('保存并继续'));
      await waitFor(`Boolean(document.querySelector('[data-step="done"]'))`, '引导完成屏');
      check('首启开始使用', await clickByText('开始使用'));
      await waitFor(`!document.querySelector('.onboarding-page')`, '进入应用');
    }

    // 1. 打开设置 → 模型与路由（设置可能已默认落在模型页——点击或验证在页均可）
    check('打开设置', await clickByText('设置', 'document'));
    await waitFor(`Boolean(document.querySelector('.settings-nav'))`, '设置导航');
    const navClicked = await clickByText('模型与路由', 'document.querySelector(".settings-nav") ?? document');
    const onModels = navClicked || await waitFor(`Boolean(document.body.textContent.includes("添加供应商"))`, '添加入口', 10000);
    check('进模型与路由页', onModels);
    await waitFor(`Boolean(document.body.textContent.includes("添加供应商"))`, '添加入口');

    // 2. 添加供应商（默认 New API 方式）
    check('点添加供应商', await clickByText('添加供应商'));
    await waitFor(`Boolean(document.querySelector('#h47n-url'))`, '站点地址输入');
    check('填站点地址', (await setNativeValue('#h47n-url', site.origin)) === 'set');
    check('点打开站点并登录', await clickByText('打开站点并登录'));
    await waitFor(`Boolean(document.querySelector('.h47n-browser'))`, '浏览器占位出现');

    // 3. 在导入浏览器里模拟用户登录（站点自己的登录页）
    let contents = getProviderImportService().testBrowserContents();
    for (let i = 0; i < 30 && (!contents || contents.isDestroyed()); i += 1) {
      await sleep(150);
      contents = getProviderImportService().testBrowserContents();
    }
    // 768 是既有单列响应式入口，站点 View 足宽；保持真实 renderer 上报的 bounds。
    appState.mainWindow.setSize(768, 1100);
    for (let i = 0; i < 30 && !getProviderImportService().testBrowserVisible(); i += 1) await sleep(100);
    check('站点原生 View 在真实窗口可见', getProviderImportService().testBrowserVisible());
    await sleep(400); // 等入场动效结束，截图只含假站的空表单。
    const screenshots = path.resolve('.visual/workflow/vision');
    await fs.mkdir(screenshots, { recursive: true });
    const entryLabel = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'build';
    await fs.writeFile(path.join(screenshots, `login-memory-app-${entryLabel}.png`), (await appState.mainWindow.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(screenshots, `login-memory-site-${entryLabel}.png`), (await contents.capturePage()).toPNG());
    let submitted = '';
    for (let i = 0; i < 30 && submitted !== 'submitted'; i += 1) {
      submitted = await Promise.race([
        contents.executeJavaScript(`(function () {
          const user = document.getElementById('username');
          const pass = document.getElementById('password');
          const form = document.getElementById('login-form');
          if (!user || !pass || !form) return 'waiting';
          user.value = ${JSON.stringify(TEST_USER.username)};
          pass.value = ${JSON.stringify(TEST_USER.password)};
          form.requestSubmit();
          return 'submitted';
        })()`),
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 5000)),
      ]).catch(() => '__error__');
      if (submitted !== 'submitted') await sleep(300);
    }
    check('站点页内登录提交', submitted === 'submitted', submitted);

    // 4. 我已登录，继续
    await waitFor(`Boolean([...document.querySelectorAll('button')].some((b) => b.textContent.includes('我已登录，继续') && !b.disabled))`, '继续按钮可用', 20000);
    check('点我已登录，继续', await clickByText('我已登录，继续'));
    const selecting = await waitFor(`Boolean(document.querySelector('#h47n-group'))`, '选择阶段', 30000);
    check('进入选择阶段（分组/额度/模型）', selecting);

    // 5. 选组 → 等 candidates → 点一个型号 chip → 等预览
    check('选分组', (await setNativeValue('#h47n-group', 'default')) === 'set');
    await waitFor(`Boolean([...document.querySelectorAll('.h37-chip')].some((c) => c.textContent.includes('mock-gpt-5.2') && !c.disabled))`, '型号 chip', 15000);
    const chip = await exec(`(function () {
      const chip = [...document.querySelectorAll('.h37-chip')].find((c) => c.textContent.includes('mock-gpt-5.2'));
      if (!chip) return 'missing';
      chip.click();
      return 'clicked';
    })()`);
    check('点型号 chip', chip === 'clicked');
    const preview = await waitFor(`Boolean(document.body.textContent.includes('将生成'))`, '预览（将生成）', 15000);
    check('选择自动同步出预览', preview);

    // 6. 点「创建 Key 并导入」→ 等回执
    await waitFor(`Boolean([...document.querySelectorAll('button')].some((b) => b.textContent.includes('创建 Key 并导入') && !b.disabled))`, '提交按钮可用', 15000);
    check('点创建 Key 并导入', await clickByText('创建 Key 并导入'));
    const success = await waitFor(`Boolean(document.body.textContent.includes('已导入') || document.body.textContent.includes('没完成'))`, '回执', 90000);
    const failed = await exec(`Boolean(document.body.textContent.includes('没完成'))`);
    check('UI 显示导入成功回执', success && failed !== true);
    check('远端创建恰好一次', site.state.createCalls === 1, `createCalls=${site.state.createCalls}`);

    // 7. 完成 → 回目录
    check('点完成', await clickByText('完成'));
    const backToDirectory = await waitFor(`Boolean(document.body.textContent.includes('添加供应商') && !document.body.textContent.includes('配置方式'))`, '回供应商目录', 15000);
    check('回到供应商目录', backToDirectory);

    // 8. 再次添加（用户实测坑）：终态不得被收养成旧回执，必须能开新一轮并完成。
    check('二轮点添加供应商', await clickByText('添加供应商'));
    const freshEntry = await waitFor(
      `Boolean(document.querySelector('#h47n-url'))`,
      '全新入口', 15000,
    );
    const noOldReceipt = await exec(`Boolean(!document.body.textContent.includes('已导入'))`);
    check('重开添加页是全新入口（无旧回执）', freshEntry && noOldReceipt === true);
    check('二轮填站点地址', (await setNativeValue('#h47n-url', site.origin)) === 'set');
    check('二轮打开站点并登录', await clickByText('打开站点并登录'));
    await waitFor(`Boolean(document.querySelector('.h47n-browser'))`, '二轮浏览器占位', 15000);
    let contents2 = getProviderImportService().testBrowserContents();
    for (let i = 0; i < 30 && (!contents2 || contents2.isDestroyed()); i += 1) {
      await sleep(150);
      contents2 = getProviderImportService().testBrowserContents();
    }
    let restored2 = false;
    for (let i = 0; i < 50 && !restored2; i += 1) {
      restored2 = await contents2.executeJavaScript(`document.body.dataset.booted === '1'`).catch(() => false);
      if (!restored2) await sleep(100);
    }
    check('二轮复用登录且不重输密码', restored2 && site.state.loginCalls === 1);
    await waitFor(`Boolean([...document.querySelectorAll('button')].some((b) => b.textContent.includes('我已登录，继续') && !b.disabled))`, '二轮继续按钮', 20000);
    check('二轮我已登录，继续', await clickByText('我已登录，继续'));
    await waitFor(`Boolean(document.querySelector('#h47n-group'))`, '二轮选择阶段', 30000);
    check('二轮选分组', (await setNativeValue('#h47n-group', 'vip')) === 'set');
    await waitFor(`Boolean([...document.querySelectorAll('.h37-chip')].some((c) => c.textContent.includes('mock-vip-only') && !c.disabled))`, '二轮 chip', 15000);
    check('二轮点型号 chip', (await exec(`(function () {
      const chip = [...document.querySelectorAll('.h37-chip')].find((c) => c.textContent.includes('mock-vip-only'));
      if (!chip) return 'missing';
      chip.click();
      return 'clicked';
    })()`)) === 'clicked');
    await waitFor(`Boolean(document.body.textContent.includes('将生成'))`, '二轮预览', 15000);
    await waitFor(`Boolean([...document.querySelectorAll('button')].some((b) => b.textContent.includes('创建 Key 并导入') && !b.disabled))`, '二轮提交按钮', 15000);
    check('二轮点创建 Key 并导入', await clickByText('创建 Key 并导入'));
    const success2 = await waitFor(`Boolean(document.body.textContent.includes('已导入') || document.body.textContent.includes('没完成'))`, '二轮回执', 90000);
    check('二轮导入成功', success2 && (await exec(`Boolean(!document.body.textContent.includes('没完成'))`)) === true);
    check('两轮共创建两条令牌', site.state.createCalls === 2, `createCalls=${site.state.createCalls}`);

    site.server.closeAllConnections?.();
    await site.close().catch(() => undefined);
    finish(results.every((item) => item.ok) ? 0 : 1, results.every((item) => item.ok) ? 'all-pass' : 'has-failures');
  } catch (error) {
    console.error('[ui047] 失败：', error);
    check('脚本异常', false, error?.stack ?? String(error));
    finish(1, 'exception');
  }
});
setTimeout(() => finish(1, 'timeout'), 240000);
