// Real Electron IPC -> SSH runner -> CLI/Unix socket Host -> native Pi OAuth and
// inference. Only SSH's OS boundary and the external provider HTTP are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { createServer } from 'vite';
import { _electron } from 'playwright-core';
import { rpc } from '../src/main/bot/cli.mjs';
import { startOAuthTestServer, oauthTestReply } from './oauth-test-fixture.mjs';
import { startMockSite, TEST_USER } from './mock-newapi-site.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp('/tmp/hemi-bot-oauth-ui-');
const evidence = path.join(repo, '.visual/workflow/bot-oauth');
await fs.mkdir(evidence, { recursive: true });
const provider = await startOAuthTestServer();
const address = (os.networkInterfaces().en0 ?? Object.values(os.networkInterfaces()).flat()).find(item => item?.family === 'IPv4' && !item.internal)?.address;
assert.ok(address, 'a local LAN address is required to verify explicit local-to-Bot synchronization');
const newapi = await startMockSite({ host: '0.0.0.0', inferenceHandler: async ({ body, req, res, api }) => {
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(api === 'anthropic-messages' ? { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } : { choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    return;
  }
  const reply = oauthTestReply('https://fixture.invalid' + req.url, { body: JSON.stringify(body) });
  res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(Buffer.from(await reply.arrayBuffer()));
} });
newapi.origin = newapi.origin.replace('0.0.0.0', '127.0.0.1');
const syncOrigin = newapi.origin.replace('127.0.0.1', address);
const checks = [], screenshots = [], errors = [];
let host, app, vite, failure, livePage;
const wait = async (read, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error('Timed out: ' + label);
};
const note = name => { checks.push(name); console.log('PASS', name); };
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const child = host; host = null;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
}
try {
  vite = await createServer({ configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  for (const mode of process.argv.includes('--built-only') ? ['built'] : ['dev', 'built']) {
    const work = path.join(root, mode), home = path.join(work, 'home'), profile = path.join(work, 'profile');
    const data = path.join(home, '.local/share/hemi-bot/data'), socket = path.join(data, 'control.sock');
    await fs.mkdir(home, { recursive: true }); await fs.mkdir(profile, { recursive: true });
    const preload = path.join(work, 'provider.mjs');
    await fs.writeFile(preload, `const originalFetch=globalThis.fetch;globalThis.fetch=(url,init)=>new URL(String(url)).protocol==='https:'?originalFetch(${JSON.stringify(provider.origin)}+'/?target='+encodeURIComponent(String(url)),init):originalFetch(url,init);`);
    const cli = path.join(repo, 'src/main/bot/cli.mjs');
    const env = { ...process.env, HEMI_BOT_DATA_DIR: data, HEMI_BOT_ISOLATED_TEST: '1', HEMI_USER_DATA_DIR: path.join(work, 'host-profile') };
    // Child environments are isolated; no change to this shell's HOME.
    env.HOME = home;
    host = spawn(process.execPath, ['--import', preload, cli, 'serve'], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let hostErrors = '';
    host.stderr.on('data', chunk => { hostErrors += chunk; });
    await wait(() => { if (host.exitCode !== null) throw new Error('Host failed: ' + hostErrors); return fs.access(socket).then(() => true, () => false); }, 'Host socket');
    const hello = await rpc({ method: 'handshake' }, { socket });
    const call = (method, params = {}) => rpc({ method, params: { instanceId: hello.instanceId, requestId: 'verify-' + crypto.randomUUID(), ...params } }, { socket });
    const wrapper = path.join(work, 'ssh');
    await fs.writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nconst command=process.argv.at(-1);\nif(process.argv.includes('-O'))process.exit(0);\nif(command==='uname -s'){console.log('Linux');process.exit(0);}if(command.includes('emit runtimeNeeded')){for(const [key,value] of Object.entries(${JSON.stringify({ home, nodeBin: process.execPath, node: process.version, arch: process.arch, runtimeNeeded: '0', existing: '1' })}))console.log('__HB_'+key+'='+Buffer.from(value).toString('base64'));}else if(command.includes('cli.mjs')){const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(data)}},stdio:'inherit'});child.on('exit',code=>process.exit(code??1));}else{console.error('Unexpected fixture SSH command');process.exit(1);}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
    const appEnv = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: wrapper, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0' };
    for (const key of Object.keys(appEnv)) if (key.startsWith('HEMI_LLM_')) delete appEnv[key];
    if (mode === 'dev') appEnv.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete appEnv.VITE_DEV_SERVER_URL;
    app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env: appEnv, timeout: 30000 });
    let page;
    await wait(() => { page = app.windows().find(value => /^(http|file):/.test(value.url()) && !new URL(value.url()).searchParams.has('mode')); return !!page; }, 'main window');
    page.setDefaultTimeout(30000);
    livePage = page;
    page.on('pageerror', error => errors.push(mode + ': ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(mode + ' console: ' + message.text()); });
    await app.evaluate(({ shell }, origin) => {
      const original = globalThis.fetch;
      globalThis.__botFetchEvents = [];
      globalThis.fetch = async (url, init) => {
        globalThis.__botFetchEvents.push(String(url));
        try { return await (new URL(String(url)).protocol === 'https:' ? original(origin + '/?target=' + encodeURIComponent(String(url)), init) : original(url, init)); }
        catch (error) { globalThis.__botFetchEvents.push(String(error)); throw error; }
      };
      globalThis.__botAuthUrls = [];
      shell.openExternal = async raw => { globalThis.__botAuthUrls.push(raw); };
    }, provider.origin);
    await app.evaluate(async () => { const response = await globalThis.fetch('https://api.openai.com/v1/models'); if (!response.ok) throw new Error('fixture fetch failed'); });
    const state = () => page.evaluate(() => window.hemiVoice.bot.getState());
    const command = (method, params = {}) => page.evaluate(({ method, params }) => window.hemiVoice.bot.command(method, params), { method, params });
    async function resize(width) {
      await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows().find(win => /^(http|file):/.test(win.webContents.getURL())); win.setMinimumSize(1, 1); win.setContentSize(width, 900); }, width);
      await page.waitForFunction(width => innerWidth === width, width);
    }
    async function shot(label) {
      const file = `${mode}-${label}.png`;
      await page.screenshot({ path: path.join(evidence, file), animations: 'disabled', scale: 'css' }); screenshots.push(file);
    }
    await page.locator('.h24-navrail [data-page=bot]').waitFor({ timeout: 60000 });
    await page.locator('.h24-navrail [data-page=bot]').click();
    await page.getByRole('button', { name: '创建连接', exact: true }).click();
    await page.getByRole('textbox', { name: 'SSH 地址', exact: true }).fill('fixture-bot');
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    const setup = page.getByRole('dialog', { name: '配置云端 Bot', exact: true });
    await setup.getByRole('radio', { name: /^订阅/ }).waitFor();
    assert.deepEqual(await setup.getByRole('radio').allTextContents(), [
      '订阅登录账号，使用订阅模型与额度', 'New API登录 New API 站点并导入模型',
      'API 配置填写接口地址、API Key 和型号', '本机配置对比并选择要同步的本机配置',
    ]);
    await setup.getByRole('radio', { name: /^订阅/ }).click();
    for (const width of [1440, 768, 375]) {
      await resize(width); assert.ok(await setup.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await shot('setup-account-' + width);
    }
    await resize(1440);
    await setup.getByRole('button', { name: '部署并登录账号', exact: true }).click();
    await page.getByRole('button', { name: '添加供应商', exact: true }).first().click();
    await page.getByRole('heading', { name: '账号登录', exact: true }).waitFor();
    assert.equal((await state()).cache.models.length, 0);
    assert.equal(await page.locator('.h-oauth-row').count(), 4);
    note(mode + ': subscription-only first initialization reaches Bot account settings without an API Key');
    const account = name => page.locator('.h-oauth-row').filter({ has: page.getByText(name, { exact: true }) });
    await account('Claude').getByRole('button', { name: '登录', exact: true }).click();
    const claude = page.getByRole('dialog', { name: '为 Bot 登录 Claude', exact: true });
    await claude.getByRole('button', { name: '复制授权码登录', exact: true }).waitFor();
    const pending = await command('oauth.state');
    await page.reload();
    await page.locator('.h24-navrail [data-page=bot]').click();
    await page.getByRole('dialog', { name: '为 Bot 登录 Claude', exact: true }).waitFor();
    assert.equal((await command('oauth.state')).id, pending.id);
    await page.keyboard.press('Escape');
    await page.locator('.h-oauth-dialog').waitFor({ state: 'hidden' });
    assert.equal((await command('oauth.state')).phase, 'cancelled');
    note(mode + ': renderer reload restores the Bot authorization dialog; Escape cancels it');
    await account('ChatGPT').getByRole('button', { name: '登录', exact: true }).click();
    await wait(async () => (await command('oauth.state'))?.prompt?.type === 'manual_code', 'ChatGPT prompt');
    await page.locator('.h-oauth-prompt input').waitFor();
    for (const width of [1440, 768, 375]) {
      await resize(width); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await shot('authorization-' + width);
    }
    await resize(1440);
    const url = new URL((await command('oauth.state')).url);
    const hostId = (await call('oauth.prepare')).deviceId;
    assert.equal(url.searchParams.get('ext_agent_host_id'), `urn:uuid:${hostId}`);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ code: 'ui-test-browser-code', state: url.searchParams.get('state'), client_id: 'ui-bot-issued-client' });
    await provider.originalFetch(callback);
    await wait(async () => {
      const login = await command('oauth.state');
      if (login?.phase === 'failed' || login?.phase === 'cancelled') throw new Error('Bot authorization failed: ' + login.message);
      return login?.phase === 'success';
    }, 'cloud account import').catch(async error => { console.error('Bot auth diagnostic', await command('oauth.state'), (await state()).error, provider.requests.map(request => request.url), await app.evaluate(() => globalThis.__botFetchEvents)); throw error; });
    await page.locator('.h-oauth-dialog').waitFor({ state: 'hidden' });
    await page.getByRole('region', { name: '订阅', exact: true }).locator('.h37m-provider-row').waitFor();
    const local = await page.evaluate(() => window.hemiVoice.listModelProfiles());
    assert.equal(local.providers.length, 0);
    const model = (await state()).cache.models.find(model => model.oauthProvider === 'openai');
    assert.ok(model && model.oauthConnected);
    await page.getByRole('button', { name: '配置…', exact: true }).click();
    const routing = page.getByRole('dialog', { name: '模型路由', exact: true });
    await routing.getByRole('combobox', { name: '主 agent', exact: true }).selectOption(model.key);
    await wait(async () => (await state()).cache.roleModels.main === model.key, 'account route');
    await routing.getByRole('button', { name: '关闭', exact: true }).click();
    note(mode + ': local browser OAuth uses the Bot host ID, installs over the actual IPC/SSH/socket chain and configures native routing');
    for (const width of [1440, 768, 375]) {
      await resize(width); await page.getByRole('region', { name: '从本机同步的模型', exact: true }).scrollIntoViewIfNeeded(); await shot('settings-' + width);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' }); await shot('dark-preference-reduced-motion');
    await page.emulateMedia({ colorScheme: 'light' }); await resize(1440);
    await page.getByRole('region', { name: '订阅', exact: true }).locator('.h37m-provider-row').click();
    await account('ChatGPT').getByRole('button', { name: '退出登录', exact: true }).click();
    await account('ChatGPT').getByRole('button', { name: '登录', exact: true }).waitFor();
    assert.equal((await state()).cache.models.find(item => item.key === model.key).oauthConnected, false);
    assert.equal((await state()).cache.roleModels.main, model.key);
    // Re-login has a new operation revision sequence; the shared dialog must
    // accept it after logout rather than treating it as an old response.
    await account('ChatGPT').getByRole('button', { name: '登录', exact: true }).click();
    await wait(async () => (await command('oauth.state'))?.prompt, 'relogin');
    await page.getByRole('dialog', { name: '为 Bot 登录 ChatGPT', exact: true }).getByRole('button', { name: '取消登录', exact: true }).click();
    await page.locator('.h-oauth-dialog').waitFor({ state: 'hidden' });
    note(mode + ': logout preserves model keys and routing; a fresh authorization remains usable');
    const importSite = async () => {
      await page.getByRole('textbox', { name: 'New API 站点', exact: true }).fill(newapi.origin);
      await page.getByRole('button', { name: '打开站点并登录', exact: true }).click();
      await wait(async () => {
        const result = await page.evaluate(() => window.hemiVoice.getProviderImportState());
        if (result.state?.phase === 'failed') throw new Error('New API start failed: ' + JSON.stringify(result.state.error));
        return result.state?.phase === 'login';
      }, 'New API login phase');
      await wait(async () => {
        return app.evaluate(async ({ webContents }, { origin, user }) => {
          const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(origin));
          if (!contents) return false;
          return contents.executeJavaScript(`(() => { if(document.body.dataset.booted==='1')return true;const form=document.querySelector('#login-form');if(!form)return false;document.querySelector('#username').value=${JSON.stringify(user.username)};document.querySelector('#password').value=${JSON.stringify(user.password)};form.requestSubmit();return false;})()`);
        }, { origin: newapi.origin, user: TEST_USER });
      }, 'New API browser login').catch(async error => {
        console.error('New API fixture diagnostic', await page.evaluate(() => window.hemiVoice.getProviderImportState()), await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => ({ type: contents.getType(), url: contents.getURL(), title: contents.getTitle() }))));
        throw error;
      });
      const selected = await page.evaluate(async () => {
        const current = (await window.hemiVoice.getProviderImportState()).state;
        const checked = await window.hemiVoice.checkProviderImportLogin({ operationId: current.operationId, revision: current.revision });
        if (!checked.ok) throw new Error(JSON.stringify(checked.state.error));
        return window.hemiVoice.setProviderImportSelection({ operationId: current.operationId, revision: checked.state.revision,
          selection: { group: 'default', models: [{ modelName: 'mock-gpt-5.2', api: 'openai-completions' }, { modelName: 'mock-claude-opus-4.6', api: 'anthropic-messages' }] } });
      });
      await page.evaluate(state => window.hemiVoice.submitProviderImport({ operationId: state.operationId, revision: state.revision, planHash: state.preview.planHash }), selected.state);
      await wait(async () => {
        const result = await page.evaluate(() => window.hemiVoice.getProviderImportState());
        if (result.state?.phase === 'failed') throw new Error('New API import failed: ' + JSON.stringify(result.state.error));
        return result.state?.phase === 'success';
      }, 'New API commit');
      await page.getByRole('button', { name: '完成', exact: true }).click();
    };
    await page.getByRole('button', { name: '模型', exact: true }).click();
    assert.deepEqual(await page.locator('.h-bot-model-settings section[aria-label] > .h37-section-head h3').allTextContents(), ['订阅', 'New API', 'API 配置', '从本机同步的模型']);
    await page.getByRole('button', { name: '添加供应商', exact: true }).first().click();
    await page.getByRole('radio', { name: /^New API/ }).click();
    await importSite();
    const remoteNewApi = (await state()).cache.models.filter(item => item.configuration === 'newapi');
    assert.equal(remoteNewApi.length, 2);
    assert.equal((await page.evaluate(() => window.hemiVoice.listModelProfiles())).providers.length, 0);
    assert.doesNotMatch(await fs.readFile(path.join(data, 'state.json'), 'utf8'), /sk-mock-\d+secret/);
    note(mode + ': Bot New API imports both protocols directly to the server, encrypts their keys and leaves local profiles empty');
    for (const width of [1440, 768, 375]) {
      await resize(width); await page.getByRole('button', { name: '添加供应商', exact: true }).first().click();
      const dialog = page.locator('.h37m[data-h37-model-view=add]');
      await dialog.getByRole('radio', { name: /^本机配置/ }).click();
      await page.keyboard.press('Home');
      assert.equal(await dialog.getByRole('radio', { name: /^订阅/ }).getAttribute('aria-checked'), 'true');
      await page.keyboard.press('End');
      assert.equal(await dialog.getByRole('radio', { name: /^本机配置/ }).getAttribute('aria-checked'), 'true');
      await shot('bot-add-categories-' + width);
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await dialog.getByRole('button', { name: '模型', exact: true }).click();
    }
    await resize(1440);
    await page.getByRole('combobox', { name: '设置对象', exact: true }).selectOption('local');
    await page.getByRole('button', { name: '添加供应商', exact: true }).first().click();
    assert.equal(await page.getByRole('radiogroup', { name: '模型分类', exact: true }).getByRole('radio').count(), 3);
    await page.getByRole('radio', { name: /^New API/ }).click();
    await importSite();
    const localNewApi = await page.evaluate(() => window.hemiVoice.listModelProfiles());
    assert.equal(localNewApi.providers.length, 2);
    assert.ok(localNewApi.providers.every(provider => provider.id.startsWith('mpi-')));
    const localAuth = await page.evaluate(() => window.hemiVoice.startOAuthLogin('openai'));
    await wait(async () => (await page.evaluate(() => window.hemiVoice.getOAuthLoginState()))?.prompt, 'local subscription');
    const localState = await page.evaluate(() => window.hemiVoice.getOAuthLoginState());
    const localUrl = new URL(localState.url), localCallback = new URL(localUrl.searchParams.get('redirect_uri'));
    localCallback.search = new URLSearchParams({ code: 'local-taxonomy-code', state: localUrl.searchParams.get('state'), client_id: 'ui-local-issued-client' });
    await provider.originalFetch(localCallback);
    await wait(async () => (await page.evaluate(() => window.hemiVoice.getOAuthLoginState()))?.phase === 'success', 'local subscription saved');
    await page.evaluate(({ origin, key }) => window.hemiVoice.saveModelProfile({ name: 'API 配置样例', baseUrl: origin + '/v1', apiKey: key, models: [{ model: 'mock-gpt-5.2' }] }), { origin: syncOrigin, key: `sk-${newapi.state.tokens.at(-1).key}` });
    await page.getByRole('combobox', { name: '设置对象', exact: true }).selectOption('bot');
    await page.getByRole('combobox', { name: '设置对象', exact: true }).selectOption('local');
    for (const label of ['订阅', 'New API', 'API 配置']) {
      const group = page.getByRole('region', { name: label, exact: true });
      await group.locator('.h37m-provider-row').first().waitFor();
    }
    for (const width of [1440, 768, 375]) { await resize(width); await shot('local-model-categories-' + width); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); }
    await resize(1440);
    await page.getByRole('combobox', { name: '设置对象', exact: true }).selectOption('bot');
    const botBeforeSync = (await state()).cache.models;
    const localBeforeAuthorization = await page.evaluate(() => window.hemiVoice.listModelProfiles());
    const routesBeforeAuthorization = (await state()).cache.roleModels;
    await page.getByRole('button', { name: '从本机同步', exact: true }).click();
    const diff = page.getByRole('dialog', { name: '从本机同步', exact: true });
    await diff.getByRole('button', { name: '为 Bot 授权', exact: true }).waitFor();
    assert.equal(await diff.getByText('路由差异', { exact: true }).count(), 0);
    for (const width of [1440, 768, 375]) {
      await resize(width); await shot('sync-subscription-' + width);
      assert.ok(await diff.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    }
    await resize(1440);
    await diff.getByRole('button', { name: '为 Bot 授权', exact: true }).click();
    await diff.waitFor({ state: 'hidden' });
    await page.getByRole('dialog', { name: '为 Bot 登录 ChatGPT', exact: true }).waitFor();
    await wait(async () => (await command('oauth.state'))?.prompt?.type === 'manual_code', 'subscription synchronization authorization');
    const syncAuthorization = new URL((await command('oauth.state')).url);
    const syncCallback = new URL(syncAuthorization.searchParams.get('redirect_uri'));
    syncCallback.search = new URLSearchParams({ code: 'subscription-sync-code', state: syncAuthorization.searchParams.get('state'), client_id: 'ui-independent-sync-client' });
    await provider.originalFetch(syncCallback);
    await wait(async () => (await command('oauth.state'))?.phase === 'success', 'independent subscription synchronization');
    await page.locator('.h-oauth-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.hemiVoice.listModelProfiles()), localBeforeAuthorization);
    assert.deepEqual((await state()).cache.roleModels, routesBeforeAuthorization);
    assert.ok((await state()).cache.models.find(item => item.oauthProvider === 'openai').oauthConnected);
    note(mode + ': subscription sync starts independent Bot authorization, preserves local login and leaves Bot routing unchanged');
    await page.getByRole('button', { name: '从本机同步', exact: true }).click();
    const row = diff.getByRole('checkbox', { name: /同步 API 配置样例/ });
    await row.check(); await diff.getByRole('button', { name: '同步所选（1）', exact: true }).click();
    await diff.waitFor({ state: 'hidden' });
    assert.equal((await state()).cache.models.length, botBeforeSync.length + 1);
    assert.ok(await page.getByRole('region', { name: '从本机同步的模型', exact: true }).getByText('API 配置样例', { exact: true }).isVisible());
    note(mode + ': local lists group all three connection types; Bot lists add local configuration and synchronize only the selected model');
    const serialized = JSON.stringify({ state: await state(), diagnostics: await command('diagnostics') });
    assert.doesNotMatch(serialized, /openai-test-access|test-refresh-rotated/);
    await app.close(); app = null;
    // Restore the encrypted server credential solely for disconnected execution.
    await call('oauth.import', { provider: 'openai', credential: { type: 'oauth', access: 'openai-test-access', refresh: 'test-refresh-rotated', expires: Date.now() + 600000, clientId: 'ui-bot-issued-client' } });
    const session = await call('session.create');
    await call('flow.command', { id: session.id, command: { type: 'send', input: { inputId: 'desktop-closed', text: 'Reply after desktop closes' } } });
    await wait(async () => { const detail = await call('session.open', { id: session.id }); return !detail.flow.activeRunId && JSON.stringify(detail.flow.timeline).includes('OAuth OK'); }, 'disconnected inference');
    assert.doesNotMatch(await fs.readFile(path.join(data, 'oauth-credentials.json'), 'utf8'), /openai-test-access|test-refresh-rotated/);
    await stopHost();
    if (hostErrors) errors.push(mode + ' Host: ' + hostErrors);
    note(mode + ': the actual Bot completes inference after Electron closes; stored account credentials are encrypted');
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error.stack; console.error(error);
  if (livePage && !livePage.isClosed()) {
    console.error('Fixture nav diagnostic', await livePage.locator('.h24-navrail button').evaluateAll(nodes => nodes.map(node => node.outerHTML)));
    console.error('Fixture UI diagnostic', await livePage.locator('body').innerText().catch(() => ''), await livePage.evaluate(() => window.hemiVoice.bot.getState()).then(state => ({error:state.error,candidate:state.candidate})).catch(() => null));
    await livePage.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  }
}
finally {
  await app?.close(); await stopHost(); await vite?.close(); await provider.close(); newapi.server.closeAllConnections(); await newapi.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ checks, screenshots, errors, failure: failure ?? null }, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
