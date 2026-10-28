// Actual Electron/preload/IPC/transport/Host in fresh profiles. SSH latency and
// task output are synthetic; no installed profile or external model is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-task-feedback-'));
const output = path.join(repo, '.visual/workflow/bot-fixer-feedback');
await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'cloud');
const {serve} = await import('../src/main/bot/cli.mjs');
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`,
  command: 'node scripts/verify-bot-task-feedback.mjs', date: new Date().toISOString(), results: []};
const wait = async (read, label) => {
  const deadline = Date.now() + 20000;
  while (!await read()) {assert.ok(Date.now() < deadline, 'Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 40));}
};
let service, vite, app;
let currentTask, emit, finish;
try {
  service = await serve({defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
    async run(spec, apply) {
      emit = task => apply({type: 'task-updated', generation: spec.generation, task});
      currentTask = {taskId: 'fixture-child', key: 'fixture-child', conversationId: spec.conversationId,
        rootRunId: spec.runId, toolCallId: 'fixture-call', agent: 'fixer', agentTitle: '执行', taskText: '验证子任务详情',
        phase: 'running', progressText: '正在执行命令', startedAt: Date.now(),
        conversation: {revision: 1, messages: [{id: 'child-message', author: 'hemi', text: '初始进度', createdAt: Date.now(), parts: [{type: 'text', text: '初始进度'}]}]}};
      apply({type: 'part-appended', runId: spec.runId, generation: spec.generation,
        part: {partId: 'delegation', kind: 'delegation', toolCallId: 'fixture-call', taskId: currentTask.taskId, status: 'running', args: {agent: 'fixer', description: currentTask.taskText}}});
      emit(currentTask);
      await new Promise(resolve => {finish = resolve;});
      return {};
    },
    async stop() {finish?.();}, async close() {finish?.();},
  })});
  const hello = await service.host.request('handshake');
  const call = (method, params = {}, clientId = 'legacy') => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params}, {clientId});
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Synthetic', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const session = await call('session.create');
  const ssh = path.join(root, 'ssh.mjs');
  const failure = path.join(root, 'fail-ssh');
  await fs.writeFile(ssh, `#!${process.execPath}
