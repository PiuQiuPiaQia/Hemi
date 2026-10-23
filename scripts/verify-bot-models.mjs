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
const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '..');
const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
// macOS Unix socket paths must stay below 104 bytes, including control.sock.
const root = await fs.mkdtemp('/tmp/hemi-bot-models-');
const evidence = path.join(repo, '.visual/workflow/bot-models');
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
let app, host;
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
  for (const mode of ['dev', 'built']) {
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
    const wrapper = path.join(work, 'ssh');
    await fs.writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nconst command=process.argv.at(-1);\nif(process.argv.includes('-O'))process.exit(0);\nif(command.includes('emit runtimeNeeded')){for(const [key,value] of Object.entries(${JSON.stringify({ home, nodeBin: process.execPath, node: process.version, arch: process.arch, runtimeNeeded: '0', existing: '1' })}))console.log('__HB_'+key+'='+Buffer.from(value).toString('base64'));}else if(command.includes('cli.mjs')){const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'rpc'],{env:{...process.env,HOME:${JSON.stringify(home)},HEMI_BOT_DATA_DIR:${JSON.stringify(data)}},stdio:'inherit'});child.on('exit',code=>process.exit(code??1));}else{console.error('Unexpected fixture SSH command');process.exit(1);}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
    const appEnv = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: wrapper, HEMI_TEST_MIC_GRANT: '1' };
    for (const name of Object.keys(appEnv)) if (name.startsWith('HEMI_LLM_')) delete appEnv[name];
    if (mode === 'dev') appEnv.VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5276';
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
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find(win => /^(http|file):/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('mode'));
        win.setMinimumSize(1, 1); win.setContentSize(width, 900);
      }, width);
      await page.waitForFunction(width => innerWidth === width, width);
    }
    async function shot(label) {
      const file = `${mode}-${label}.png`;
      await page.screenshot({ path: path.join(evidence, file), scale: 'css' }); screenshots.push(file);
    }
    async function fill(dialog, model, name = 'Bot 专用网关') {
      await dialog.getByRole('radio').filter({ hasText: '自定义' }).click();
      await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name);
      await dialog.locator('input[type=password]').fill(secret);
      await dialog.getByRole('textbox', { name: '接口地址', exact: true }).fill(baseUrl);
      await dialog.getByRole('button', { name: '其他型号', exact: true }).click();
      const other = dialog.getByRole('textbox', { name: '其他型号 ID', exact: true });
      await other.fill(model); await other.press('Enter');
    }
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await resize(1440);
    const before = await local();
    await page.getByRole('button', { name: '创建连接', exact: true }).click();
    await page.getByRole('textbox', { name: 'SSH 地址', exact: true }).fill('fixture-bot');
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '配置云端 Bot', exact: true });
    await dialog.getByRole('tab', { name: '手动添加', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('tab', { name: '手动添加', exact: true }).getAttribute('aria-selected'), 'true');
    await fill(dialog, 'setup-' + mode);
    await dialog.getByRole('tab', { name: '从本机导入', exact: true }).click();
    await dialog.getByRole('tab', { name: '从本机导入', exact: true }).press('ArrowLeft');
    assert.equal(await dialog.locator('input[type=password]').inputValue(), secret);
    await shot('setup-manual');
    await dialog.getByRole('button', { name: '初始化并开始使用', exact: true }).click();
    await wait(async () => (await state()).online && (await state()).cache?.models.some(model => model.model === 'setup-' + mode), 'manual initialization');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await local(), before);
    note(mode + ': manual initialization without changing local model profiles; tabs retain draft and support arrow keys');
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '添加模型', exact: true });
    await fill(dialog, 'manual-' + mode);
    await dialog.getByText('连接成功', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '从服务拉取', exact: true }).click();
    await dialog.getByRole('button', { name: 'remote-model', exact: true }).waitFor();
    for (const width of [1440, 768, 375]) {
      await resize(width);
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), mode + ' dialog overflow at ' + width);
      await shot('manual-' + width);
      await dialog.getByRole('tab', { name: '从本机导入', exact: true }).click();
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await shot('import-' + width);
      await dialog.getByRole('tab', { name: '手动添加', exact: true }).click();
    }
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await shot('manual-dark-preference-reduced-motion');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await resize(1440);
    await dialog.getByRole('button', { name: '添加 1 个模型', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.ok((await state()).cache.models.some(model => model.model === 'manual-' + mode));
    assert.deepEqual(await local(), before);
    const toast = page.locator('.h37-toast-card').filter({ hasText: '模型已保存' });
    await toast.waitFor();
    assert.equal(await page.getByText('模型已同步。', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '知道了', exact: true }).count(), 0);
    await shot('model-saved-toast');
    await toast.waitFor({ state: 'hidden', timeout: 5000 });
    await wait(async () => (await state()).syncStatus === null, 'success receipt dismissed');
    note(mode + ': shared compact toast replaces the success banner, expires automatically and clears its receipt');
    note(mode + ': real cloud SDK probe, remote list, manual save, responsive 375/768/1440 and reduced motion');
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '添加模型', exact: true });
    await fill(dialog, 'unavailable');
    await dialog.getByRole('button', { name: '添加 1 个模型', exact: true }).click();
    await dialog.getByText('服务器未能验证模型连接，原配置保留。', { exact: true }).waitFor();
    assert.ok(!(await dialog.innerText()).includes(secret));
    assert.ok(!(await state()).cache.models.some(model => model.model === 'unavailable'));
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.locator('.h-bot-banner').filter({ hasText: '部分模型未通过云端验证' }).waitFor();
    await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ name: '本机导入夹具', baseUrl, apiKey: 'LOCAL-IMPORT-FIXTURE-KEY', models: Array.from({ length: 20 }, (_, index) => ({ model: index === 0 ? 'imported-model' : 'import-fixture-' + index, thinkingLevel: 'off' })) }), baseUrl);
    const localAfter = await local();
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '添加模型', exact: true });
    await dialog.getByRole('tab', { name: '从本机导入', exact: true }).click();
    await dialog.getByRole('button', { name: '选择导入模型', exact: true }).click();
    const search = dialog.getByRole('textbox', { name: '搜索本机模型', exact: true });
    await search.focus();
    const focus = await search.evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow }));
    assert.deepEqual(focus, { outline: 'none', shadow: 'none' });
    for (const width of [1440, 768, 375]) {
      await resize(width);
      const list = await dialog.locator('.h-bot-models').evaluate(node => ({ height: node.clientHeight, scroll: node.scrollHeight }));
      assert.ok(list.height > 350 && list.height <= 421 && list.scroll > list.height);
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await shot('import-expanded-' + width);
    }
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => /^(http|file):/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('mode'));
      win.setContentSize(1440, 720);
    });
    await page.waitForFunction(() => innerHeight === 720);
    const shortList = await dialog.locator('.h-bot-models').evaluate(node => node.clientHeight);
    assert.ok(shortList > 240 && shortList <= 261);
    const footer = await dialog.getByRole('button', { name: '导入到 Bot', exact: true }).boundingBox();
    const bounds = await dialog.boundingBox();
    assert.ok(footer.y + footer.height <= bounds.y + bounds.height);
    await shot('import-expanded-short-window');
    await resize(1440);
    note(mode + ': focused search has no ring; expanded model list shows more rows and adapts to short windows');
    await dialog.getByRole('checkbox', { name: 'imported-model', exact: true }).check();
    await dialog.getByRole('button', { name: '导入到 Bot', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }).catch(async error => {
      await shot('import-error');
      error.message += '\n' + await dialog.innerText();
      throw error;
    });
    assert.ok((await state()).cache.models.some(model => model.model === 'imported-model'));
    assert.deepEqual(await local(), localAfter);
    await toast.waitFor();
    await toast.waitFor({ state: 'hidden', timeout: 5000 });
    await wait(async () => (await state()).syncStatus === null, 'import receipt dismissed');
    for (const name of await fs.readdir(path.join(profile, 'bot'))) {
      const full = path.join(profile, 'bot', name);
      if (!(await fs.stat(full)).isFile()) continue;
      const content = await fs.readFile(full, 'utf8');
      assert.ok(!content.includes(secret) && !content.includes('LOCAL-IMPORT-FIXTURE-KEY'), name);
    }
    note(mode + ': rejected credentials stay safe; existing local models import successfully without changing local profiles');
    await app.close(); app = null; await stopHost();
    if (hostErrors) errors.push(mode + ' Host: ' + hostErrors);
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(requests.some(request => request.method === 'GET' && request.auth === 'Bearer ' + secret));
} finally {
  await app?.close(); await stopHost();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ date: new Date().toISOString(), commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), environment: process.platform + '/' + process.arch + '/' + process.version, checks, errors, screenshots, gap: 'Local CLI/socket Host and a fixture SSH boundary on macOS; no Linux systemd or real provider credentials', root }, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}
