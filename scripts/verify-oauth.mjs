// Real Electron renderer/preload/IPC + production services + synthetic provider HTTP.
// node scripts/verify-oauth.mjs [--dev-url=http://127.0.0.1:5187]
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { waitForOAuth, startOAuthTestServer } from './oauth-test-fixture.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const out = path.resolve('.visual/workflow/vision');
if (!process.versions.electron) {
  const { spawn, execFileSync } = await import('node:child_process');
  const { default: electronPath } = await import('electron');
  const identity = `hemi-oauth-test-${randomUUID()}`;
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-oauth-electron-'));
  const devUrl = process.argv.find(arg => arg.startsWith('--dev-url='))?.slice(10);
  await fs.mkdir(out, { recursive: true });
  const reports = [];
  try {
    for (const phase of ['first', 'restart']) {
      const report = await new Promise((resolve, reject) => {
        const child = spawn(electronPath, [scriptPath], { env: { ...process.env, HEMI_SMOKE_TEST: '1', HEMI_USER_DATA_DIR: userData, HEMI_OAUTH_PHASE: phase, HEMI_OAUTH_TEST_IDENTITY: identity, ...(devUrl ? { VITE_DEV_SERVER_URL: devUrl } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
        // The child's transport uses its own isolated local HTTP fixture.
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; if (process.env.HEMI_OAUTH_VERBOSE) process.stdout.write(chunk); });
        child.stderr.on('data', chunk => { output += chunk; if (process.env.HEMI_OAUTH_VERBOSE) process.stderr.write(chunk); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); console.error(output.slice(-8000)); reject(new Error(`OAuth ${phase} timed out`)); }, 60000);
        child.on('error', reject);
        child.on('exit', code => {
          clearTimeout(timer);
          const raw = output.match(/HEMI_OAUTH_REPORT=(\{[^\n]+\})/)?.[1];
          if (code !== 0 || !raw) { console.error(output.slice(-8000)); reject(new Error(`OAuth ${phase} exited ${code}`)); return; }
          resolve(JSON.parse(raw));
        });
      });
      reports.push(report); console.log(`PASS Electron ${phase}: ${report.checks.length} checks`);
    }
    const reportPath = path.join(out, `oauth-electron-${devUrl ? 'dev' : 'built'}.json`);
    await fs.writeFile(reportPath, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: 'uncommitted OAuth changes plus concurrent workspace changes', node: process.version, platform: `${process.platform}/${process.arch}`, mode: devUrl ? 'dev' : 'built', command: `node scripts/verify-oauth.mjs${devUrl ? ` --dev-url=${devUrl}` : ''}`, reports }, null, 2));
  } finally {
    if (process.platform === 'darwin') { try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', `${identity} Safe Storage`], { stdio: 'ignore' }); } catch {} }
    await fs.rm(userData, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, shell, Menu, safeStorage } = await import('electron');
  // New account credentials, token refresh and restarts must be independent of
  // the system credential store. Obsolete formats are rejected, never imported.
  for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
    safeStorage[method] = () => { throw new Error('Unexpected system credential-store access'); };
  }
  if (!/^hemi-oauth-test-[a-f0-9-]+$/.test(process.env.HEMI_OAUTH_TEST_IDENTITY ?? '')) throw new Error('Isolated OAuth test identity required');
  app.setName(process.env.HEMI_OAUTH_TEST_IDENTITY);
  app.setPath('userData', process.env.HEMI_USER_DATA_DIR);
  const transport = await startOAuthTestServer();
  globalThis.fetch = transport.fetch;
  const browserUrls = [], checks = [];
  let completeChatGPT;
  const check = (name, passed) => { checks.push({ name, ok: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw new Error(name); };
  shell.openExternal = async raw => {
    const url = new URL(raw); browserUrls.push(url);
    if (url.hostname === 'auth.openai.com') {
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ code: 'test-browser-code', state: url.searchParams.get('state'), client_id: 'test-hemi-client' });
      completeChatGPT = () => transport.originalFetch(callback);
    }
  };
  void app.whenReady().then(async () => {
  let mainWindow;
  try {
    const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
    const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
    const { state } = await import('../src/main/state.mjs');
    const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
    console.log('OAuth verification: registering production IPC');
    await registerAllIpcHandlers();
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: true, openExternal: async () => {} });
    console.log('OAuth verification: loading renderer');
    await createMainWindow(); mainWindow = state.mainWindow;
    mainWindow.webContents.on('console-message', event => { if (event.level === 'error') console.error(`Renderer: ${event.message}`); });
    const execute = code => mainWindow.webContents.executeJavaScript(code).catch(error => { throw new Error(`Renderer check failed (${code.slice(0, 120)}): ${error.message}`); });
    const invoke = (name, argument) => execute(`window.hemiVoice[${JSON.stringify(name)}](${argument === undefined ? '' : JSON.stringify(argument)})`);
    const until = predicate => waitForOAuth(() => execute(predicate).catch(() => false), value => value);
    const clickText = async (text, selector = 'button') => {
      const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(text)})`;
      await until(`Boolean((${find}) && !(${find}).disabled)`);
      return execute(`(${find}).click()`);
    };
    const loginState = predicate => waitForOAuth(() => invoke('getOAuthLoginState'), predicate);
    await until('Boolean(window.hemiVoice?.startOAuthLogin && document.querySelector(".setup-shell, textarea.text-composer-input"))');
    if (process.env.HEMI_OAUTH_PHASE === 'first') {
      await clickText('开始设置');
      await until('Boolean(document.querySelector(".h-oauth"))');
      check('首启提供四种账号登录', await execute('document.querySelectorAll(".h-oauth-row").length === 4'));
      const claudeTrigger = '[...document.querySelectorAll(".h-oauth-row")].find(row => row.textContent.includes("Claude")).querySelector("button")';
      await execute(`(${claudeTrigger}).click()`);
      const pendingClaude = await loginState(s => s?.provider === 'anthropic' && s?.prompt?.type === 'select');
      await until('Boolean([...document.querySelectorAll("[role=dialog]")].find(dialog => dialog.textContent.includes("登录 Claude") && dialog.contains(document.activeElement)))');
      check('登录立即显示有名称的授权弹窗', true);
      mainWindow.webContents.reload();
      await until('Boolean(document.querySelector(".h-oauth-dialog"))');
      check('重载后恢复正在进行的授权弹窗', (await invoke('getOAuthLoginState')).id === pendingClaude.id && await execute('document.querySelector(".h-oauth-dialog").textContent.includes("登录 Claude")'));
      mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await until('!document.querySelector(".h-oauth-dialog")');
      check('Esc 关闭弹窗并取消真实登录任务', (await invoke('getOAuthLoginState')).phase === 'cancelled');
      await execute(`(${claudeTrigger}).click()`);
      await loginState(s => s?.phase === 'login' && s?.prompt);
      await until('document.querySelector(".h-oauth-close")?.getAttribute("aria-label") === "取消登录并关闭"');
      await execute('document.querySelector(".h-oauth-close").click()');
      await until('!document.querySelector(".h-oauth-dialog")');
      check('关闭按钮取消登录并恢复按钮焦点', (await invoke('getOAuthLoginState')).phase === 'cancelled' && await execute(`(${claudeTrigger}) === document.activeElement`));
      transport.bigmodel.state.pending = 1000;
      transport.bigmodel.state.polls = 0;
      const pendingBigModel = await invoke('startOAuthLogin', 'bigmodel');
      await loginState(s => s?.provider === 'bigmodel' && s?.url);
      mainWindow.webContents.reload();
      await until('document.querySelector(".h-oauth-dialog")?.textContent.includes("GLM Coding Plan")');
      check('GLM 轮询授权在 renderer 重载后恢复', (await invoke('getOAuthLoginState')).id === pendingBigModel.id);
      await execute('document.querySelector(".h-oauth-close").click()');
      await until('!document.querySelector(".h-oauth-dialog")');
      check('取消 GLM 授权不会导入未完成的账号', (await invoke('getOAuthLoginState')).phase === 'cancelled' && !(await invoke('listModelProfiles')).providers.some(provider => provider.oauthProvider === 'bigmodel'));
      transport.bigmodel.state.pending = 0;
      await execute('[...document.querySelectorAll(".h-oauth-row")].find(row => row.textContent.includes("ChatGPT")).querySelector("button").click()');
      await waitForOAuth(() => Boolean(completeChatGPT), Boolean);
      await until('document.querySelector(".h-oauth-dialog")?.textContent.includes("登录 ChatGPT")');
      check('浏览器授权期间保留进度弹窗', (await invoke('getOAuthLoginState')).phase === 'login');
      await completeChatGPT();
      await until('Boolean(document.querySelector("#onboarding-default-model"))');
      check('登录完成后关闭弹窗并导入可选模型', await execute('!document.querySelector(".h-oauth-dialog") && document.querySelector("#onboarding-default-model").textContent.includes("gpt-4.1")'));
      await clickText('验证并继续');
      await until('document.querySelector(".setup-shell")?.dataset.step === "capabilities"');
      check('真实 OAuth 工具调用探活通过首启门槛', true);
      for (const provider of ['anthropic', 'github-copilot', 'bigmodel']) {
        const start = await invoke('startOAuthLogin', provider);
        if (provider !== 'bigmodel') {
          const prompt = await loginState(s => s?.prompt);
          await invoke('answerOAuthLogin', { id: start.id, promptId: prompt.prompt.id, value: provider === 'anthropic' ? 'copy_code' : '' });
        }
        if (provider === 'anthropic') {
          const manual = await loginState(s => s?.prompt?.type === 'manual_code');
          await invoke('answerOAuthLogin', { id: start.id, promptId: manual.prompt.id, value: `test-code#${browserUrls.at(-1).searchParams.get('state')}` });
        }
        const completed = await loginState(s => s?.phase !== 'login');
        check(`${provider} 通过真实 preload/IPC 完成登录`, completed.phase === 'success');
      }
      const directory = await invoke('listModelProfiles');
      check('四家账号均可用且目录不含凭据', directory.providers.filter(provider => provider.oauthProvider && provider.hasApiKey).length === 4 && !/test-access|synthetic-bigmodel|synthetic-project/.test(JSON.stringify(directory)));
      await clickText('继续');
      await until('document.querySelector(".setup-shell")?.dataset.step === "done"');
      await clickText('开始使用');
      await until('Boolean(document.querySelector("textarea.text-composer-input"))');
      for (const account of directory.providers.filter(provider => provider.oauthProvider)) {
        const model = account.models.find(item => item.model === 'gpt-5-mini') ?? account.models[0];
        await execute('document.querySelector(".h24-model-chip").click()');
        await until('Boolean(document.querySelector(".h37-model-menu"))');
        await execute(`(() => { const model = [...document.querySelectorAll('.h37-model-menu [role="menuitemradio"]')].find(item => item.textContent.includes(${JSON.stringify(model.model)})); if (!model || model.disabled) throw new Error('OAuth model unavailable'); model.click(); })()`);
        await until(`document.querySelector('.h24-model-chip')?.textContent.includes(${JSON.stringify(model.model)})`);
        const count = await execute('(document.body.innerText.match(/OAuth OK/g) ?? []).length');
        const prompt = `OAuth UI ${account.oauthProvider}`;
        await execute(`(() => { const input = document.querySelector('textarea.text-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await until('!document.querySelector(".text-composer-send").disabled');
        await execute('document.querySelector(".text-composer-send").click()');
        await until(`(document.body.innerText.match(/OAuth OK/g) ?? []).length > ${count}`);
        await until('document.querySelector(".text-composer-send")?.dataset.action === "send"');
        check(`${account.oauthProvider} 在真实对话选择器中选择并完成回复`, transport.requests.some(request => { try { return JSON.parse(request.body).model === model.model && request.body.includes(prompt); } catch { return false; } }));
      }
      // Registered secondary windows and external frames do not own OAuth IPC.
      const foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('src/preload/index.cjs'), contextIsolation: true, sandbox: true } });
      await foreign.loadURL('data:text/html,<body>untrusted</body>');
      const denied = await foreign.webContents.executeJavaScript('window.hemiVoice.getOAuthLoginState().then(() => false, () => true)');
      check('非主窗口调用被生产 IPC 拒绝', denied); foreign.destroy();
      const pending = await invoke('startOAuthLogin', 'anthropic');
      await loginState(s => s?.prompt);
      mainWindow.webContents.reload();
      await until('Boolean(window.hemiVoice?.getOAuthLoginState && document.querySelector(".setup-shell, textarea.text-composer-input"))');
      check('renderer 重载后登录步骤可恢复', (await invoke('getOAuthLoginState')).id === pending.id);
      await invoke('cancelOAuthLogin', pending.id);
      check('取消登录真实收口', (await invoke('getOAuthLoginState')).phase === 'cancelled');
      await mainWindow.webContents.capturePage().then(image => fs.writeFile(path.join(out, `oauth-electron-${process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built'}.png`), image.toPNG()));
    } else {
      const directory = await invoke('listModelProfiles');
      check('进程重启后加密账号与模型选择恢复', directory.providers.filter(provider => provider.oauthProvider && provider.hasApiKey).length === 4 && Boolean(directory.defaultModelId));
      const modelKey = directory.defaultModelId;
      const probe = await invoke('testModelProfile', { modelKey });
      check('重启后的账号凭据可用于真实请求通道', probe.ok);
      const codingKey = directory.providers.find(provider => provider.oauthProvider === 'bigmodel').models[0].modelKey;
      check('重启后的 GLM 账号可重新握手并调用模型', (await invoke('testModelProfile', { modelKey: codingKey })).ok);
      await invoke('logoutOAuth', 'openai');
      const after = await invoke('listModelProfiles');
      check('退出后模型仍保留并标记未登录', after.providers.find(provider => provider.oauthProvider === 'openai')?.hasApiKey === false);
      check('退出后原模型请求被拒绝', !(await invoke('testModelProfile', { modelKey })).ok);
    }
    const secrets = await fs.readFile(path.join((await import('../src/main/agent-runtime/storage-migration.mjs')).runtimeDataDir(app.getPath('userData')), 'oauth-credentials.json'), 'utf8');
    check('磁盘只包含加密凭据', !/test-access|test-refresh|test-github-token|synthetic-bigmodel|synthetic-project/.test(secrets));
    console.log(`HEMI_OAUTH_REPORT=${JSON.stringify({ phase: process.env.HEMI_OAUTH_PHASE, rendererUrl: mainWindow.webContents.getURL(), checks, externalAccounts: false })}`);
    await transport.close(); mainWindow.destroy(); app.exit(0);
  } catch (error) { console.error(error); if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.webContents.capturePage().then(image => fs.writeFile(path.join(out, 'oauth-electron-failure.png'), image.toPNG())).catch(() => {}); await transport.close(); app.exit(1); }
  });
}
