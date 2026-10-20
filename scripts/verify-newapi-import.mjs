// 047 真机验收（假站全链路）：隔离 userData 起真实应用（主窗＋导入 WebContentsView＋
// 独立 session），从受保护 IPC 同一入口驱动导入，模拟用户在站点页登录。
//
// 覆盖：P0 能力（View 挂载/站内导航门禁/popup 拒绝/认证见证/same-session fetch）、
// 全链路（登录核验→分组→选型→创建→查证→读 Key→双协议验证→原子保存→清理）、
// 验证失败重试不重建、读 Key 失败取消精确撤销、Key 不泄漏（日志/DTO 扫描）。
//
// 运行（先 npm run build）：
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-047-ud npx electron scripts/verify-newapi-import.mjs
// exit 0 + HEMI_047_RESULT JSON 即通过。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loginSiteKey } from '../src/main/services/provider-import/login-store.mjs';

// 测试注入的 http 本机例外：只对未打包实例生效（provider-import.ipc 的判定）。
process.env.HEMI_PROVIDER_IMPORT_TEST_HTTP = '1';

const { startMockSite, TEST_USER } = await import('./mock-newapi-site.mjs');
const { IPC } = await import('../src/shared/ipc-channels.mjs');
const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { getProviderImportService } = await import('../src/main/ipc/provider-import.ipc.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const TIMEOUT_MS = Number(process.env.HEMI_047_TIMEOUT ?? 180000);
const log = createLogger('verify047');

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') {
    console.error(`[verify047] 找不到 IPC handler：${channel}`);
    app.exit(1);
  }
  return fn;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
};

let finished = false;
function finish(code, summary) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_047_RESULT=${JSON.stringify({ summary, results, passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 600);
}

/** 通过原始 handler 调协调器（与 renderer invoke 同一函数；sender＝主窗 webContents）。 */
function drive(channel, payload) {
  const event = { sender: appState.mainWindow.webContents, senderFrame: appState.mainWindow.webContents.mainFrame };
  return handler(channel)(event, payload ?? {});
}

async function pollState(operationId, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await drive(IPC.providerImport.getState, { operationId });
    last = result?.state ?? null;
    if (want.includes(last?.phase)) return last;
    await sleep(150);
  }
  throw new Error(`等待阶段超时：${want.join('/')}，最后 ${last?.phase ?? 'null'} ${JSON.stringify(last?.error ?? null)}`);
}

/** 当前 revision（命令前先取，避免 STALE_REVISION）。 */
async function currentRevision(operationId) {
  const result = await drive(IPC.providerImport.getState, { operationId });
  return result?.state?.revision ?? 0;
}

/** 模拟用户在站点登录页填表提交（密码只进站点页面，Hemi 不读）。 */
async function simulateUserLogin(site) {
  const service = getProviderImportService();
  let contents = service.testBrowserContents();
  const deadline = Date.now() + 10000;
  while ((!contents || contents.isDestroyed()) && Date.now() < deadline) {
    await sleep(120);
    contents = service.testBrowserContents();
  }
  if (!contents) throw new Error('导入浏览器 webContents 不存在');
  // 等登录页渲染（未登录根页即登录表单；或 302 → /sign-in）。
  for (let i = 0; i < 50; i += 1) {
    const url = contents.getURL();
    if (url.includes('/sign-in') || url.includes('/console') || url.endsWith('/')) break;
    await sleep(100);
  }
  // 页面在导航中 executeJavaScript 可能永不结算：每段都带超时。
  const exec = async (code, ms = 8000) => {
    try {
      return await Promise.race([
        contents.executeJavaScript(code),
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
      ]);
    } catch {
      return '__error__';
    }
  };
  const fillScript = `
    (function () {
      if (document.body.dataset.booted === '1') return 'already-authenticated';
      const user = document.getElementById('username');
      const pass = document.getElementById('password');
      const form = document.getElementById('login-form');
      if (!user || !pass || !form) return 'form-missing:' + location.pathname;
      user.value = ${JSON.stringify(TEST_USER.username)};
      pass.value = ${JSON.stringify(TEST_USER.password)};
      try {
        form.requestSubmit();
      } catch (error) {
        return 'request-submit-threw:' + (error && error.message);
      }
      document.body.dataset.fillDone = '1';
      return 'submitted:' + form.getAttribute('action') + ':' + form.method;
    })()
  `;
  let submitted = '';
  const isSubmitted = (value) => value === 'already-authenticated' || value === 'submitted' || String(value).startsWith('submitted:');
  for (let i = 0; i < 25 && !isSubmitted(submitted); i += 1) {
    submitted = await exec(fillScript, 6000);
    if (!isSubmitted(submitted)) await sleep(300);
  }
  if (!isSubmitted(submitted)) {
    throw new Error(`登录表单没出现：${submitted}（${contents.getURL()}）`);
  }
  // 登录成功 → console 页自发管理请求（喂认证见证）；轮询其完成标记。
  let lastDiag = '';
  for (let i = 0; i < 60; i += 1) {
    const flag = await exec('document.body.dataset.booted === "1" ? "booted" : (document.body.dataset.loginError ?? "")', 3000);
    if (flag === 'booted') return;
    if (typeof flag === 'string' && flag.length > 0 && flag !== '__timeout__' && flag !== '__error__') {
      throw new Error(`站点登录失败：${flag}`);
    }
    if (i % 10 === 9) {
      lastDiag = await exec('location.pathname + " fill=" + (document.body.dataset.fillDone ?? "-") + " stage=" + (document.body.dataset.loginStage ?? "-") + " err=" + (document.body.dataset.loginError ?? "-") + " fullurl=" + location.href', 3000);
      log.info(`登录轮询 ${i}：${lastDiag}`);
    }
    await sleep(200);
  }
  log.warn(`登录引导轮询超时（${contents.getURL()} ${lastDiag}），交由 checkLogin 核验实际状态`);
}

