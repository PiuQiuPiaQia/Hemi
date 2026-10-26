// Electron -> IPC -> SSH adapter -> socket -> production Host/controller/Pi runtime.
// Only SSH networking and the upstream HTTP model are local fixtures. Never uses user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp('/tmp/hemi-bot-resend-');
const output = path.join(repo, '.visual/workflow/bot-interrupt-resend', process.env.HEMI_VERIFY_LABEL ?? 'after');
await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'cloud');
process.env.HEMI_USER_DATA_DIR = path.join(root, 'host-profile');
const {serve} = await import('../src/main/bot/cli.mjs');
const {createBotExecutor} = await import('../src/main/bot/runtime.mjs');
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`,
  command: 'node scripts/verify-bot-interrupt-resend.mjs', results: [], sources: {},
  gaps: ['SSH networking and upstream HTTP model are local fixtures; production Host, controller and Pi executor run unchanged.',
    'Global push-to-talk is disabled in isolated profiles; native keyboard-hook startup is outside this Bot lifecycle check.',
    'This interaction recording disables automatic deployment because SSH is a local fixture; paired-server auto-update is verified separately. No personal conversation is modified.']};
const wait = async (read, label = 'condition') => {
  const end = Date.now() + 20000;
  while (!await read()) {assert.ok(Date.now() < end, 'Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 30));}
};
let service, vite, app, stopGate;
const requests = [], streams = new Set();
let failNext = false;
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), main = Boolean(body.tools?.length);
  if (main) requests.push(body);
  if (main && failNext) {
    failNext = false;
    res.writeHead(401, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: {message: 'TEST_ONLY_INVALID_CREDENTIAL', type: 'api_error'}})); return;
  }
  res.writeHead(200, {'content-type': 'text/event-stream'});
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id: 'isolated', model: body.model, choices: [{index: 0, delta, finish_reason}]})}\n\n`);
  chunk({role: 'assistant', content: main ? '这是正在生成的测试回复。' : 'OK'});
  const finish = () => {if (!res.destroyed) {chunk({content: '测试回复完成。'}); chunk({}, 'stop'); res.end('data: [DONE]\n\n');} streams.delete(finish);};
  if (main) {streams.add(finish); res.on('close', () => streams.delete(finish));} else finish();
});
const releaseStreams = () => {for (const finish of [...streams]) finish();};
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
try {
  service = await serve({defaultDir: path.join(root, 'workspace'), allowLoopbackModels: true,
    executorFactory: options => {
      const real = createBotExecutor(options);
      return {...real, async stop(id) {await stopGate?.promise; return real.stop(id);}};
    }});
  const hello = await service.host.request('handshake');
  const request = (method, params = {}) => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params});
  const model = {modelKey: 'fixture/model', providerId: 'fixture', name: '隔离测试模型', model: 'fixture', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'TEST_ONLY', thinkingLevel: 'off'};
  await request('model.sync', {source: 'manual', models: [model]});
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await vite.listen();
  const modes = process.env.HEMI_VERIFY_MODE ? [process.env.HEMI_VERIFY_MODE] : ['dev', 'built'];
  for (const mode of modes) {
    const folder = path.join(root, mode), profile = path.join(folder, 'profile');
    const evidence = path.join(output, mode);
    await fs.rm(evidence, {recursive: true, force: true});
    await fs.mkdir(evidence, {recursive: true});
    await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    const {id} = await request('session.create');
    await request('session.rename', {id, title: '中断与重发验收-' + mode});
    const ssh = path.join(folder, 'ssh.mjs'), gate = path.join(folder, 'gate.json'), marker = path.join(folder, 'stop.json'), commandLog = path.join(folder, 'commands.jsonl');
    await fs.writeFile(gate, '{}');
    await fs.writeFile(ssh, `#!${process.execPath}
import fs from 'node:fs/promises';import{spawn}from'node:child_process';
if(process.argv.includes('-O'))process.exit(0);
const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const value=JSON.parse(raw),file=${JSON.stringify(gate)};
if(value.method==='flow.command')await fs.appendFile(${JSON.stringify(commandLog)},JSON.stringify(value.params)+String.fromCharCode(10));
if(value.method==='flow.command'&&value.params?.command?.type==='stop'){
 await fs.writeFile(${JSON.stringify(marker)},JSON.stringify(value));
 while(await fs.readFile(file,'utf8').then(s=>JSON.parse(s).hold,()=>false))await new Promise(resolve=>setTimeout(resolve,20));
}
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
child.stdin.end(raw);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-resend', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = {mode, checks: [], screenshots: [], errors: []}; report.results.push(result);
    const frames = []; let cdp;
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    let page;
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
    const flow = () => request('flow.snapshot', {id});
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    const shot = async name => {await page.screenshot({path: path.join(evidence, name + '.png'), scale: 'css'}); result.screenshots.push(name + '.png');};
    const bubble = text => page.locator('.h24-user-bubble').filter({hasText: text});
    const input = page.getByRole('textbox', {name: '输入消息', exact: true});
    const send = async text => {await input.fill(text); await input.press('Enter'); await bubble(text).waitFor();};
    const edit = async (text, replacement) => {
      await bubble(text).locator('..').getByRole('button', {name: '编辑这条消息', exact: true}).click();
      await page.getByRole('textbox', {name: '编辑消息', exact: true}).fill(replacement);
      await page.getByRole('button', {name: '重新发送', exact: true}).click();
    };
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await page.evaluate(() => window.hemiVoice.bot.getState())).online);
      await page.locator('.h24-sidebar-open').filter({hasText: '中断与重发验收-' + mode}).click();
      await input.waitFor();
      await app.evaluate(({BrowserWindow}) => {const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(300, 400); win.setContentSize(1440, 900); win.show();});
      const graph = page.getByRole('button', {name: '移动性能监控', exact: true});
      if (await graph.isVisible()) {const box = await graph.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(260, 80, {steps: 5}); await page.mouse.up();}
      const takeover = page.getByRole('button', {name: '抢占会话', exact: true});
      if (await takeover.isVisible()) await takeover.click();
      await wait(async () => await input.getAttribute('readonly') === null, 'isolated client controls session');
      cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', frame => {
        frames.push({data: Buffer.from(frame.data, 'base64'), at: frame.metadata.timestamp});
        void cdp.send('Page.screencastFrameAck', {sessionId: frame.sessionId}).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 75, maxWidth: 1440, maxHeight: 900});

      await send('第一条原问题'); await wait(() => streams.size > 0, 'original provider request');
      const originalRun = (await flow()).activeRunId, before = requests.length;
      stopGate = Promise.withResolvers();
      await page.getByRole('button', {name: '停止当前任务', exact: true}).click();
      await wait(async () => (await flow()).phase === 'stopping', 'stop accepted before cleanup');
      await edit('第一条原问题', '停止后立即重发');
      await bubble('停止后立即重发').waitFor();
      await page.waitForTimeout(450); // Keep the stopping handoff readable in the recording.
      await shot('resend-during-stop');
      assert.equal((await flow()).generation, 1, 'old generation must remain until old run closes');
      assert.equal((await flow()).activeRunId, originalRun);
      assert.equal(requests.length, before, 'replacement cannot start before old cleanup');
      stopGate.resolve(); stopGate = null;
      await wait(() => requests.length === before + 1, 'replacement reaches real Pi provider');
      await wait(async () => (await flow()).phase === 'running');
      releaseStreams(); await wait(async () => (await flow()).phase === 'idle');
      await page.getByText('这是正在生成的测试回复。测试回复完成。', {exact: true}).waitFor();
      assert.equal((await flow()).queuePaused, false);
      assert.equal(await bubble('第一条原问题').count(), 0);
      assert.equal(await bubble('停止后立即重发').count(), 1);
      await shot('stop-resend-complete');
      await page.waitForTimeout(450);
      check('停止收口期间重发等待旧运行关闭，只执行一次，回复完成后解除停止态');

      await send('直接编辑运行中的消息'); await wait(() => streams.size > 0);
      const count = requests.length;
      await edit('直接编辑运行中的消息', '运行中替换后的消息');
      await wait(() => requests.length === count + 1);
      assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /直接编辑运行中的消息/);
      releaseStreams(); await wait(async () => (await flow()).phase === 'idle');
      check('运行中直接编辑重发清除旧上下文，真实 SDK 执行一次');

      await send('迟到停止测试'); await wait(() => streams.size > 0);
      await fs.rm(marker, {force: true});
      await fs.writeFile(gate, '{"hold":true}');
      await page.getByRole('button', {name: '停止当前任务', exact: true}).click();
      await wait(() => fs.access(marker).then(() => true, () => false));
      const oldRun = (await flow()).activeRunId, delayed = JSON.parse(await fs.readFile(marker, 'utf8')), lateRequests = requests.length;
      await edit('迟到停止测试', '迟到停止不能取消的新消息');
      await wait(async () => (await flow()).activeRunId !== oldRun && (await flow()).phase === 'running');
      const replacementRun = (await flow()).activeRunId;
      await fs.writeFile(gate, '{}');
      assert.equal(delayed.params.command.targetRunId, oldRun);
      await wait(async () => (await request('operation.get', {operationId: delayed.params.requestId})).status === 'done', 'delayed stop receipt');
      assert.equal((await flow()).activeRunId, replacementRun);
      await wait(() => requests.length === lateRequests + 1 && streams.size > 0, 'replacement provider stream is open');
      releaseStreams(); await wait(async () => (await flow()).phase === 'idle');
      assert.equal((await flow()).runs[replacementRun].outcome, 'completed');
      await page.waitForTimeout(450);
      check('SSH 中迟到的停止绑定原运行，不能取消新回复');

      failNext = true; await send('模型错误后重试');
      await page.locator('.turn-error-retry').waitFor();
      await input.fill('保留未发送的草稿');
      const failedCount = requests.length;
      await page.locator('.turn-error-retry').dblclick();
      await wait(() => streams.size > 0);
      assert.equal(requests.length, failedCount + 1);
      releaseStreams(); await wait(async () => (await flow()).phase === 'idle');
      assert.equal(await input.inputValue(), '保留未发送的草稿');
      assert.equal(await page.locator('.turn-error-retry').count(), 0);
      check('真实模型错误后连点重试只执行一次，草稿保留且旧错误退场');

      for (const width of [375, 768, 1440]) {
        await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).setContentSize(width, 900), width);
        await page.waitForFunction(width => innerWidth === width, width);
        await page.waitForTimeout(350); // Finish the existing responsive navigation transition.
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await shot('completed-' + width);
      }
      await page.emulateMedia({colorScheme: 'dark'}); await shot('completed-dark-preference');
      assert.deepEqual(result.errors, []);
      check('375/768/1440 无横向溢出，系统深色偏好下可读，无 renderer 异常');
    } catch (error) {result.failure = error.stack; result.snapshot = await flow(); result.desktop = await page.evaluate(() => window.hemiVoice.bot.getState()); await shot('failure').catch(() => {}); throw error;}
    finally {
      stopGate?.resolve(); stopGate = null; await fs.writeFile(gate, '{}'); releaseStreams();
      result.commands = await fs.readFile(commandLog, 'utf8').then(s => s.trim().split('\n').map(JSON.parse), () => []);
      if (cdp) {await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {});}
      if (frames.length) {
        const frameDir = path.join(evidence, 'frames'); await fs.mkdir(frameDir, {recursive: true});
        for (let i = 0; i < frames.length; i++) await fs.writeFile(path.join(frameDir, `${i}.jpg`), frames[i].data);
        const concat = frames.map((frame, i) => `file '${i}.jpg'\nduration ${Math.max(.02, (frames[i + 1]?.at ?? frame.at + .6) - frame.at)}\n`).join('');
        await fs.writeFile(path.join(frameDir, 'frames.txt'), concat + `file '${frames.length - 1}.jpg'\n`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', 'scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '../interrupt-resend.mp4'], {cwd: frameDir});
        result.video = path.join(evidence, 'interrupt-resend.mp4');
      }
      await app.close(); app = null;
    }
  }
} finally {
  stopGate?.resolve(); releaseStreams();
  await app?.close(); await vite?.close(); await service?.close();
  await new Promise(resolve => provider.close(resolve));
  for (const file of ['src/main/services/conversation-controller.mjs', 'src/renderer/src/windows/bot/page.tsx', 'src/renderer/src/windows/bot/bridge.ts', 'src/renderer/src/windows/voice/lib/use-conversation-flow.ts', 'src/main/bot/host.mjs', 'src/main/bot/runtime.mjs', 'src/main/bot/desktop-service.mjs', 'packages/conversation-flow/src/components/conversation-flow.tsx', 'packages/conversation-flow/src/core/conversation.ts', 'packages/conversation-flow/src/core/presenter.ts'])
    report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, {recursive: true, force: true});
}
