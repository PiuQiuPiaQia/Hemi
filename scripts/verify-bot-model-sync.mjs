// Isolated Electron -> real IPC/SSH runner -> local CLI/socket Host -> real SDK.
// Only SSH's Linux/systemd boundary and the model HTTP endpoint are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electronPath from 'electron';
import { createServer } from 'vite';
const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '..');
import { _electron } from 'playwright-core';
// macOS Unix socket paths must stay below 104 bytes, including control.sock.
const root = await fs.mkdtemp('/tmp/hemi-bot-models-');
const routingOnly = process.argv.includes('--routing-only');
const evidence = path.join(repo, routingOnly ? '.visual/workflow/bot-routing/e2e' : '.visual/workflow/bot-model-diff/e2e');
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
    await fs.writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {existsSync} from 'node:fs';\nconst command=process.argv.at(-1);\nif(process.argv.includes('-O'))process.exit(0);\nif(existsSync(${JSON.stringify(downFlag)}))process.exit(255);if(existsSync(${JSON.stringify(slowFlag)})&&!command.endsWith(' watch'))await new Promise(resolve=>setTimeout(resolve,800));if(command==='uname -s'){console.log('Linux');process.exit(0);}if(command.includes('emit runtimeNeeded')){for(const [key,value] of Object.entries(${JSON.stringify({ home, nodeBin: process.execPath, node: process.version, arch: process.arch, runtimeNeeded: '0', existing: '1' })}))console.log('__HB_'+key+'='+Buffer.from(value).toString('base64'));}else if(command.includes('cli.mjs')){const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HOME:${JSON.stringify(home)},HEMI_BOT_DATA_DIR:${JSON.stringify(data)}},stdio:'inherit'});child.on('exit',code=>process.exit(code??1));}else{console.error('Unexpected fixture SSH command');process.exit(1);}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
    const appEnv = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: wrapper, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0' };
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
    async function resize(width, height = 900) {
      if (await page.locator('.h37-model-menu').isVisible()) {
        await page.keyboard.press('Escape');
        await page.locator('.h37-model-menu').waitFor({ state: 'hidden' });
      }
      await app.evaluate(({ BrowserWindow }, { width, height }) => {
        const win = BrowserWindow.getAllWindows().find(win => /^(http|file):/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('mode'));
        win.setMinimumSize(1, 1); win.setContentSize(width, height);
      }, { width, height });
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
    await setup.getByRole('radio', { name: /^本机配置/ }).click();
    assert.equal(await setup.getByRole('radio', { name: /^本机配置/ }).getAttribute('aria-checked'), 'true');
    assert.equal(await setup.getByRole('tab', { name: '从本机导入', exact: true }).count(), 0);
    await wait(async () => await setup.getByRole('listitem').count() === 4, 'local initialization choices');
    await setup.getByText('本机地址不可用', { exact: true }).waitFor();
    await shot('setup-local');
    await setup.getByRole('button', { name: '初始化并开始使用', exact: true }).click();
    await setup.waitFor({ state: 'hidden' });
    await wait(async () => { const value=await state(); return value.online && value.cache?.details[value.cache.selectedId]; }, 'initialized cloud conversation');
    let bot = await state();
    assert.equal(bot.cache.models.length, 3);
    assert.equal(bot.cache.details[bot.cache.selectedId].modelKey, keys[0]);
    assert.deepEqual(bot.cache.roleModels, {});
    assert.ok(bot.cache.models.every(model => model.source === 'local'));
    assert.equal((await page.evaluate(() => window.hemiVoice.bot.models())).length, 4);
    note(mode + ': initialization copies local models while leaving automatic routing unconfigured on the actual Host');
    if (routingOnly) {
      const localBefore = await local();
      await page.locator('.h24-model-chip').click();
      await page.getByRole('button', { name: '配置模型路由', exact: true }).click();
      await page.getByRole('heading', { name: '模型与路由', exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: '设置对象', exact: true }).inputValue(), 'bot');
      await page.getByRole('button', { name: '配置…', exact: true }).click();
      let routing = page.getByRole('dialog', { name: '模型路由', exact: true });
      await wait(async () => await routing.locator('select:enabled').count() === 6, 'all routing slots loaded');
      // A remote save stays pending across multiple SSH round trips. Other
      // slots must wait, otherwise Desktop rejects the next patch as busy.
      await fs.writeFile(slowFlag, '');
      await routing.getByRole('combobox', { name: '主 agent', exact: true }).selectOption(keys[0]);
      await wait(async () => (await state()).syncStatus?.phase === 'sending', 'routing save in flight');
      assert.equal(await routing.locator('select:enabled').count(), 0, 'all slots wait for the pending server save');
      await fs.rm(slowFlag);
      await wait(async () => (await state()).cache.roleModels.main === keys[0] && await routing.locator('select:enabled').count() === 6, 'main route saved');
      const choices = [['explorer', keys[1]], ['oracle', keys[2]], ['fixer', keys[0]], ['designer', keys[1]], ['fallback', keys[2]]];
      for (const [slot, key] of choices) {
        await routing.locator(`[data-route-slot=${slot}] select`).selectOption(key);
        await wait(async () => (await state()).cache.roleModels[slot] === key && await routing.locator('select:enabled').count() === 6, slot + ' saved');
      }
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('bot:command');
        globalThis.__routingSaveHandler = original;
        globalThis.__rejectRoutingSave = true;
        ipcMain.removeHandler('bot:command');
        ipcMain.handle('bot:command', (event, payload) => {
          if (payload.method === 'models.routing' && payload.params.roleModels.oracle && globalThis.__rejectRoutingSave) {
            globalThis.__rejectRoutingSave = false;
            return { ok: false, code: 'offline', message: '恢复连接后才能配置模型路由。' };
          }
          return original(event, payload);
        });
      });
      await routing.locator('[data-route-slot=oracle] select').selectOption(keys[1]);
      const failedSlot = routing.locator('[data-route-error=oracle]');
      await failedSlot.getByRole('button', { name: '重试', exact: true }).waitFor();
      assert.equal((await state()).cache.roleModels.oracle, keys[2], 'failed patch preserves the saved route');
      await routing.locator('[data-route-slot=designer] select').selectOption(keys[2]);
      await wait(async () => (await state()).cache.roleModels.designer === keys[2] && await routing.locator('select:enabled').count() === 6, 'another slot saved after failure');
      await failedSlot.getByRole('button', { name: '重试', exact: true }).click();
      await wait(async () => (await state()).cache.roleModels.oracle === keys[1] && await routing.locator('select:enabled').count() === 6, 'retry uses the failed slot and value');
      assert.equal(await failedSlot.count(), 0);
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('bot:command'); ipcMain.handle('bot:command', globalThis.__routingSaveHandler); });
      await routing.locator('[data-route-slot=fallback] select').selectOption('__unset__');
      await wait(async () => !(await state()).cache.roleModels.fallback && await routing.locator('select:enabled').count() === 6, 'fallback cleared');
      assert.deepEqual(await local(), localBefore);
      assert.equal(await routing.getByRole('alert').count(), 0);
      for (const width of [1440, 768, 375]) {
        await resize(width, width === 375 ? 812 : width === 768 ? 1024 : 900);
        await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
        const layout = await routing.evaluate(dialog => {
          const rect = dialog.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
        });
        assert.ok(layout.left >= 0 && layout.right <= layout.width + 1 && layout.top >= 0 && layout.bottom <= layout.height + 1 && layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
        await shot('routing-' + width);
      }
      await resize(1440);
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await shot('routing-dark-preference-reduced-motion');
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
      await routing.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '配置…', exact: true }).click();
      routing = page.getByRole('dialog', { name: '模型路由', exact: true });
      await wait(async () => await routing.locator('[data-route-slot=oracle] select').inputValue() === keys[1], 'saved slots restored after reopening');
      await routing.getByRole('button', { name: '完成', exact: true }).click();
      note(mode + ': picker targets Bot settings; all six route slots save sequentially, clear and reopen without changing local profiles');
      // Intercept only one read at IPC's external boundary. Retry uses the
      // original handler and reaches the real Host again.
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('bot:command');
        globalThis.__routingHandler = original;
        globalThis.__rejectRoutingRead = true;
        ipcMain.removeHandler('bot:command');
        ipcMain.handle('bot:command', (event, payload) => payload.method === 'models.roles' && globalThis.__rejectRoutingRead
          ? { ok: false, code: 'offline', message: '恢复连接后才能配置模型路由。' } : original(event, payload));
      });
      await page.getByRole('button', { name: '配置…', exact: true }).click();
      routing = page.getByRole('dialog', { name: '模型路由', exact: true });
      await routing.getByRole('alert').filter({ hasText: '恢复连接后才能配置模型路由' }).waitFor();
      assert.equal(await routing.locator('select:enabled').count(), 0);
      await shot('routing-load-failure');
      await app.evaluate(() => { globalThis.__rejectRoutingRead = false; });
      await routing.getByRole('button', { name: '重新读取', exact: true }).click();
      await wait(async () => await routing.locator('select:enabled').count() === 6, 'failed routing read recovered');
      assert.equal(await routing.getByRole('alert').count(), 0);
      assert.equal(await routing.locator('[data-route-slot=main] select').inputValue(), keys[0]);
      await routing.getByRole('button', { name: '完成', exact: true }).click();
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('bot:command'); ipcMain.handle('bot:command', globalThis.__routingHandler); });
      note(mode + ': routing read failure is visible and retry restores the actual saved Host configuration');
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('bot:command');
        globalThis.__holdRoutingRead = true;
        globalThis.__releaseRoutingRead = null;
        ipcMain.removeHandler('bot:command');
        ipcMain.handle('bot:command', (event, payload) => {
          if (payload.method !== 'models.roles' || !globalThis.__holdRoutingRead) return original(event, payload);
          return new Promise(resolve => { globalThis.__releaseRoutingRead = () => original(event, payload).then(resolve); });
        });
      });
      await page.clock.install();
      await page.getByRole('button', { name: '配置…', exact: true }).click();
      routing = page.getByRole('dialog', { name: '模型路由', exact: true });
      await wait(() => app.evaluate(() => !!globalThis.__releaseRoutingRead), 'held routing read');
      await routing.getByRole('status').filter({ hasText: '正在读取模型路由' }).waitFor();
      await page.clock.fastForward(20001);
      await routing.getByRole('alert').filter({ hasText: '读取模型路由超时' }).waitFor();
      await app.evaluate(() => { globalThis.__holdRoutingRead = false; });
      await routing.getByRole('button', { name: '重新读取', exact: true }).click();
      await wait(async () => await routing.locator('select:enabled').count() === 6, 'timed out routing read recovered');
      await app.evaluate(() => globalThis.__releaseRoutingRead());
      assert.equal(await routing.getByRole('alert').count(), 0);
      assert.equal(await routing.locator('[data-route-slot=oracle] select').inputValue(), keys[1]);
      await routing.getByRole('button', { name: '完成', exact: true }).click();
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('bot:command'); ipcMain.handle('bot:command', globalThis.__routingHandler); });
      note(mode + ': a stalled routing read has a deadline; retry recovers and a late reply cannot replace the recovered view');
      await app.close(); app = null; await stopHost();
      if (hostErrors) errors.push(mode + ' Host: ' + hostErrors);
      continue;
    }
    if (process.argv.includes('--layout-only')) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.h37-settings-side').getByRole('button', { name: '模型与路由', exact: true }).click();
      await page.getByRole('region', { name: '从本机同步的模型', exact: true }).locator('.h37m-provider-row').waitFor();
      for (const width of [1440, 768, 375]) {
        await resize(width);
        const controls = page.locator('.h37m-provider-actions');
        const layout = await controls.evaluate(node => {
          const [sync, add] = [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect());
          return { gap: Math.abs(sync.top - add.top) < 1 ? add.left - sync.right : add.top - sync.bottom,
            overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        assert.ok(layout.gap >= 7.5 && !layout.overflow, JSON.stringify({ width, layout }));
        await shot('button-spacing-and-source-' + width);
      }
      note(mode + ': model actions keep an 8px gap or wrap cleanly; the source group is labeled as models synchronized from this computer');
      await app.close(); app = null; await stopHost();
      if (hostErrors) errors.push(mode + ' Host: ' + hostErrors);
      continue;
    }
    const openPicker = async () => {
      await page.locator('.h24-model-chip').click();
      await page.getByRole('menuitemradio', { name: /second-model/ }).waitFor();
    };
    await openPicker();
    const second = page.getByRole('menuitemradio', { name: /second-model/ });
    assert.ok(await second.isEnabled());
    assert.equal(await page.getByRole('menuitemradio', { name: /local-only/ }).count(), 0);
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
    await wait(async () => (await state()).cache.details[(await state()).cache.selectedId]?.modelKey === keys[1], 'select saved Bot model');
    assert.ok(requests.some(request => request.auth === 'Bearer LOCAL-FIRST-KEY'));
    assert.equal((await state()).cache.models.length, 3);
    assert.equal(await page.getByRole('button', { name: /同步模型|选择导入模型|导入到 Bot/ }).count(), 0);
    const id = (await state()).cache.selectedId;
    await fs.writeFile(slowFlag, '');
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('Reply OK');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('.h24-user-bubble').filter({hasText: 'Reply OK'}).waitFor();
    assert.equal(await page.getByText('正在发送…', {exact: true}).count(), 0);
    assert.equal(await page.getByText('工作区目录不可用，重新选择后才能发送', { exact: true }).count(), 0);
    await wait(async () => await page.getByRole('textbox', { name: '输入消息', exact: true }).inputValue() === '', 'draft clears after receipt');
    await fs.rm(slowFlag);
    note(mode + ': delayed real SSH send immediately shows its input without a sending notice or a second blocking catalog request');
    await wait(async () => {
      const detail = (await state()).cache.details[id];
      return detail?.flow.timeline.some(item => item.kind === 'assistant') && detail.flow.phase === 'idle';
    }, 'real SDK reply');
    note(mode + ': normal picker uses the initialized local model and actual cloud SDK completes a reply');
    await page.evaluate(async () => {
      const directory = await window.hemiVoice.listModelProfiles();
      const provider = directory.providers.find(provider => provider.name === '本机模型');
      await window.hemiVoice.saveModelProfile({ ...provider, name: '本机改名待同步', apiKey: 'LOCAL-ROTATED-KEY' });
      await window.hemiVoice.saveRoleModel({ main: provider.models[1].modelKey });
    });
    await page.evaluate(async () => {
      await window.hemiVoice.bot.command('connection.disconnect');
      await window.hemiVoice.bot.command('connection.reconnect');
    });
    await page.waitForTimeout(1400);
    bot = await state();
    assert.ok(bot.cache.models.every(model => model.name === '本机模型'));
    assert.deepEqual(bot.cache.roleModels, {});
    const unchanged = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
    for (const revision of Object.values(unchanged.models)) assert.equal(unchanged.versions[revision].apiKey, 'LOCAL-FIRST-KEY');
    await openPicker();
    assert.equal(await page.getByText('本机改名待同步', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    note(mode + ': local credentials, provider name and routing edits remain local after reconnect and ordinary picker use');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const environment = page.getByRole('combobox', { name: '设置对象', exact: true });
    const side = page.locator('.h37-settings-side');
    assert.equal(await environment.inputValue(), 'bot');
    await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
    await side.getByRole('button', { name: '模型与路由', exact: true }).click();
    await page.getByRole('heading', { name: '模型与路由', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '在本机修改', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '从本机同步的模型', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: '云端配置', exact: true }).count(), 0);
    const sync = page.getByRole('button', { name: '从本机同步', exact: true });
    await sync.waitFor();
    await shot('settings-unified');
    const localBeforeEdit = await local();
    await page.getByRole('region', { name: '从本机同步的模型', exact: true }).locator('.h37m-provider-row').click();
    const editor = page.locator('.h37m[data-h37-model-view=provider]');
    assert.equal(await editor.locator('input[type=password]').inputValue(), '');
    const name = editor.getByRole('textbox', { name: '名称', exact: true });
    await name.fill('Bot 专用配置'); await name.press('Tab');
    await wait(async () => (await state()).cache.models.every(model => model.name === 'Bot 专用配置'), 'shared provider name saved');
    await editor.getByRole('switch', { name: 'first-model 能看图', exact: true }).click();
    await wait(async () => (await state()).cache.models.find(model => model.key === keys[0]).supportsVision, 'shared model metadata saved');
    await editor.getByRole('button', { name: '模型', exact: true }).click();
    assert.deepEqual(await local(), localBeforeEdit);
    assert.ok((await state()).cache.models.every(model => model.name === 'Bot 专用配置'));
    await page.getByRole('button', { name: '配置…', exact: true }).click();
    const routing = page.getByRole('dialog', { name: '模型路由', exact: true });
    await routing.getByRole('combobox', { name: '主 agent', exact: true }).selectOption(keys[2]);
    await wait(async () => (await state()).cache.roleModels.main === keys[2], 'shared routing saved');
    await routing.getByRole('button', { name: '完成', exact: true }).click();
    assert.equal((await state()).cache.roleModels.main, keys[2]);
    assert.deepEqual(await local(), localBeforeEdit);
    note(mode + ': imported Bot models and routing are directly editable through real IPC without changing local profiles');
    // Stall one actual IPC reply to exercise the renderer's final timeout and
    // stale-reply guard. All later requests use the original production handler.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('bot:command');
      globalThis.__modelPreviewHandler = original;
      globalThis.__holdModelPreview = true;
      globalThis.__releaseModelPreview = null;
      ipcMain.removeHandler('bot:command');
      ipcMain.handle('bot:command', (event, payload) => {
        if (payload.method !== 'models.diff' || !globalThis.__holdModelPreview) return original(event, payload);
        if (globalThis.__holdModelPreview === 'invalid') return { ok: true, result: null };
        return new Promise(resolve => { globalThis.__releaseModelPreview = resolve; });
      });
    });
    await page.clock.install();
    await sync.click();
    let diff = page.getByRole('dialog', { name: '从本机同步', exact: true });
    await wait(() => app.evaluate(() => !!globalThis.__releaseModelPreview), 'held model preview reply');
    await page.clock.fastForward(20001);
    await diff.getByRole('alert').filter({ hasText: '配置对比未能及时返回' }).waitFor();
    assert.equal(await diff.getByText('正在读取本机配置并对比…', { exact: true }).count(), 0);
    await shot('preview-timeout');
    await app.evaluate(() => { globalThis.__holdModelPreview = 'invalid'; });
    await diff.getByRole('button', { name: '重新对比', exact: true }).click();
    await diff.getByRole('alert').filter({ hasText: '未收到完整的模型对比结果' }).waitFor();
    await app.evaluate(() => { globalThis.__holdModelPreview = false; });
    await diff.getByRole('button', { name: '重新对比', exact: true }).click();
    await diff.getByRole('checkbox', { name: '同步 本机改名待同步 · first-model', exact: true }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      globalThis.__releaseModelPreview({ ok: true, result: { id: 'late-preview', changes: [] } });
      ipcMain.removeHandler('bot:command'); ipcMain.handle('bot:command', globalThis.__modelPreviewHandler);
      delete globalThis.__releaseModelPreview; delete globalThis.__modelPreviewHandler;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await diff.getByRole('checkbox', { name: '同步 本机改名待同步 · first-model', exact: true }).isVisible());
    note(mode + ': a stalled preview stops loading after its deadline; retry succeeds and a late reply cannot overwrite it');
    assert.equal(await diff.getByRole('checkbox', { checked: true }).count(), 0);
    assert.ok(await diff.getByRole('checkbox', { name: '同步 仅本机服务 · local-only', exact: true }).isDisabled());
    await shot('diff-before-selection');
    for (const width of [1440, 768, 375]) {
      await resize(width);
      assert.ok(await diff.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await shot('diff-' + width);
    }
    await resize(1440);
    await diff.getByRole('checkbox', { name: '同步 本机改名待同步 · first-model', exact: true }).check();
    await diff.getByRole('button', { name: '同步所选（1）', exact: true }).click();
    await diff.waitFor({ state: 'hidden' });
    bot = await state();
    assert.equal(bot.cache.models.find(model => model.key === keys[0]).name, '本机改名待同步');
    assert.equal(bot.cache.models.find(model => model.key === keys[1]).name, 'Bot 专用配置');
    assert.equal(bot.cache.roleModels.main, keys[2]);
    let actual = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
    assert.equal(actual.versions[actual.models[keys[0]]].apiKey, 'LOCAL-ROTATED-KEY');
    assert.equal(actual.versions[actual.models[keys[1]]].apiKey, 'LOCAL-FIRST-KEY');
    note(mode + ': preview defaults to no selection; syncing one model preserves unchecked models, credentials and routing');
    await sync.click();
    diff = page.getByRole('dialog', { name: '从本机同步', exact: true });
    await diff.getByRole('checkbox').first().waitFor();
    assert.equal(await diff.getByText('路由差异', { exact: true }).count(), 0);
    assert.equal(await diff.getByRole('checkbox', { name: '同步 主模型', exact: true }).count(), 0);
    await diff.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await state()).cache.roleModels.main, keys[2]);
    const valid = await local();
    await page.evaluate(async () => {
      const directory = await window.hemiVoice.listModelProfiles();
      const provider = directory.providers.find(provider => provider.name === '本机改名待同步');
      await window.hemiVoice.saveModelProfile({ ...provider, apiKey: '', models: provider.models.map((model, index) => index === 1 ? { ...model, model: 'unavailable' } : model) });
    });
    const beforeFailure = (await state()).cache;
    await sync.click();
    diff = page.getByRole('dialog', { name: '从本机同步', exact: true });
    await diff.getByRole('checkbox', { name: '同步 本机改名待同步 · unavailable', exact: true }).check();
    await diff.getByRole('button', { name: '同步所选（1）', exact: true }).click();
    await diff.getByRole('alert').filter({ hasText: '服务器未能验证模型连接' }).waitFor();
    assert.deepEqual((await state()).cache.models, beforeFailure.models);
    assert.deepEqual((await state()).cache.roleModels, beforeFailure.roleModels);
    await shot('failed-selected-sync');
    await page.evaluate(async valid => {
      await window.hemiVoice.saveModelProfile({ ...valid.providers.find(provider => provider.name === '本机改名待同步'), apiKey: 'LOCAL-ROTATED-KEY' });
    }, valid);
    await diff.getByRole('button', { name: '同步所选（1）', exact: true }).click();
    await diff.getByRole('alert').filter({ hasText: '本机配置已变化' }).waitFor();
    await diff.getByRole('button', { name: '重新对比', exact: true }).click();
    await diff.getByRole('checkbox', { name: '同步 本机改名待同步 · second-model', exact: true }).check();
    await diff.getByRole('checkbox', { name: '同步 本机改名待同步 · unused-model', exact: true }).check();
    await diff.getByRole('button', { name: '同步所选（2）', exact: true }).click();
    await diff.waitFor({ state: 'hidden' });
    note(mode + ': synchronization offers no routing rows; failed validation and stale-preview protection preserve the saved Bot configuration');
    const localBeforeCloud = await local();
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    const cloudDialog = page.locator('.h37m[data-h37-model-view=add]');
    await cloudDialog.getByRole('radio', { name: /^API 配置/ }).click();
    await cloudDialog.getByRole('radio').filter({ hasText: '自定义' }).click();
    await cloudDialog.getByRole('textbox', { name: '名称', exact: true }).fill('Bot 独立模型');
    await cloudDialog.locator('input[type=password]').fill(secret);
    await cloudDialog.getByRole('textbox', { name: '接口地址', exact: true }).fill(baseUrl);
    await cloudDialog.getByRole('button', { name: '其他型号', exact: true }).click();
    const other = cloudDialog.getByRole('textbox', { name: '其他型号 ID', exact: true });
    await other.fill('cloud-model'); await other.press('Enter');
    await cloudDialog.getByRole('button', { name: '添加 1 个模型', exact: true }).click();
    await cloudDialog.waitFor({ state: 'hidden' });
    const cloudKey = (await state()).cache.models.find(model => model.model === 'cloud-model').key;
    await page.getByRole('region', { name: 'API 配置', exact: true }).locator('.h37m-provider-row').click();
    const cloudEditor = page.locator('.h37m[data-h37-model-view=provider]');
    await cloudEditor.getByRole('switch', { name: 'cloud-model 能看图', exact: true }).click();
    await wait(async () => (await state()).cache.models.find(model => model.key === cloudKey).supportsVision, 'independent model metadata');
    await cloudEditor.getByRole('button', { name: '模型', exact: true }).click();
    assert.deepEqual(await local(), localBeforeCloud);
    for (const width of [1440, 768, 375]) {
      await resize(width);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await shot('settings-' + width);
    }
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await shot('settings-dark-preference-reduced-motion');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await resize(1440);
    await sync.click();
    diff = page.getByRole('dialog', { name: '从本机同步', exact: true });
    const remove = diff.getByRole('checkbox', { name: '移除 Bot 独立模型 · cloud-model', exact: true });
    await remove.waitFor();
    assert.ok(!(await remove.isChecked()));
    await diff.getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await state()).cache.models.some(model => model.key === cloudKey));
    await sync.click();
    diff = page.getByRole('dialog', { name: '从本机同步', exact: true });
    await diff.getByRole('checkbox', { name: '移除 Bot 独立模型 · cloud-model', exact: true }).check();
    await diff.getByRole('button', { name: '同步所选（1）', exact: true }).click();
    await diff.waitFor({ state: 'hidden' });
    assert.ok(!(await state()).cache.models.some(model => model.key === cloudKey));
    actual = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
    for (const revision of Object.values(actual.models)) assert.equal(actual.versions[revision].apiKey, 'LOCAL-ROTATED-KEY');
    assert.ok(!JSON.stringify(await state()).includes(secret));
    for (const name of await fs.readdir(path.join(profile, 'bot'))) {
      const file = path.join(profile, 'bot', name);
      if ((await fs.stat(file)).isFile()) assert.ok(!(await fs.readFile(file, 'utf8')).includes('LOCAL-ROTATED-KEY'));
    }
    note(mode + ': unified model editing, optional explicit deletion and responsive settings/diff dialogs pass without exposing credentials');
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
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ date: new Date().toISOString(), commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), environment: process.platform + '/' + process.arch + '/' + process.version, failure, checks, errors, screenshots, workingTree: true, command: 'node scripts/verify-bot-model-sync.mjs ' + process.argv.slice(2).join(' '), gap: 'Local CLI/socket Host, real SDK and fixture model HTTP on macOS; remote SSH/Linux systemd, mobile hardware and real providers not exercised', root }, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}