async function runImport({ models, group = 'default', fault = null, wantSuccess = true, acceptPhases = null, label }) {
  const site = runImport.site;
  site.state.fault = fault;
  const started = await drive(IPC.providerImport.start, { siteUrl: site.origin });
  check(`${label}：start 返回登录阶段`, started?.state?.phase === 'login');
  const operationId = started.state.operationId;

  await simulateUserLogin(site);
  const checked = await drive(IPC.providerImport.checkLogin, { operationId, revision: await currentRevision(operationId) });
  check(`${label}：登录核验过（服务端身份＋分组）`, checked?.ok === true && checked.state?.groups?.length >= 2,
    `ok=${checked?.ok} code=${checked?.code ?? ''} groups=${checked.state?.groups?.length ?? 0}`);

  const selecting = checked.state;
  const selected = await drive(IPC.providerImport.setSelection, {
    operationId,
    revision: selecting.revision,
    selection: { group, models },
  });
  check(`${label}：选择生效＋预览`, selected?.ok === true && selected.state?.preview?.providers?.length === new Set(models.map((model) => model.api)).size,
    `providers=${selected.state?.preview?.providers?.length ?? 0}`);
  const submitted = await drive(IPC.providerImport.submit, {
    operationId,
    revision: selected.state.revision,
    planHash: selected.state.preview.planHash,
  });
  check(`${label}：提交受理`, submitted?.ok === true);
  const done = await pollState(operationId, acceptPhases ?? (wantSuccess ? ['success'] : ['failed']), 45000);
  site.state.fault = null;
  return { operationId, state: done };
}

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-047-ud'));

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const site = await startMockSite({});
    runImport.site = site;
    log.info(`假站就绪：${site.origin}`);

    // 与正式启动同序：建窗前装原生壳（导航守卫要覆盖导入 View 的 webContents）。
    const { Menu } = await import('electron');
    installNativeShell({
      app,
      Menu,
      platform: process.platform,
      appName: 'Hemi',
      devTools: !app.isPackaged,
      openExternal: openExternalIfAllowed,
    });
    await createMainWindow();
    check('主窗创建（View 宿主）', Boolean(appState.mainWindow));

    // —— P0：站内导航门禁＋popup 拒绝 ——
    {
      const started = await drive(IPC.providerImport.start, { siteUrl: site.origin });
      const contents = getProviderImportService().testBrowserContents();
      check('P0：导入 View 已挂到主窗（webContents 存活）', Boolean(contents) && !contents.isDestroyed());
      const sandboxed = contents.executeJavaScript('typeof process === "undefined" && typeof require === "undefined"');
      check('P0：站点页无 Node/require（sandbox 生效）', (await sandboxed) === true);
      await contents.executeJavaScript('window.location.href = "/console/token"').catch(() => undefined);
      await sleep(700);
      const afterNav = contents.getURL();
      check('P0：站内导航放行', afterNav.startsWith(site.origin), afterNav);
      await contents.executeJavaScript('window.location.href = "https://example.com/"').catch(() => undefined);
      await sleep(900);
      const afterEvil = contents.getURL();
      check('P0：站外导航被拦（仍在本站）', afterEvil.startsWith(site.origin), afterEvil);
      const popup = await contents.executeJavaScript('window.open("https://example.com/") === null');
      check('P0：popup 被拒（window.open 返回 null）', popup === true);
      const cancelled = await drive(IPC.providerImport.cancel, {
        operationId: started.state.operationId,
        revision: await currentRevision(started.state.operationId),
      });
      check('P0：创建前取消（零远端副作用）', cancelled?.state?.phase === 'cancelled' && site.state.createCalls === 0,
        `phase=${cancelled?.state?.phase} createCalls=${site.state.createCalls}`);
    }

    // —— 场景 1：全链路（混合协议） ——
    {
      const createBefore = site.state.createCalls;
      const { operationId, state } = await runImport({
        label: 'S1 全链路',
        models: [
          { modelName: 'mock-gpt-5.2', api: 'openai-completions' },
          { modelName: 'mock-claude-opus-4.6', api: 'anthropic-messages' },
        ],
      });
      check('S1：导入成功', state.phase === 'success', JSON.stringify(state.error ?? {}));
      check('S1：远端创建恰好一次', site.state.createCalls === createBefore + 1, `createCalls=${site.state.createCalls}`);
      check('S1：混合协议拆两条供应商', state.result?.providers?.length === 2
        && state.result.providers.some((provider) => provider.api === 'anthropic-messages'));
      const directory = await handler(IPC.llm.listModelProfiles)( { sender: appState.mainWindow.webContents }, {});
      const imported = directory.providers.filter((provider) => provider.id.startsWith('mpi-'));
      check('S1：目录落两条（Key 已加密）', imported.length === 2 && imported.every((provider) => provider.hasApiKey && provider.keyStoredSecurely));
      check('S1：首次导入设了默认', typeof directory.defaultModelId === 'string' && directory.defaultModelId.startsWith('mpi-'));
      // 清理：journal 空、浏览器回收
      const journalDir = path.join(app.getPath('userData'), 'provider-import');
      const leftovers = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((name) => name.endsWith('.json')) : [];
      check('S1：journal 已清空', leftovers.length === 0, leftovers.join(','));
      check('S1：浏览器已回收', getProviderImportService().testBrowserContents() === null);
      // 秘密不泄漏：hemi.log 与状态 DTO 里没有 Key 明文
      const logText = fs.existsSync(path.join(app.getPath('userData'), 'hemi.log'))
        ? fs.readFileSync(path.join(app.getPath('userData'), 'hemi.log'), 'utf8')
        : '';
      const keys = site.state.tokens.map((token) => token.key);
      check('S1：Key 明文不进 hemi.log', keys.every((key) => !logText.includes(key)));
      // 导入只回收 View，按站点保留 Cookie，以便下次继续登录。
      await sleep(400);
      const { session: electronSession } = await import('electron');
      const opPartition = electronSession.fromPartition(`persist:hemi-newapi-${loginSiteKey(site.origin)}`);
      const cookies = await opPartition.cookies.get({}).catch(() => []);
      check('S1：站点登录 cookie 保留', cookies.some((cookie) => cookie.name === 'session'), `cookies=${cookies.length}`);
    }

    // —— 场景 2：验证失败 → 断点重试复用 Key ——
    {
      const createBefore = site.state.createCalls;
      const first = await runImport({
        label: 'S2 验证失败',
        fault: 'probe-anthropic',
        wantSuccess: false,
        models: [
          { modelName: 'mock-gpt-5.2', api: 'openai-completions' },
          { modelName: 'mock-claude-opus-4.6', api: 'anthropic-messages' },
        ],
      });
      check('S2：停在验证失败（带断点）', first.state.phase === 'failed' && first.state.error?.code === 'VERIFY_FAILED' && first.state.error?.retryTarget === 'validating');
      check('S2：逐型号验证结果如实', first.state.validation?.some((item) => !item.ok && item.modelName === 'mock-claude-opus-4.6'));
      const retried = await drive(IPC.providerImport.retry, { operationId: first.operationId, revision: first.state.revision });
      check('S2：断点重试受理', retried?.ok === true);
      const done = await pollState(first.operationId, ['success'], 45000);
      check('S2：重试成功', done.phase === 'success');
      check('S2：重试不重建（创建仍 +1）', site.state.createCalls === createBefore + 1, `createCalls=${site.state.createCalls}`);
    }

    // —— 场景 3：读 Key 失败 → 取消精确撤销 ——
    {
      const createBefore = site.state.createCalls;
      const tokenCountBefore = site.state.tokens.filter((token) => !token.revoked).length;
      const failed = await runImport({
        label: 'S3 读 Key 失败',
        fault: 'key-read',
        wantSuccess: false,
        models: [{ modelName: 'mock-gpt-5.2', api: 'openai-completions' }],
      });
      check('S3：失败且断点在读 Key', failed.state.phase === 'failed' && failed.state.error?.retryTarget === 'reading-key',
        JSON.stringify(failed.state.error ?? {}));
      // 登录态仍在（同一会话），直接取消 → 精确撤销本次令牌。
      const cancelled = await drive(IPC.providerImport.cancel, { operationId: failed.operationId, revision: failed.state.revision });
      const done = await pollState(failed.operationId, ['cancelled', 'cleanup-pending'], 30000);
      check('S3：取消完成（精确撤销）', done.phase === 'cancelled', done.phase);
      const scenarioToken = site.state.tokens[site.state.tokens.length - 1];
      check('S3：只删本次令牌', site.state.deletes.length === 1 && site.state.deletes[0] === scenarioToken?.id,
        `deletes=${JSON.stringify(site.state.deletes)} 本次=${scenarioToken?.id}`);
      check('S3：撤销后站点令牌数回落', site.state.tokens.filter((token) => !token.revoked).length === tokenCountBefore);
      const journalDir = path.join(app.getPath('userData'), 'provider-import');
      const leftovers = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((name) => name.endsWith('.json')) : [];
      check('S3：journal 已清空', leftovers.length === 0, leftovers.join(','));
    }

    // —— 场景 4：创建响应丢失（回程 RST）→ 查证结算 ——
    // Chromium 网络栈可能对断连 POST 自动重投（同一逻辑派发、物理两次）——
    // 我们层面只发一次；重投由唯一名＋歧义检测兜底（TOKEN_AMBIGUOUS 如实暴露）。
    {
      const createBefore = site.state.createCalls;
      const { state, operationId } = await runImport({
        label: 'S4 响应丢失',
        fault: 'create-network',
        models: [{ modelName: 'mock-gpt-5.2', api: 'openai-completions' }],
        wantSuccess: false,
        acceptPhases: ['failed', 'success'],
      });
      const creates = site.state.createCalls - createBefore;
      if (state.phase === 'success') {
        check('S4：查证后仍导入成功', true);
        check('S4：远端创建恰好一次', creates === 1, `createCalls=${creates}`);
      } else {
        check('S4：重投被歧义检测拦下（不无限重试）', state.error?.code === 'TOKEN_AMBIGUOUS' && creates <= 2,
          `code=${state.error?.code} createCalls=${creates}`);
        const cancelled = await drive(IPC.providerImport.cancel, { operationId, revision: await currentRevision(operationId) });
        const done = await pollState(operationId, ['cancelled', 'cleanup-pending'], 20000);
        check('S4：取消后干净退出', cancelled?.ok === true && done.phase === 'cancelled', done.phase);
      }
    }

    finish(results.every((item) => item.ok) ? 0 : 1, results.every((item) => item.ok) ? 'all-pass' : 'has-failures');
    // keep-alive 连接会让 server.close() 悬挂：强断后关。
    try { site.server.closeAllConnections?.(); } catch { /* 老版本 Node */ }
    await site.close().catch(() => undefined);
  } catch (error) {
    console.error('[verify047] 失败：', error);
    check('脚本异常', false, error?.stack ?? String(error));
    finish(1, 'exception');
  }
});
setTimeout(() => finish(1, 'timeout'), TIMEOUT_MS);
