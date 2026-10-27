// Actual Electron renderer/IPC/Host. SSH is a local socket adapter; no user data or model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-page-lifecycle-'));
const output = path.join(repo, '.visual/workflow/desktop-duplicate-screen');
await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'cloud');
const {serve} = await import('../src/main/bot/cli.mjs');
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`,
  command: 'node scripts/verify-bot-page-lifecycle.mjs', date: new Date().toISOString(), sources: {}, results: []};
for (const name of ['src/renderer/src/windows/bot/page.tsx', 'scripts/verify-bot-page-lifecycle.mjs'])
  report.sources[name] = createHash('sha256').update(await fs.readFile(path.join(repo, name))).digest('hex');
const wait = async (read, label) => {
  const deadline = Date.now() + 15000;
  while (!await read()) {assert.ok(Date.now() < deadline, 'Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 25));}
};
let service, vite, app;
try {
  service = await serve({defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
    async run(spec, apply) {apply({type: 'part-appended', runId: spec.runId, generation: spec.generation,
      part: {partId: 'answer', kind: 'text', content: Array.from({length: 24}, (_, index) => `### 段落 ${index}\n\n这是用于检查长历史页面卸载的合成内容。`).join('\n\n')}}); return {};},
    async stop() {}, async close() {},
  })});
  const hello = await service.host.request('handshake');
  const call = (method, params = {}) => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params});
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Synthetic', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const session = await call('session.create');
  await call('flow.command', {id: session.id, command: {type: 'send', input: {inputId: 'lifecycle-input', text: '合成长历史测试'}}});
  await wait(async () => (await call('flow.snapshot', {id: session.id})).phase === 'idle', 'seed completed');
  const ssh = path.join(root, 'ssh.mjs');
  await fs.writeFile(ssh, `#!${process.execPath}
import {spawn} from 'node:child_process';
if(process.argv.includes('-O'))process.exit(0);
const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await vite.listen();
  for (const mode of process.env.HEMI_VERIFY_MODE ? [process.env.HEMI_VERIFY_MODE] : ['dev', 'built']) {
    const profile = path.join(root, mode);
    await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-page-lifecycle', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_BOT_AUTO_UPDATE: '0', HEMI_TEST_MIC_GRANT: '1'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const installed = process.env.HEMI_VERIFY_INSTALLED === '1';
    const result = {mode, installed, counts: [], errors: []}; report.results.push(result);
    app = await _electron.launch({executablePath: installed ? '/Applications/Hemi.app/Contents/MacOS/Hemi' : electronPath, args: installed ? [] : ['.'], cwd: repo, env});
    let page;
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {if (/Encountered two children with the same key|MaxListenersExceededWarning/.test(message.text())) result.errors.push(message.text());});
    const count = async label => {
      const facts = await page.evaluate(() => ({shells: document.querySelectorAll('main.voice-shell').length,
        inputs: document.querySelectorAll('textarea.text-composer-input').length,
        height: document.documentElement.scrollHeight, viewport: innerHeight}));
      result.counts.push({label, ...facts});
      assert.equal(facts.shells, 1, label + ': only one application page may remain mounted');
      assert.equal(facts.inputs, 1, label + ': old composers must be removed');
      assert.ok(facts.height <= facts.viewport + 1, label + ': application must not stack vertically');
    };
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await page.evaluate(() => window.hemiVoice.bot.getState())).online, 'Bot connected');
      await page.locator('textarea.text-composer-input').waitFor();
      await count('initial Bot');
      for (let index = 0; index < 3; index++) {
        await page.getByRole('button', {name: '连接新设备', exact: true}).click();
        const dialog = page.getByRole('dialog', {name: '连接新设备', exact: true});
        await dialog.waitFor();
        for (let read = 0; read < 6; read++) await page.evaluate(() => window.hemiVoice.bot.command('pairing.status'));
        await dialog.getByRole('button', {name: '关闭弹窗', exact: true}).click();
        await dialog.waitFor({state: 'hidden'});
        await count('pairing modal ' + index);
      }
      for (let index = 0; index < 12; index++) {
        await call('session.rename', {id: session.id, title: '生命周期 ' + index});
        await page.locator('.h24-sidebar-open').filter({hasText: '生命周期 ' + index}).waitFor();
        await count('catalog update ' + index);
      }
      for (let index = 0; index < 6; index++) {
        await page.getByRole('button', {name: '对话', exact: true}).click();
        await page.getByRole('button', {name: 'Bot', exact: true}).waitFor();
        await count('local ' + index);
        await page.getByRole('button', {name: 'Bot', exact: true}).click();
        await page.locator('.h24-sidebar-open').filter({hasText: '生命周期 11'}).waitFor();
        await count('Bot ' + index);
      }
      for (const width of [375, 768, 1440]) {
        await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(300, 400); win.setContentSize(width, 900);}, width);
        await wait(async () => await page.evaluate(() => innerWidth) === width, 'resize');
        await page.waitForTimeout(300); // Let the responsive drawer finish its resize transition.
        await count('viewport ' + width);
        await page.screenshot({path: path.join(output, `${mode}-lifecycle-${width}.png`), animations: 'disabled'});
      }
      assert.deepEqual(result.errors, []);
      console.log('PASS', mode, result.counts.length, 'page transitions retain one page and composer');
    } catch (error) {
      result.error = error.stack;
      await page.screenshot({path: path.join(output, mode + '-lifecycle-failure.png')});
      throw error;
    } finally {await app.close(); app = null;}
  }
} finally {
  await app?.close().catch(() => {});
  await vite?.close(); await service?.close();
  await fs.writeFile(path.join(output, 'lifecycle-report.json'), JSON.stringify(report, null, 2));
  await fs.rm(root, {recursive: true, force: true});
}