import {spawn} from 'node:child_process';import fs from 'node:fs';
if(process.argv.includes('-O'))process.exit(0);
const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);
await new Promise(resolve=>setTimeout(resolve,900));
if(fs.existsSync(${JSON.stringify(failure)})){process.stderr.write('Synthetic connection refused');process.exit(255);}
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    const profile = path.join(root, mode);
    await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-feedback', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_BOT_AUTO_UPDATE: '0', HEMI_TEST_MIC_GRANT: '1'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = {mode, checks: [], errors: []}; report.results.push(result);
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    let page;
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => result.errors.push(error.message));
    const state = () => page.evaluate(() => window.hemiVoice.bot.getState());
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    const shot = async name => page.screenshot({path: path.join(output, `${mode}-${name}.png`), animations: 'disabled'});
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await state()).online, 'Bot connected');
      await page.locator('textarea.text-composer-input').waitFor();
      const clientId = (await state()).clientId;
      await call('session.control', {id: session.id, action: 'takeover'}, clientId);
      await call('flow.command', {id: session.id, command: {type: 'send', input: {inputId: randomUUID(), text: '测试 fixer 详情'}}}, clientId);
      await page.getByRole('button', {name: /查看执行过程：.*验证子任务详情/}).click();
      await page.locator('[data-task-conversation="fixture-child"]').getByText('初始进度', {exact: true}).waitFor();
      check('no-log running task opens without blanking the application');
      currentTask = {...currentTask, progressText: '收到最新进度', conversation: {...currentTask.conversation, revision: 2,
        messages: [...currentTask.conversation.messages, {id: 'child-latest', author: 'hemi', text: '实时进度已到达', createdAt: Date.now(), parts: [{type: 'text', text: '实时进度已到达'}]}]}};
      emit(currentTask);
      await page.locator('[data-task-conversation="fixture-child"]').getByText('实时进度已到达', {exact: true}).waitFor();
      check('open task details receive actual Host realtime updates');
      currentTask = {...currentTask, phase: 'terminal', outcome: 'unknown', outcomeReason: '运行请求上限已达到', endedAt: Date.now()};
      emit(currentTask); finish();
      await page.getByRole('heading', {name: '验证子任务详情', exact: true}).waitFor();
      await wait(async () => (await page.locator('.h25-process-head').innerText()).includes('结果待核实'), 'terminal task status');
      await shot('task-details');
      check('open details update to terminal outcome and keep the composer');
      assert.equal(await page.locator('textarea.text-composer-input').count(), 1);
      for (const width of [375, 768, 1440]) {
        await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(300, 400); win.setContentSize(width, 900);}, width);
        await page.waitForFunction(width => innerWidth === width, width);
        await shot(`task-${width}`);
      }
      await call('session.control', {id: session.id, action: 'takeover'}, 'other-device');
      const takeover = page.getByRole('button', {name: '抢占会话', exact: true}); await takeover.waitFor();
      await takeover.click();
      const taking = page.getByRole('button', {name: '正在抢占…', exact: true}); await taking.waitFor();
      assert.equal(await taking.isDisabled(), true); assert.equal(await taking.getAttribute('aria-busy'), 'true');
      await shot('takeover-loading');
      await page.getByText('已取得会话控制权，可以继续编辑和发送', {exact: true}).waitFor();
      check('takeover shows loading, disables repeats and confirms actual control receipt');
      await page.evaluate(() => window.hemiVoice.bot.command('connection.disconnect'));
      const reconnect = page.getByRole('button', {name: '重新连接', exact: true}); await reconnect.waitFor(); await reconnect.click();
      const connecting = page.getByRole('button', {name: '正在连接…', exact: true}); await connecting.waitFor();
      assert.equal(await connecting.isDisabled(), true); assert.equal(await connecting.getAttribute('aria-busy'), 'true');
      await shot('reconnect-loading');
      await page.getByText('已重新连接 Bot', {exact: true}).waitFor();
      check('reconnect shows loading and confirms actual connection');
      await page.evaluate(() => window.hemiVoice.bot.command('connection.disconnect'));
      await fs.writeFile(failure, 'synthetic');
      await reconnect.waitFor(); await reconnect.click();
      await wait(async () => !(await state()).online && await reconnect.count() === 1, 'reconnect failure resets button');
      await page.getByRole('alert').filter({hasText: /连接|无法/}).first().waitFor();
      check('failed reconnect displays an error and becomes retryable');
      await fs.rm(failure);
      await page.getByRole('button', {name: '设置', exact: true}).click();
      await page.getByRole('combobox', {name: '设置对象', exact: true}).selectOption('bot');
      const settingsConnect = page.getByRole('button', {name: '重新连接', exact: true});
      await settingsConnect.click();
      const settingsLoading = page.getByRole('button', {name: '正在连接…', exact: true}); await settingsLoading.waitFor();
      assert.equal(await settingsLoading.isDisabled(), true); assert.equal(await settingsLoading.getAttribute('aria-busy'), 'true');
      await shot('settings-reconnect-loading');
      await page.getByText('已重新连接 Bot', {exact: true}).waitFor();
      check('settings reconnect shows loading and actual success');
      await page.getByRole('button', {name: '管理设备', exact: true}).click();
      const pairing = page.getByRole('dialog', {name: '连接新设备', exact: true}); await pairing.waitFor();
      await page.evaluate(() => window.hemiVoice.bot.command('connection.disconnect'));
      const pairingConnect = pairing.getByRole('button', {name: '重新连接', exact: true}); await pairingConnect.waitFor();
      await wait(async () => await pairingConnect.isEnabled(), 'pairing idle'); await pairingConnect.click();
      const pairingLoading = pairing.getByRole('button', {name: '正在连接…', exact: true}); await pairingLoading.waitFor();
      assert.equal(await pairingLoading.isDisabled(), true); assert.equal(await pairingLoading.getAttribute('aria-busy'), 'true');
      await shot('pairing-reconnect-loading');
      await wait(async () => (await state()).online, 'pairing reconnected');
      check('device pairing reconnect shows loading and restores connection');
      assert.deepEqual(result.errors, []);
    } catch (error) {result.error = error.stack; await shot('failure'); throw error;}
    finally {await app.close(); app = null;}
  }
} finally {
  finish?.(); await app?.close().catch(() => {}); await vite?.close(); await service?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(root, {recursive: true, force: true});
}
