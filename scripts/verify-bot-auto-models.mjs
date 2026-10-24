// Isolated Electron -> real IPC/SSH runner -> local CLI/socket Host -> real SDK.
// Only SSH's Linux/systemd boundary and the model HTTP endpoint are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { createServer } from 'vite';
const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '..');
const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
// macOS Unix socket paths must stay below 104 bytes, including control.sock.
const root = await fs.mkdtemp('/tmp/hemi-bot-models-');
const evidence = path.join(repo, '.visual/workflow/bot-routing/e2e');
await fs.mkdir(evidence, { recursive: true });
const checks = [], screenshots = [], errors = [], requests = [];
const secret = 'BOT-MANUAL-FIXTURE-KEY';
const server = http.createServer(async (request, response) => {
  requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
  if (request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (body.model === 'unavailable') { response.writeHead(401); return response.end('fixture rejection ' + secret); }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }) + '\n\n');
  response.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const address = (os.networkInterfaces().en0 ?? Object.values(os.networkInterfaces()).flat()).find(item => item?.family === 'IPv4' && !item.internal)?.address;
assert.ok(address, 'a local LAN address is needed to exercise the import loopback guard');
const baseUrl = `http://${address}:${server.address().port}/v1`;
let app, host, vite, failure = null;
const wait = async (read, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('Timed out: ' + label);
};
const note = name => { checks.push(name); console.log('PASS', name); };
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const child = host;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  host = null;
}
try {
  vite = await createServer({ configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  for (const mode of process.argv.includes('--built-only') ? ['built'] : ['dev', 'built']) {
    const work = path.join(root, mode), home = path.join(work, 'home'), profile = path.join(work, 'profile');
    const data = path.join(home, '.local/share/hemi-bot/data');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(profile, { recursive: true });
    const cli = path.join(repo, 'src/main/bot/cli.mjs');
    const env = { ...process.env, HOME: home, HEMI_BOT_DATA_DIR: data, HEMI_BOT_ISOLATED_TEST: '1', HEMI_USER_DATA_DIR: path.join(work, 'host-profile') };
    for (const name of Object.keys(env)) if (name.startsWith('HEMI_LLM_')) delete env[name];
    host = spawn(process.execPath, [cli, 'serve'], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let hostErrors = '';
    host.stderr.on('data', chunk => { hostErrors += chunk; });
    await wait(() => {
      if (host.exitCode !== null) throw new Error('Host failed: ' + hostErrors);
      return fs.access(path.join(data, 'control.sock')).then(() => true, () => false);
    }, 'Host socket');
    const wrapper = path.join(work, 'ssh'), downFlag = path.join(work, 'network-down'), slowFlag = path.join(work, 'slow-rpc');
    await fs.writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {existsSync} from 'node:fs';\nconst command=process.argv.at(-1);\nif(process.argv.includes('-O'))process.exit(0);\nif(existsSync(${JSON.stringify(downFlag)}))process.exit(255);if(existsSync(${JSON.stringify(slowFlag)})&&!command.endsWith(' watch'))await new Promise(resolve=>setTimeout(resolve,800));if(command.includes('emit runtimeNeeded')){for(const [key,value] of Object.entries(${JSON.stringify({ home, nodeBin: process.execPath, node: process.version, arch: process.arch, runtimeNeeded: '0', existing: '1' })}))console.log('__HB_'+key+'='+Buffer.from(value).toString('base64'));}else if(command.includes('cli.mjs')){const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HOME:${JSON.stringify(home)},HEMI_BOT_DATA_DIR:${JSON.stringify(data)}},stdio:'inherit'});child.on('exit',code=>process.exit(code??1));}else{console.error('Unexpected fixture SSH command');process.exit(1);}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
    const appEnv = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: wrapper, HEMI_TEST_MIC_GRANT: '1' };
    for (const name of Object.keys(appEnv)) if (name.startsWith('HEMI_LLM_')) delete appEnv[name];
    if (mode === 'dev') appEnv.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0];
    else delete appEnv.VITE_DEV_SERVER_URL;
    app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env: appEnv });
    let page;
    await wait(() => { page = app.windows().find(value => /^(http|file):/.test(value.url()) && !new URL(value.url()).searchParams.has('mode')); return !!page; }, 'main window');
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(mode + ': ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(mode + ' console: ' + message.text()); });
    const state = () => page.evaluate(() => window.hemiVoice.bot.getState());
    const local = () => page.evaluate(() => window.hemiVoice.listModelProfiles());
    async function resize(width) {
      if (await page.locator('.h37-model-menu').isVisible()) {
        await page.keyboard.press('Escape');
        await page.locator('.h37-model-menu').waitFor({ state: 'hidden' });
      }
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find(win => /^(http|file):/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('mode'));
        win.setMinimumSize(1, 1); win.setContentSize(width, 900);
      }, width);
      await page.waitForFunction(width => innerWidth === width, width);
      // Native resize delivery and the menu exit animation settle independently.
      await page.waitForTimeout(200);
    }
    async function shot(label) {
      const file = `${mode}-${label}.png`;
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-h37m-vt'));
      await page.screenshot({ path: path.join(evidence, file), scale: 'css', animations: 'disabled' }); screenshots.push(file);
    }
    const seed = await page.evaluate(async baseUrl => {
      const result = await window.hemiVoice.saveModelProfile({ name: '本机模型', baseUrl, apiKey: 'LOCAL-FIRST-KEY', models: [{ model: 'first-model' }, { model: 'second-model' }, { model: 'unused-model' }] });
      await window.hemiVoice.saveModelProfile({ name: '仅本机服务', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'LOCAL-LOOPBACK-KEY', models: [{ model: 'local-only' }] });
      await window.hemiVoice.saveRoleModel({ main: result.modelKeys[0] });
      await window.hemiVoice.saveRoleModel({ explorer: result.modelKeys[1] });
      await window.hemiVoice.saveRoleModel({ fallback: result.modelKeys[2] });
      return result;
    }, baseUrl);
    const keys = seed.modelKeys;
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.getByRole('button', { name: '创建连接', exact: true }).click();
    await page.getByRole('textbox', { name: 'SSH 地址', exact: true }).fill('fixture-bot');
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    const setup = page.getByRole('dialog', { name: '配置云端 Bot', exact: true });
    await setup.getByRole('tab', { name: '本机模型', exact: true }).waitFor();
    assert.equal(await setup.getByRole('tab', { name: '本机模型', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await setup.getByRole('tab', { name: '从本机导入', exact: true }).count(), 0);
    assert.equal(await setup.getByRole('listitem').count(), 4);
    await setup.getByText('本机地址不可用', { exact: true }).waitFor();
    await shot('setup-local');
    await setup.getByRole('button', { name: '初始化并开始使用', exact: true }).click();
    await setup.waitFor({ state: 'hidden' });
    await wait(async () => { const value=await state(); return value.online && value.cache?.details[value.cache.selectedId]; }, 'initialized cloud conversation');
    let bot = await state();
    assert.equal(bot.cache.models.length, 3);
    assert.equal(bot.cache.details[bot.cache.selectedId].modelKey, 'auto');
    assert.deepEqual(bot.cache.roleModels, { main: keys[0], explorer: keys[1], fallback: keys[2] });
    assert.ok(bot.cache.models.every(model => model.source === 'local'));
    assert.equal(bot.localModels.length, 4);
    note(mode + ': initialization automatically configures local models and the complete main/role/fallback policy on the actual Host');
    const openPicker = async () => {
      await page.locator('.h24-model-chip').click();
      await page.getByRole('menuitemradio', { name: /second-model/ }).waitFor();
    };
    await openPicker();
    const second = page.getByRole('menuitemradio', { name: /second-model/ });
    assert.ok(await second.isEnabled());
    assert.ok(await page.getByRole('menuitemradio', { name: /local-only/ }).isDisabled());
    for (const width of [1440, 768, 375]) {
      await resize(width);
      await openPicker();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await shot('local-picker-' + width);
      assert.ok(await second.isVisible(), 'model menu remains visible in screenshot');
    }
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await shot('local-picker-dark-preference-reduced-motion');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await resize(1440);
    await openPicker();
    await second.click();
    await wait(async () => (await state()).cache.details[(await state()).cache.selectedId]?.modelKey === keys[1], 'automatic first-use model selection');
    assert.ok(requests.some(request => request.auth === 'Bearer LOCAL-FIRST-KEY'));
    assert.equal((await state()).cache.models.length, 3);
    assert.equal(await page.getByRole('button', { name: /同步模型|选择导入模型|导入到 Bot/ }).count(), 0);
    const id = (await state()).cache.selectedId;
    await fs.writeFile(slowFlag, '');
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('Reply OK');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('正在发送…', { exact: true }).waitFor();
    assert.equal(await page.getByText('工作区目录不可用，重新选择后才能发送', { exact: true }).count(), 0);
    await wait(async () => await page.getByRole('textbox', { name: '输入消息', exact: true }).inputValue() === '', 'draft clears after receipt');
    await fs.rm(slowFlag);
    note(mode + ': delayed real SSH send shows the correct pending hint and avoids a second blocking catalog request');
    await wait(async () => {
      const detail = (await state()).cache.details[id];
      return detail?.flow.timeline.some(item => item.kind === 'assistant') && detail.flow.phase === 'idle';
    }, 'real SDK reply');
    note(mode + ': normal picker uses the initialized local model and actual cloud SDK completes a reply');
    const before = await local();
    await page.evaluate(async () => {
      const directory = await window.hemiVoice.listModelProfiles();
      const provider = directory.providers.find(provider => provider.name === '本机模型');
      await window.hemiVoice.saveModelProfile({ ...provider, apiKey: 'LOCAL-ROTATED-KEY' });
    });
    await wait(async () => {
      const current = await state();
      const cloud = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
      return Object.values(cloud.models).every(revision => cloud.versions[revision].apiKey === 'LOCAL-ROTATED-KEY') &&
        current.cache.models.every(model => model.revision === cloud.models[model.key]) && current.syncStatus?.phase === 'confirmed';
    }, 'automatic credentials rotation');
    bot = await state();
    assert.equal(bot.cache.models.length, 3);
    assert.ok(bot.cache.models.some(model => model.key === keys[2]));
    const actual = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
    for (const revision of Object.values(actual.models)) assert.equal(actual.versions[revision].apiKey, 'LOCAL-ROTATED-KEY');
    assert.ok(!JSON.stringify(bot).includes('LOCAL-ROTATED-KEY'));
    for (const name of await fs.readdir(path.join(profile, 'bot'))) {
      const file = path.join(profile, 'bot', name);
      if ((await fs.stat(file)).isFile()) assert.ok(!(await fs.readFile(file, 'utf8')).includes('LOCAL-ROTATED-KEY'));
    }
    note(mode + ': profile save updates all initialized local models automatically and exposes no keys to the renderer');
    await page.evaluate(async () => {
      const directory = await window.hemiVoice.listModelProfiles();
      const provider = directory.providers.find(provider => provider.name === '本机模型');
      await window.hemiVoice.saveModelProfile({ ...provider, apiKey: '', models: provider.models.map((model, index) => index === 1 ? { ...model, model: 'unavailable' } : model) });
    });
    await wait(async () => !!(await state()).modelConfigError, 'failed background update');
    assert.equal((await state()).cache.models.find(model => model.key === keys[1]).revision, bot.cache.models.find(model => model.key === keys[1]).revision);
    await shot('failed-update');
    await page.evaluate(async before => {
      await window.hemiVoice.saveModelProfile({ ...before.providers.find(provider => provider.name === '本机模型'), apiKey: 'LOCAL-ROTATED-KEY' });
    }, before);
    await wait(async () => !(await state()).modelConfigError && (await state()).syncStatus === null, 'corrected model recovers automatically');
    note(mode + ': actual Host rejects failed update, keeps previous revision and recovers after local correction');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const environment = page.getByRole('combobox', { name: '设置对象', exact: true });
    const side = page.locator('.h37-settings-side');
    assert.equal(await environment.inputValue(), 'bot');
    await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
    assert.deepEqual(await side.locator('.h37-settings-navitem').allTextContents(), ['通用', '模型与路由']);
    await side.getByRole('button', { name: '模型与路由', exact: true }).click();
    await page.getByRole('heading', { name: '模型', exact: true }).waitFor();
    await page.getByRole('button', { name: '在本机修改', exact: true }).waitFor();
    assert.ok(await page.getByLabel('本机配置', {exact:true}).count());
    assert.equal(await page.getByRole('button', {name:'编辑',exact:true}).count(), 0);
    await shot('settings-sources-local');
    const localBeforeCloud = await local();
    await page.getByRole('button', {name:'添加云端模型',exact:true}).click();
    let cloudDialog=page.getByRole('dialog',{name:'添加云端模型',exact:true});
    await cloudDialog.getByRole('radio').filter({hasText:'自定义'}).click();
    await cloudDialog.getByRole('textbox',{name:'名称',exact:true}).fill('云端独立模型');
    await cloudDialog.locator('input[type=password]').fill(secret);
    await cloudDialog.getByRole('textbox',{name:'接口地址',exact:true}).fill(baseUrl);
    await cloudDialog.getByRole('button',{name:'其他型号',exact:true}).click();
    const other=cloudDialog.getByRole('textbox',{name:'其他型号 ID',exact:true});
    await other.fill('cloud-model'); await other.press('Enter');
    await shot('cloud-add');
    await cloudDialog.getByRole('button',{name:'添加 1 个模型',exact:true}).click();
    await cloudDialog.waitFor({state:'hidden'});
    await wait(async()=> (await state()).cache.models.some(model=>model.model==='cloud-model' && model.source==='cloud'),'cloud addition');
    const cloudKey=(await state()).cache.models.find(model=>model.model==='cloud-model').key;
    assert.deepEqual(await local(),localBeforeCloud);
    await page.getByRole('button',{name:'编辑',exact:true}).click();
    cloudDialog=page.getByRole('dialog',{name:'编辑云端模型',exact:true});
    assert.equal(await cloudDialog.locator('input[type=password]').inputValue(),'');
    await cloudDialog.getByRole('textbox',{name:'供应商名称',exact:true}).fill('云端已修改');
    await cloudDialog.getByRole('textbox',{name:'型号 1',exact:true}).fill('cloud-model-edited');
    await shot('cloud-edit');
    await cloudDialog.getByRole('button',{name:'验证并保存',exact:true}).click();
    await cloudDialog.waitFor({state:'hidden'});
    await wait(async()=> (await state()).cache.models.some(model=>model.key===cloudKey && model.model==='cloud-model-edited'),'cloud edit with retained key');
    const privateCloud=JSON.parse(await fs.readFile(path.join(data,'state.json'),'utf8'));
    assert.equal(privateCloud.versions[privateCloud.models[cloudKey]].apiKey,secret);
    assert.deepEqual(await local(),localBeforeCloud);
    note(mode+': cloud add/edit uses actual IPC and Host, preserves credentials and IDs, and never changes local profiles');
    for (const width of [1440,768,375]) {
      await resize(width);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await shot('settings-sources-'+width);
    }
    await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
    await shot('settings-sources-dark-preference-reduced-motion');
    await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'});
    await resize(1440);
    await page.getByRole('button',{name:'在本机修改',exact:true}).click();
    assert.equal(await environment.inputValue(),'local');
    await page.getByRole('button',{name:'添加供应商',exact:true}).waitFor();
    await shot('settings-local-edit-target');
    await environment.selectOption('bot');
    await page.getByRole('heading',{name:'模型',exact:true}).waitFor();
    assert.ok(await page.getByRole('button',{name:'编辑',exact:true}).isVisible());
    note(mode+': source icons, read-only local configuration and local edit navigation work at 375/768/1440 in the renderer');
    await app.close(); app = null; await stopHost();
    if (hostErrors) errors.push(mode + ' Host: ' + hostErrors);
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
} catch (error) {
  failure = error.message;
  if (app) {
    const page = app.windows().find(page => /^(http|file):/.test(page.url()) && !new URL(page.url()).searchParams.has('mode'));
    if (page) { await fs.writeFile(path.join(evidence,'failure-state.json'), JSON.stringify(await page.evaluate(()=>window.hemiVoice.bot.getState()),null,2)); await page.screenshot({path:path.join(evidence,'failure.png'),animations:'disabled'}); }
  }
  throw error;
} finally {
  await app?.close(); await stopHost(); await vite?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ date: new Date().toISOString(), commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), environment: process.platform + '/' + process.arch + '/' + process.version, failure, checks, errors, screenshots, gap: 'Local CLI/socket Host, real SDK and fixture model HTTP on macOS; SSH/Linux systemd and real providers not exercised', root }, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}
