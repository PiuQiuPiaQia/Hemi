// Node 父进程保留同一个假站/端口，串行启动真实 Electron，验证登录状态与密码跨进程恢复。
// node scripts/verify-047-login-memory.mjs [--dev-url=http://127.0.0.1:5173]
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TEST_USER } from './mock-newapi-site.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const updatedPassword = 'hemi-local-test-updated-秘密-20261020';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidenceDir = path.resolve('.visual/workflow/vision');

if (!process.versions.electron) {
  const { startMockSite } = await import('./mock-newapi-site.mjs');
  const { spawn } = await import('node:child_process');
  const { default: electronPath } = await import('electron');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-047-login-'));
  const site = await startMockSite();
  const other = await startMockSite();
  const devUrl = process.argv.find((arg) => arg.startsWith('--dev-url='))?.slice('--dev-url='.length);
  const simplePage = (body, script = '') => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script>${script}</script></body></html>`;
  const form = '<form id="login-form"><input id="username" name="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button type="submit">登录</button></form>';
  site.state.pages.set('/register', simplePage(form.replace('current-password', 'new-password')));
  site.state.pages.set('/test-reset', simplePage(form.replace('current-password', 'new-password')));
  site.state.pages.set('/test-spa', simplePage('', `setTimeout(() => { document.body.innerHTML = ${JSON.stringify(form)}; }, 300)`));
  site.state.pages.set('/test-custom', simplePage(form.replace('id="username"', 'id="username" value="other-user"')));
  site.state.pages.set('/test-iframe', simplePage(`<iframe src="${other.origin}/"></iframe>`));
  site.state.pages.set('/test-external-action', simplePage(form.replace('<form ', `<form action="${other.origin}/api/user/login" `)));
  const { build } = await import('esbuild');
  const reactBundle = await build({ stdin: { contents: `
    import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    function Login() {
      const [username, setUsername] = useState(''), [password, setPassword] = useState('');
      return <form id="login-form" onSubmit={event => { event.preventDefault(); document.body.dataset.reactStateReady = String(username === ${JSON.stringify(TEST_USER.username)} && password === ${JSON.stringify(TEST_USER.password)}); }}>
        <input id="username" name="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)}/>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/>
        <button type="submit">登录</button></form>;
    } createRoot(document.getElementById('root')).render(<React.StrictMode><Login/></React.StrictMode>);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
  site.state.pages.set('/test-react', simplePage('<div id="root"></div>', reactBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')));
  await fs.mkdir(evidenceDir, { recursive: true });
  const reports = [];
  try {
    for (const phase of ['first', 'restart', 'expired', 'change', 'updated']) {
      if (phase === 'expired' || phase === 'change') site.state.sessions.clear();
      if (phase === 'updated') { site.state.sessions.clear(); site.state.password = updatedPassword; }
      const report = await new Promise((resolve, reject) => {
        const child = spawn(electronPath, [scriptPath], {
          env: { ...process.env, HEMI_SMOKE_TEST: '1', HEMI_USER_DATA_DIR: userData,
            HEMI_LOGIN_PHASE: phase, HEMI_LOGIN_ORIGIN: site.origin, HEMI_LOGIN_OTHER: other.origin,
            ...(devUrl ? { VITE_DEV_SERVER_URL: devUrl } : {}), },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); if (process.env.HEMI_LOGIN_VERBOSE) process.stdout.write(chunk); });
        child.stderr.on('data', (chunk) => { output += chunk.toString(); if (process.env.HEMI_LOGIN_VERBOSE) process.stderr.write(chunk); });
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Electron ${phase} timeout`)); }, 120000);
        child.on('error', reject);
        child.on('exit', (code) => {
          clearTimeout(timeout);
          const raw = output.match(/HEMI_047_LOGIN_CHILD=(\{[^\n]+\})/)?.[1];
          if (!raw || code !== 0) { console.error(output.slice(-14000)); reject(new Error(`Electron ${phase} exit ${code}`)); return; }
          resolve(JSON.parse(raw));
        });
      });
      reports.push(report);
      console.log(`${phase}: ${report.checks.length} checks passed (${report.rendererUrl})`);
      if (phase === 'first' && site.state.loginCalls !== 1) throw new Error('first: unexpected login count');
      if (phase === 'restart' && site.state.loginCalls !== 1) throw new Error('restart submitted login unexpectedly');
      if (phase === 'expired' && site.state.loginCalls !== 3) throw new Error('expired: unexpected login count');
      if (phase === 'change' && site.state.loginCalls !== 4) throw new Error('change: unexpected login count');
      if (phase === 'updated' && site.state.loginCalls !== 5) throw new Error('updated: unexpected login count');
      if (phase === 'expired') site.state.password = updatedPassword;
    }
    const evidence = { passed: true, userData, devUrl: devUrl ?? null, loginCalls: site.state.loginCalls, reports };
    await fs.writeFile(path.join(evidenceDir, `login-memory-${devUrl ? 'dev' : 'build'}-result.json`), JSON.stringify(evidence, null, 2));
    console.log(`HEMI_047_LOGIN_RESULT=${JSON.stringify(evidence)}`);
  } finally {
    site.server.closeAllConnections(); other.server.closeAllConnections();
    await site.close(); await other.close();
  }
} else {
  const { app, safeStorage } = await import('electron');
  app.setName('hemi');
  app.setPath('userData', process.env.HEMI_USER_DATA_DIR);
  const phase = process.env.HEMI_LOGIN_PHASE;
  const origin = process.env.HEMI_LOGIN_ORIGIN;
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${phase}: ${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw new Error(name); };
  let mainWindow, service;
  async function poll(fn, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await fn().catch(() => false)) return; await sleep(80); }
    throw new Error(`Timeout: ${label}`);
  }
  const execute = (code) => mainWindow.webContents.executeJavaScript(code);
  // 真实 renderer 的 preload→ipcRenderer.invoke→生产 IPC/coordinator，不直接调用 handler。
  async function invoke(method, payload) {
    return execute(`window.hemiVoice[${JSON.stringify(method)}](${payload === undefined ? '' : JSON.stringify(payload)})`);
  }
  const state = async () => (await invoke('getProviderImportState')).state;
  const contents = () => service.testBrowserContents();
  const siteExec = (code) => contents().executeJavaScript(code);
  async function start(siteUrl = origin) {
    const result = await invoke('startProviderImport', { siteUrl });
    check('打开站点进入 login', result.state?.phase === 'login');
    await invoke('setProviderImportViewport', { operationId: result.state.operationId, bounds: { x: 40, y: 80, width: 740, height: 520 }, visible: true });
    return result;
  }
  async function cancel() {
    const current = await state();
    await invoke('cancelProviderImport', { operationId: current.operationId, revision: current.revision });
    await poll(async () => (await state()).phase === 'cancelled', 'cancel');
  }
  async function verify() {
    const current = await state();
    const result = await invoke('checkProviderImportLogin', { operationId: current.operationId, revision: current.revision });
    check('真实服务端核验账号', result.ok && result.state.phase === 'selecting' && result.state.accountLabel.includes(TEST_USER.username));
  }
  async function filled(password = TEST_USER.password) {
    await poll(() => siteExec(`Boolean(document.querySelector('#password')?.value === ${JSON.stringify(password)} && document.querySelector('#username')?.value === ${JSON.stringify(TEST_USER.username)})`), 'autofill');
    check('登录表单实际补齐账号密码', true);
  }
  async function login(password = null) {
    await siteExec(`(() => {
      const username = document.querySelector('#username'), password = document.querySelector('#password');
      if (${JSON.stringify(password)} !== null) { username.value = ${JSON.stringify(TEST_USER.username)}; password.value = ${JSON.stringify(password)}; }
      document.querySelector('#login-form').requestSubmit();
    })()`);
    await poll(() => siteExec(`Boolean(document.body.dataset.booted === '1')`), 'login completes');
  }
  async function fileSecrets() {
    const directory = path.join(app.getPath('userData'), 'provider-logins');
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'));
    check('本机存在加密登录档案', names.length > 0);
    for (const name of names) {
      const raw = await fs.readFile(path.join(directory, name), 'utf8');
      const payload = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(raw).encrypted, 'base64')));
      check('磁盘无明文账号密码 Cookie', ![TEST_USER.username, TEST_USER.password, updatedPassword, origin, 's7'].some((secret) => raw.includes(JSON.stringify(secret))));
      if (payload.origin === origin) check('真实 safeStorage 可解密本次账号', payload.credentials?.username === TEST_USER.username);
    }
    const dto = JSON.stringify(await state());
    const logText = await fs.readFile(path.join(app.getPath('userData'), 'hemi.log'), 'utf8').catch(() => '');
    check('密码不进入 DTO 或日志', [TEST_USER.password, updatedPassword].every((secret) => !dto.includes(secret) && !logText.includes(secret)));
  }
  void app.whenReady().then(async () => {
  try {
    const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
    initializeStableSafeStorageIdentity();
    const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
    const { getProviderImportService } = await import('../src/main/ipc/provider-import.ipc.mjs');
    const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
    const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
    const { Menu } = await import('electron');
    const { state: appState } = await import('../src/main/state.mjs');
    await registerAllIpcHandlers();
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: true, openExternal: async () => {} });
    await createMainWindow();
    mainWindow = appState.mainWindow;
    service = getProviderImportService();
    await poll(() => execute('Boolean(window.hemiVoice?.startProviderImport)'), 'renderer bridge');
    await start();
    check('站点没有通用 Hemi/Node 桥', await siteExec('!window.hemiVoice && !window.require && !window.process'));
    if (phase === 'first') {
      const firstUserAgent = contents().getUserAgent();
      await poll(() => siteExec('Boolean(document.querySelector("#login-form"))'), 'first form');
      check('首次表单为空', await siteExec('!username.value && !password.value'));
      await login(TEST_USER.password);
      await verify();
      await fileSecrets();
      await cancel();
      await start();
      check('重开保持相同浏览器身份', contents().getUserAgent() === firstUserAgent);
      await poll(() => siteExec('document.body.dataset.booted === "1"'), 'same process restored');
      check('关闭重开保持登录', await siteExec('!document.querySelector("#password")'));
      await verify();
    } else if (phase === 'restart') {
      await poll(() => siteExec('document.body.dataset.booted === "1"'), 'cross-process restored');
      check('重启后 Cookie 和 localStorage 均恢复', await siteExec('localStorage.getItem("uid") === "7" && !document.querySelector("#password")'));
      await verify();
    } else {
      await filled(phase === 'updated' ? updatedPassword : TEST_USER.password);
      if (phase === 'expired') {
        await siteExec(`password.value = 'intentionally-wrong'; document.querySelector('#login-form').requestSubmit()`);
        await poll(() => siteExec('Boolean(document.body.dataset.loginError)'), 'injected failed password');
        const { createLoginStore } = await import('../src/main/services/provider-import/login-store.mjs');
        const stored = createLoginStore({ dirPath: path.join(app.getPath('userData'), 'provider-logins'), safeStorage });
        check('实际错误登录未覆盖旧密码', (await stored.read(origin)).credentials.password === TEST_USER.password);
        await contents().loadURL(`${origin}/test-spa`);
        await filled();
        check('SPA 后挂载表单可自动补齐', true);
        await siteExec(`username.value = ''; password.value = ''; username.dispatchEvent(new Event('input', {bubbles: true})); password.dispatchEvent(new Event('input', {bubbles: true})); document.body.appendChild(document.createElement('div'));`);
        await sleep(250);
        check('用户主动清空后不重新填入', await siteExec('!username.value && !password.value'));
        await contents().loadURL(`${origin}/test-external-action`);
        await sleep(250);
        check('跨站提交的表单不补密码', await siteExec('!username.value && !password.value'));
        await contents().loadURL(`${origin}/test-react`);
        await filled();
        await siteExec(`document.querySelector('#login-form').requestSubmit()`);
        check('React 受控表单的实际状态与补全一致', await siteExec(`document.body.dataset.reactStateReady === 'true'`));
        await contents().loadURL(`${origin}/register`);
        check('注册表单不补密码', await siteExec('!password.value && !username.value'));
        await contents().loadURL(`${origin}/test-reset`);
        check('重置密码不补密码', await siteExec('!password.value'));
        await contents().loadURL(`${origin}/test-custom`);
        await sleep(300);
        check('已有其它账号不被覆盖', await siteExec('username.value === "other-user" && !password.value'));
        await contents().loadURL(`${origin}/test-iframe`);
        await sleep(300);
        check('子 frame 无登录 preload及密码', contents().mainFrame.frames.length === 1
          && await contents().mainFrame.frames[0].executeJavaScript('!window.hemiVoice && !username.value && !password.value'));
        await cancel();
        await start(process.env.HEMI_LOGIN_OTHER);
        await poll(() => siteExec('Boolean(document.querySelector("#password"))'), 'other origin form');
        check('不同端口站点不获得账号密码', await siteExec('!username.value && !password.value'));
        await cancel();
        await start();
        await filled();
        await login();
        await verify();
        // 更新密码的独立成功登录由父进程下一阶段接续验证。
      } else if (phase === 'change') {
        await login(updatedPassword);
        await verify();
        await fileSecrets();
      } else {
        await login();
        await verify();
        await fileSecrets();
      }
    }
    const rendererUrl = mainWindow.webContents.getURL();
    console.log(`HEMI_047_LOGIN_CHILD=${JSON.stringify({ phase, rendererUrl, checks })}`);
    mainWindow.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
  });
}
