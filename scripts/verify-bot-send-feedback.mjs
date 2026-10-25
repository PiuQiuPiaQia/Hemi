// Electron renderer -> actual IPC/SSH runner -> CLI/socket -> production Bot Host/controller.
// The SSH network and model executor are controlled so acceptance can be held before the Host.
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
const root = await fs.mkdtemp('/tmp/hemi-send-feedback-');
const output = path.join(repo, '.visual/workflow/bot-send-feedback');
await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'cloud');
process.env.HEMI_USER_DATA_DIR = path.join(root, 'host-profile');
const {serve} = await import('../src/main/bot/cli.mjs');
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  command: 'node scripts/verify-bot-send-feedback.mjs', node: process.version, platform: `${process.platform}/${process.arch}`, sources: {}, results: [],
  gaps: ['SSH network and model execution are controlled fixtures. No production data or external model credentials are used.']};
const wait = async (read, label = 'condition') => {
  const end = Date.now() + 15000;
  while (!await read()) {assert.ok(Date.now() < end, 'Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20));}
};
const read = file => fs.readFile(file, 'utf8').then(JSON.parse, () => null);
const live = new Map(), runs = [];
let service, server, app;
try {
  service = await serve({defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
    run(spec, apply) {runs.push(spec); return new Promise(resolve => live.set(spec.conversationId, {spec, apply, resolve}));},
    async stop(id) {live.get(id)?.resolve({stopped: true});},
    async close() {for (const run of live.values()) run.resolve({stopped: true});},
  })});
  const hello = await service.host.request('handshake');
  const request = (method, params = {}) => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params}, {clientId: 'another-device'});
  await request('model.sync', {source: 'manual', models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'SYNTHETIC_ONLY'}]});
  const snapshot = id => request('flow.snapshot', {id});
  async function finish(id, text) {
    const run = live.get(id);
    run.apply({type: 'part-appended', runId: run.spec.runId, generation: run.spec.generation, part: {partId: 'answer', kind: 'text', content: text}});
    run.resolve({}); await wait(async () => !(await snapshot(id)).activeRunId, 'Host completion');
  }
  async function seed(id, text, answer) {
    const inputId = randomUUID();
    await request('flow.command', {id, command: {type: 'send', input: {inputId, text}}});
    await wait(() => live.get(id)?.spec.envelope.inputId === inputId);
    await finish(id, answer); return inputId;
  }
  server = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await server.listen();
  for (const mode of ['dev', 'built']) {
    const folder = path.join(root, mode), profile = path.join(folder, 'profile');
    await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    const {id} = await request('session.create');
    await request('session.rename', {id, title: '发送反馈验收-' + mode});
    await seed(id, '原问题', '原回答');
    const gate = path.join(folder, 'gate.json'), marker = path.join(folder, 'request.json'), ssh = path.join(folder, 'ssh.mjs');
    await fs.writeFile(gate, '{}');
    await fs.writeFile(ssh, `#!${process.execPath}
import fs from 'node:fs/promises';import{spawn}from'node:child_process';
if(process.argv.includes('-O'))process.exit(0);
const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const value=JSON.parse(raw),file=${JSON.stringify(gate)};
const read=()=>fs.readFile(file,'utf8').then(JSON.parse,()=>({}));
let action={};
if(value.method==='flow.command'&&['send','rewind'].includes(value.params?.command?.type)){
 action=await read();await fs.writeFile(${JSON.stringify(marker)},JSON.stringify(value));
 while((await read()).hold)await new Promise(resolve=>setTimeout(resolve,20));
 if(action.unknown){process.stdout.write(JSON.stringify({ok:false,code:'needs-review',message:'隔离的回执丢失'}));process.exit(0);}
}
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
child.stdin.end(raw);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-feedback', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_TEST_MIC_GRANT: '1'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = server.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = {mode, checks: [], screenshots: [], errors: [], timings: {}}; report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    let page;
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => result.errors.push(error.message));
    const resize = async width => {
      await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(1, 1); win.setContentSize(width, 900);}, width);
      await page.waitForFunction(width => innerWidth === width, width);
      if (mode === 'dev') {
        const graph = page.getByRole('button', {name: '移动性能监控', exact: true});
        if (await graph.isVisible()) {const box = await graph.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(Math.min(width - 50, 260), 80, {steps: 5}); await page.mouse.up();}
      }
    };
    const shot = async label => {const file = path.join(output, `${mode}-${label}.png`); await page.screenshot({path: file, animations: 'disabled'}); result.screenshots.push(file);};
    const hold = async (extra = {}) => {await fs.rm(marker, {force: true}); await fs.writeFile(gate, JSON.stringify({hold: true, ...extra}));};
    const release = () => fs.writeFile(gate, '{}');
    const held = async text => {await wait(async () => (await read(marker))?.params.command.input.text === text, 'held SSH request'); return (await read(marker)).params;};
    const bubble = text => page.locator('.h24-user-bubble').filter({hasText: text});
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await page.evaluate(() => window.hemiVoice.bot.getState())).online);
      await page.locator('.h24-sidebar-open').filter({hasText: '发送反馈验收-' + mode}).click();
      await bubble('原问题').waitFor();
      await resize(1440);
      const input = page.getByRole('textbox', {name: '输入消息', exact: true});
      const send = page.getByRole('button', {name: '发送消息', exact: true});
      await hold(); await input.fill('新消息立即出现'); const start = Date.now(); await send.click();
      await bubble('新消息立即出现').waitFor(); result.timings.sendDisplayMs = Date.now() - start;
      const newSend = await held('新消息立即出现');
      assert.equal(await input.inputValue(), ''); assert.equal(await bubble('新消息立即出现').count(), 1);
      assert.equal((await snapshot(id)).timeline.some(item => item.kind === 'user' && item.id === newSend.command.input.inputId), false);
      assert.equal(await page.getByText('正在发送…', {exact: true}).count(), 0);
      assert.equal(await send.isDisabled(), true);
      await input.fill('发送过程中输入的新草稿');
      for (const width of [375, 768, 1440]) {await resize(width); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); await shot('pending-' + width);}
      await page.emulateMedia({colorScheme: 'dark'}); await shot('pending-dark-preference'); await page.emulateMedia({colorScheme: 'light'});
      await release(); await wait(() => live.get(id)?.spec.envelope.inputId === newSend.command.input.inputId);
      await finish(id, '新消息回答'); await page.getByText('新消息回答', {exact: true}).waitFor();
      assert.equal(await input.inputValue(), '发送过程中输入的新草稿'); assert.equal(await bubble('新消息立即出现').count(), 1);
      check('new send displays before Host acceptance, keeps newer typing and becomes one authoritative message');

      await hold(); await bubble('原问题').locator('..').getByRole('button', {name: '编辑这条消息', exact: true}).click();
      const edit = page.getByRole('textbox', {name: '编辑消息', exact: true}); await edit.fill('编辑后立即出现');
      const editStart = Date.now(); await page.getByRole('button', {name: '重新发送', exact: true}).click();
      await bubble('编辑后立即出现').waitFor(); result.timings.editDisplayMs = Date.now() - editStart;
      const resend = await held('编辑后立即出现');
      assert.equal(await edit.count(), 0); assert.equal(await page.getByText('原回答', {exact: true}).count(), 0);
      assert.ok((await snapshot(id)).timeline.some(item => item.kind === 'assistant' && item.parts.some(part => part.content === '原回答')));
      await shot('pending-edit');
      await release(); await wait(() => live.get(id)?.spec.envelope.inputId === resend.command.input.inputId);
      await finish(id, '编辑后的回答'); await page.getByText('编辑后的回答', {exact: true}).waitFor();
      assert.equal(await bubble('编辑后立即出现').count(), 1);
      assert.equal(runs.filter(run => run.envelope.inputId === resend.command.input.inputId).length, 1);
      assert.equal(await input.inputValue(), '发送过程中输入的新草稿');
      check('edit leaves its editor immediately, previews locally and executes its stable input once');

      const acquired = await request('session.control', {id, action: 'acquire'});
      assert.equal(acquired.ok, false, 'opening or reading must not silently take the active editor');
      await assert.rejects(() => request('flow.command', {id, command: {type: 'send', input: {inputId: randomUUID(), text: '未抢占的设备不能发送'}}}), /会话已被/);
      await hold(); await input.fill('抢占时保留我的未发送内容'); await send.click();
      const stale = await held('抢占时保留我的未发送内容');
      const taken = await request('session.control', {id, action: 'takeover'}); assert.equal(taken.ok, true);
      await page.getByRole('button', {name: '抢占会话', exact: true}).waitFor();
      await release();
      await wait(async () => await input.inputValue() === '抢占时保留我的未发送内容');
      assert.equal(await input.getAttribute('readonly'), '');
      assert.equal(runs.filter(run => run.envelope.inputId === stale.command.input.inputId).length, 0);
      assert.equal(await bubble('抢占时保留我的未发送内容').count(), 0);
      const remoteId = randomUUID();
      await request('flow.command', {id, command: {type: 'send', input: {inputId: remoteId, text: '新占用设备发送的消息'}}});
      await wait(() => live.get(id)?.spec.envelope.inputId === remoteId);
      await bubble('新占用设备发送的消息').waitFor();
      assert.ok((await snapshot(id)).timeline.some(item => item.kind === 'user' && item.id === remoteId));
      await shot('occupied-readonly');
      await page.getByRole('button', {name: '抢占会话', exact: true}).click();
      await wait(async () => await input.getAttribute('readonly') === null);
      assert.equal(await input.inputValue(), '抢占时保留我的未发送内容');
      await assert.rejects(() => request('flow.command', {id, controlEpoch: taken.control.epoch, command: {type: 'send', input: {inputId: randomUUID(), text: '旧占用请求'}}}), /会话已被/);
      assert.equal(live.get(id).spec.envelope.inputId, remoteId);
      await finish(id, '抢占后原任务继续完成');
      await page.getByText('抢占后原任务继续完成', {exact: true}).waitFor();
      check('occupied peers stay read-only; explicit takeover rejects late writes, preserves drafts and leaves shared history intact');

      await hold({unknown: true}); await input.fill('结果不明时不自动重发'); await send.click();
      const uncertain = await held('结果不明时不自动重发'); await release();
      await page.getByRole('button', {name: '核对提交结果', exact: true}).waitFor();
      assert.equal(await bubble('结果不明时不自动重发').count(), 0);
      assert.equal(await input.inputValue(), '结果不明时不自动重发');
      assert.equal(runs.filter(run => run.envelope.inputId === uncertain.command.input.inputId).length, 0);
      await page.getByRole('button', {name: '核对提交结果', exact: true}).click();
      await page.getByRole('alert').filter({hasText: '云端确认未受理'}).waitFor();
      assert.equal(await input.inputValue(), '结果不明时不自动重发');
      assert.equal(runs.filter(run => run.envelope.inputId === uncertain.command.input.inputId).length, 0);
      check('unknown outcomes remove only the local preview, retain the draft and query receipts without replay');
      assert.deepEqual(result.errors, []);
    } catch (error) {result.failure = error.stack; await shot('failure').catch(() => {}); throw error;}
    finally {await release(); await app.close(); app = null;}
  }
} finally {
  await app?.close(); await server?.close(); await service?.close();
  for (const file of ['src/renderer/src/windows/bot/page.tsx', 'src/renderer/src/windows/bot/pending-input.ts', 'packages/conversation-flow/src/components/message-row.tsx', 'packages/conversation-flow/src/core/presenter.ts', 'src/main/bot/desktop-service.mjs', 'src/main/bot/host.mjs'])
    report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, {recursive: true, force: true});
}
