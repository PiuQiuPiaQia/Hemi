// Real Electron -> preload/IPC -> local SSH adapter -> production Host/services.
// Only Windows' native desktop is a fixture here; it has a separate native verifier.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..'), root = await fs.mkdtemp('/tmp/hcaps-');
const output = path.join(repo, '.visual/workflow/bot-capabilities/ui');await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'data');
const {serve} = await import('../src/main/bot/cli.mjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII=';
const desktop = {status: async () => ({available: true}), dispose: async () => {},
  listAppWindows: async () => [{pid: 234, bundleId: 'win32:exe:c:\\fixture.exe', name: '测试应用', frontmost: true, windows: [{windowId: '567', title: '隔离的 Windows 窗口'}]}],
  windowState: async () => ({images: [{dataBase64: png, mimeType: 'image/png'}], elements: [{role: 'Text', label: 'WINDOW_CONTEXT_PROOF'}]})};
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  environment: {node: process.version, platform: process.platform + '/' + process.arch}, results: []};
let service, vite, app;
const wait = async (read, label) => {const end = Date.now() + 20000;while (!await read()) {assert.ok(Date.now() < end, 'Timed out: ' + label);await new Promise(resolve => setTimeout(resolve, 40));}};
try {
  service = await serve({defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, capabilityOptions: {platform: 'win32', desktop}});
  const hello = await service.host.request('handshake');
  const call = (method, params = {}) => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params});
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Synthetic', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'SYNTHETIC', supportsVision: true}]});
  await call('initialize.verify');const session = await call('session.create');
  const ssh = path.join(root, 'ssh.mjs');
  await fs.writeFile(ssh, `#!${process.execPath}
import {spawn} from 'node:child_process';
if(process.argv.includes('-O'))process.exit(0);const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);
const mode=command.includes('rpc-stream')?'rpc-stream':command.includes('watch')?'watch':'rpc';
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},mode],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
  const skillDir = path.join(root, 'skill');await fs.mkdir(skillDir);await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: ui-bot-proof\ndescription: Bot UI imported skill\n---\nUI_SKILL_CONTENT');
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite'), logLevel: 'error', server: {host: '127.0.0.1', port: 0}});await vite.listen();
  for (const mode of process.env.HEMI_VERIFY_MODE ? [process.env.HEMI_VERIFY_MODE] : ['dev', 'built']) {
    const profile = path.join(root, mode);await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-capabilities', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_BOT_AUTO_UPDATE: '0', HEMI_TEST_MIC_GRANT: '1'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    let page;await wait(() => {page = app.windows().find(page => /^(http|file):/.test(page.url()) && !new URL(page.url()).searchParams.has('mode'));return !!page;}, 'main window');
    const result = {mode, checks: [], screenshots: [], errors: []};report.results.push(result);
    page.setDefaultTimeout(15000);page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
    const resize = async width => {await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(300, 400);win.setContentSize(width, 900);}, width);await wait(async () => await page.evaluate(() => innerWidth) === width, 'resize');};
    const screenshot = async name => {const filename = `${mode}-${name}.png`;await page.screenshot({path: path.join(output, filename), animations: 'disabled'});result.screenshots.push(filename);};
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await page.evaluate(() => window.hemiVoice.bot.getState())).online, 'Bot connected');
      await page.locator('textarea.text-composer-input').waitFor();
      await page.getByRole('button', {name: '添加附件', exact: true}).click();await page.getByRole('menuitem', {name: /Windows 窗口/}).click();
      const picker = page.getByRole('dialog', {name: '添加资料', exact: true});await picker.getByRole('button', {name: /测试应用/}).waitFor();await screenshot('windows-picker');
      await picker.getByRole('button', {name: /测试应用/}).click();await picker.waitFor({state: 'hidden'});
      await wait(async () => (await call('session.open', {id: session.id})).draft.attachmentIds.length > 0, 'captured window attached to draft');result.checks.push('remote-window picker captures a session-bound attachment');
      await page.getByRole('button', {name: '设置', exact: true}).click();await page.getByRole('combobox', {name: '设置对象', exact: true}).selectOption('bot');
      const section = page.getByRole('region', {name: 'Bot 能力', exact: true});await section.getByRole('switch', {name: '启用 Bot 浏览器控制'}).waitFor();
      await section.getByRole('switch', {name: '启用 Bot 浏览器控制'}).click();await wait(async () => !(await call('capabilities.inspect')).browserEnabled, 'browser off');
      await section.getByRole('switch', {name: '启用 Bot 浏览器控制'}).click();await wait(async () => (await call('capabilities.inspect')).browserEnabled, 'browser on');
      await section.getByRole('textbox', {name: 'Bot Tavily API Key'}).fill('SYNTHETIC_UI_SEARCH');await section.getByRole('button', {name: '保存', exact: true}).click();
      await wait(async () => (await call('capabilities.inspect')).hasSearchKey, 'search configured');await wait(async () => await section.getByRole('textbox', {name: 'Bot Tavily API Key'}).inputValue() === '', 'saved key field cleared');result.checks.push('real capability RPC toggles browser and stores write-only search credentials');
      for (const width of [1440, 768, 375]) {await resize(width);await section.scrollIntoViewIfNeeded();await screenshot('settings-' + width);assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));}
      await resize(1440);await section.getByRole('button', {name: '管理 Bot 技能', exact: true}).click();
      const skills = page.getByRole('region', {name: 'Bot 技能中心', exact: true});
      await app.evaluate(({dialog}, skillDir) => {dialog.showOpenDialog = async () => ({canceled: false, filePaths: [skillDir]});}, skillDir);
      await skills.getByRole('button', {name: '导入本地技能', exact: true}).click();await wait(async () => (await call('skills.state')).installed.some(skill => skill.name === 'ui-bot-proof'), 'skill imported');
      const skill = (await call('skills.state')).installed.find(skill => skill.name === 'ui-bot-proof');
      await skills.getByRole('button', {name: /ui-bot-proof/}).click();await skills.getByRole('button', {name: '停用技能', exact: true}).click();
      await wait(async () => !(await call('skills.state')).installed.find(item => item.id === skill.id).enabled, 'skill disabled');
      await skills.getByRole('button', {name: '启用技能', exact: true}).click();await wait(async () => (await call('skills.state')).installed.find(item => item.id === skill.id).enabled, 'skill enabled');
      await skills.getByRole('button', {name: '查看原文', exact: true}).click();await skills.getByText('UI_SKILL_CONTENT', {exact: false}).scrollIntoViewIfNeeded();await screenshot('skill-source');
      await resize(375);await skills.getByText('UI_SKILL_CONTENT', {exact: false}).scrollIntoViewIfNeeded();await screenshot('skill-source-375');await resize(1440);
      assert.equal(await skills.getByRole('button', {name: '打开目录', exact: true}).count(), 0);result.checks.push('production import IPC uploads the chosen skill to the Bot; enable/disable and source reading work');
      await skills.getByRole('button', {name: '返回 Bot 能力', exact: true}).click();await page.emulateMedia({colorScheme: 'dark', reducedMotion: 'reduce'});await screenshot('settings-dark-preference');
      assert.deepEqual(result.errors, []);console.log('PASS', mode, result.checks.length, 'capability flows');
      await call('skills.remove', {skillId: skill.id});await call('capabilities.configure', {config: {searchApiKey: ''}});
    } catch (error) {result.error = error.stack;await screenshot('failure');throw error;}
    finally {await app.close();app = null;}
  }
} finally {
  await app?.close().catch(() => {});await vite?.close();await service?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));await fs.rm(root, {recursive: true, force: true});
}
