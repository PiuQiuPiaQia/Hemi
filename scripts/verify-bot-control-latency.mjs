// Real Electron -> preload/IPC -> SSH runner -> persistent CLI -> isolated Host.
// Only Windows SSH/PowerShell startup is replaced by a local process adapter.
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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-control-ui-'));
const output = path.join(repo, '.visual/workflow/bot-control-latency');
await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'cloud');
const {serve} = await import('../src/main/bot/cli.mjs');
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, date: new Date().toISOString(), results: [], sources: {}};
for (const file of ['src/main/bot/cli.mjs', 'src/main/bot/rpc-stream.mjs', 'src/main/bot/desktop-service.mjs', 'src/main/bot/host.mjs', 'src/main/bot/transport.mjs'])
  report.sources[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
const wait = async (read, label) => {const end = Date.now() + 15000; while (!await read()) {assert.ok(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 25));}};
let service, vite, app;
try {
  service = await serve({defaultDir: path.join(root, 'workspace'), validateModel: async () => {},
    executorFactory: () => ({async run() {return {};}, async stop() {}, async close() {}})});
  const hello = await service.host.request('handshake');
  const call = (method, params = {}) => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params});
  await call('model.sync', {models: ['A', 'B'].map(name => ({modelKey: 'fixture/' + name, providerId: 'fixture', name: 'Fixture', model: 'Model ' + name,
    api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}))});
  const initial = await call('session.create');
  await call('session.rename', {id: initial.id, title: '保留会话'});
  await call('session.control', {id: initial.id, action: 'release', controlEpoch: (await call('snapshot')).sessions.find(item => item.id === initial.id).control?.epoch});
  const ssh = path.join(root, 'ssh.mjs'), launches = path.join(root, 'launches.jsonl');
  await fs.writeFile(ssh, `#!${process.execPath}
import {spawn} from 'node:child_process';import fs from 'node:fs';
if(process.argv.includes('-O'))process.exit(0);
const source=Buffer.from(process.argv.at(-1).split(' -EncodedCommand ')[1],'base64').toString('utf16le');
const mode=source.includes('" rpc-stream')?'rpc-stream':source.includes('" watch')?'watch':'rpc';
fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({mode})+'\\n');
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},mode],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    const profile = path.join(root, mode);
    await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-control', platform: 'win32', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_BOT_AUTO_UPDATE: '0', HEMI_TEST_MIC_GRANT: '1'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    let page;
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(15000);
    const result = {mode, errors: [], timings: []}; report.results.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    const state = () => page.evaluate(() => window.hemiVoice.bot.getState());
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await state()).online, 'Bot online');
      await page.locator('textarea.text-composer-input').waitFor();
      await wait(async () => await page.locator('textarea.text-composer-input').isEnabled(), 'composer ready');
      const before = await state(), ids = before.cache.sessions.map(session => session.id);
      let start = Date.now();
      await page.getByRole('button', {name: '新建对话', exact: true}).click();
      await wait(async () => (await state()).cache.sessions.some(session => !ids.includes(session.id)), 'create receipt');
      const created = (await state()).cache.sessions.find(session => !ids.includes(session.id));
      await page.locator('.h24-sidebar-item[data-current="true"]').filter({hasText: '新对话'}).waitFor();
      result.timings.push({operation: 'create', ms: Date.now() - start});
      await page.getByRole('button', {name: /^切换模型：/}).click();
      const target = created.modelKey === 'fixture/A' ? 'fixture/B' : 'fixture/A';
      start = Date.now();
      await page.getByRole('menuitemradio').filter({hasText: target.endsWith('B') ? 'Model B' : 'Model A'}).click();
      await wait(async () => (await state()).cache.details[created.id]?.modelKey === target, 'model receipt');
      await page.getByRole('button', {name: '切换模型：' + (target.endsWith('B') ? 'Model B' : 'Model A'), exact: true}).waitFor();
      result.timings.push({operation: 'model', ms: Date.now() - start});
      await page.locator('.h24-sidebar-item[data-current="true"]').click({button: 'right'});
      await page.getByRole('menuitem', {name: '删除会话', exact: true}).click();
      start = Date.now();
      await page.getByRole('menuitem', {name: '确认删除', exact: true}).click();
      await wait(async () => !(await state()).cache.sessions.some(session => session.id === created.id), 'delete receipt');
      await page.locator('.h24-sidebar-item[data-current="true"]').filter({hasText: '保留会话'}).waitFor();
      result.timings.push({operation: 'delete', ms: Date.now() - start});
      assert.equal(await page.locator('main.voice-shell').count(), 1);
      assert.equal(await page.locator('textarea.text-composer-input').count(), 1);
      await page.screenshot({path: path.join(output, mode + '-controls.png'), animations: 'disabled'});
      assert.deepEqual(result.errors, []);
      console.log('PASS', mode, JSON.stringify(result.timings));
    } catch (error) {
      result.error = error.stack;
      await page.screenshot({path: path.join(output, mode + '-failure.png')}); throw error;
    } finally {await app.close(); app = null;}
  }
  report.launches = (await fs.readFile(launches, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(report.launches.filter(item => item.mode === 'rpc-stream').length, 2, 'one control process per application instance');
  assert.equal(report.launches.filter(item => item.mode === 'rpc').length, 2, 'only bootstrap handshakes use one-shot processes');
} finally {
  await app?.close().catch(() => {}); await vite?.close(); await service?.close();
  await fs.writeFile(path.join(output, 'ui-report.json'), JSON.stringify(report, null, 2));
  await fs.rm(root, {recursive: true, force: true});
}
