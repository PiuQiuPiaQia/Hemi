// 047 崩溃恢复演练的 Electron 侧驱动（由 verify-newapi-import-crash.mjs 以两种模式拉起）：
// mode=crash：跑到 validating（Key 已持、无回执）立即 app.exit(0) 模拟强杀。
// mode=resume：冷启动后 listPending → resumePending → 断点续跑至 success（全程无浏览器/无登录）。
// 站点地址与故障经环境变量注入（假站在父进程里跨两次运行存活）。
import { app, ipcMain } from 'electron';
import path from 'node:path';

const MODE = process.env.HEMI_047_CRASH_MODE ?? 'crash';
const SITE = process.env.HEMI_047_CRASH_SITE;
if (!SITE) {
  console.error('[crash-run] 缺少 HEMI_047_CRASH_SITE');
  process.exit(2);
}

const { IPC } = await import('../src/shared/ipc-channels.mjs');
const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { getProviderImportService } = await import('../src/main/ipc/provider-import.ipc.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');
const { TEST_USER } = await import('./mock-newapi-site.mjs');

const log = createLogger('crash047');
const handler = (channel) => ipcMain._invokeHandlers.get(channel);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`CRASH_CHECK ${JSON.stringify({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) })}`);
};
const drive = (channel, payload) => handler(channel)({ sender: appState.mainWindow.webContents, senderFrame: appState.mainWindow.webContents.mainFrame }, payload ?? {});
const execWithTimeout = (contents, code, ms = 8000) =>
  Promise.race([contents.executeJavaScript(code), new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms))]).catch(() => '__error__');

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-047-crash-ud'));

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();

    if (MODE === 'crash') {
      const started = await drive(IPC.providerImport.start, { siteUrl: SITE });
      check('crash: start', started?.state?.phase === 'login');
      // 模拟用户登录（mock 站登录页：同步填表＋requestSubmit）。
      const contents = getProviderImportService().testBrowserContents();
      for (let i = 0; i < 30; i += 1) {
        const out = await execWithTimeout(contents, `(function () {
          const user = document.getElementById('username');
          const pass = document.getElementById('password');
          const form = document.getElementById('login-form');
          if (!user || !pass || !form) return 'waiting';
          user.value = ${JSON.stringify(TEST_USER.username)};
          pass.value = ${JSON.stringify(TEST_USER.password)};
          form.requestSubmit();
          return 'submitted';
        })()`);
        if (out === 'submitted') break;
        await sleep(300);
      }
      const checked = await drive(IPC.providerImport.checkLogin, { operationId: started.state.operationId, revision: (await drive(IPC.providerImport.getState, { operationId: started.state.operationId })).state.revision });
      check('crash: 登录核验', checked?.ok === true);
      const selected = await drive(IPC.providerImport.setSelection, {
        operationId: started.state.operationId,
        revision: checked.state.revision,
        selection: { group: 'default', models: [{ modelName: 'mock-gpt-5.2', api: 'openai-completions' }] },
      });
      check('crash: 选择', selected?.ok === true);
      await drive(IPC.providerImport.submit, {
        operationId: started.state.operationId,
        revision: selected.state.revision,
        planHash: selected.state.preview.planHash,
      });
      // 等 validating（Key 已加密入 journal、无回执）→ 立即强杀（探活被父进程挂住，必停在此）。
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const state = (await drive(IPC.providerImport.getState, { operationId: started.state.operationId })).state;
        if (state?.phase === 'validating') {
          console.log(`CRASH_AT validating tokenName=${state.tokenName} tokenId 已核验`);
          console.log(`CRASH_RUN_RESULT=${JSON.stringify({ mode: 'crash', results, tokenName: state.tokenName })}`);
          app.exit(0); // 模拟强杀：不清 journal、不撤销、不收尾
        }
        await sleep(30);
      }
      throw new Error('没等到 validating（探活应被父进程挂住）');
    }

    if (MODE === 'resume') {
      const pending = await drive(IPC.providerImport.listPending);
      check('resume: 待处理在场（持加密 Key、未提交）', pending.pending.length === 1 && pending.pending[0].apiKeyHeld === true && !pending.pending[0].committed,
        JSON.stringify(pending.pending));
      const operationId = pending.pending[0].operationId;
      const resumed = await drive(IPC.providerImport.resumePending, { operationId });
      check('resume: 断点受理（直接验证，无浏览器/无登录）', resumed?.ok === true && resumed.state?.phase !== 'login');
      const deadline = Date.now() + 60000;
      let state = null;
      while (Date.now() < deadline) {
        state = (await drive(IPC.providerImport.getState, { operationId })).state;
        if (state?.phase === 'success' || state?.phase === 'failed') break;
        await sleep(100);
      }
      check('resume: 恢复至 success', state?.phase === 'success', JSON.stringify(state?.error ?? state?.phase));
      const directory = await handler(IPC.llm.listModelProfiles)({ sender: appState.mainWindow.webContents }, {});
      const imported = directory.providers.filter((provider) => provider.id.startsWith('mpi-'));
      check('resume: 供应商已保存', imported.length === 1 && imported[0].hasApiKey === true);
      console.log(`CRASH_RUN_RESULT=${JSON.stringify({ mode: 'resume', results })}`);
      setTimeout(() => app.exit(results.every((item) => item.ok) ? 0 : 1), 400);
    }
  } catch (error) {
    console.error('[crash-run] 失败：', error);
    console.log(`CRASH_RUN_RESULT=${JSON.stringify({ mode: MODE, results, error: String(error?.message ?? error) })}`);
    setTimeout(() => app.exit(1), 400);
  }
});
setTimeout(() => { console.log('CRASH_RUN_TIMEOUT'); app.exit(1); }, 180000);
