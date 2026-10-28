// Isolated iOS renderer -> native bridge fixture -> real Bot Host/controller.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..'), app = path.join(repo, 'apps/mobile');
const output = path.join(repo, '.visual/workflow/mobile-task-notices');
await fs.mkdir(output, {recursive: true});
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, command: 'node scripts/verify-mobile-task-notices.mjs',
  gaps: ['Native TLS, iPhone installation and physical touch are outside this browser verification.'], sources: {}, results: []};
for (const file of ['apps/mobile/src/app.tsx', 'apps/mobile/src/components/task-details-panel.tsx', 'apps/mobile/src/style.css', 'packages/conversation-flow/src/core/conversation.ts', 'packages/conversation-flow/src/host/context.tsx', 'packages/conversation-flow/src/components/conversation-flow.tsx', 'packages/conversation-flow/src/types/api.ts'])
  report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
const browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
const wait = async (read, label) => {const deadline = Date.now() + 12000; while (!await read()) {assert.ok(Date.now() < deadline, 'Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 25));}};
try {
  for (const mode of ['dev', 'built']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-mobile-notices-'));
    process.env.HEMI_USER_DATA_DIR = path.join(root, 'userData');
    let task, emit, finish, rejectAcquire = false;
    const requests = [];
    const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
      async run(spec, apply) {
        emit = next => apply({type: 'task-updated', generation: spec.generation, task: next});
        task = {taskId: 'mobile-child', key: 'mobile-child', conversationId: spec.conversationId, rootRunId: spec.runId, toolCallId: 'child-call',
          agent: 'fixer', agentTitle: '执行', taskText: '验收手机子任务', phase: 'running', progressText: '正在读取文件', startedAt: Date.now(),
          conversation: {revision: 1, messages: [{id: 'child-1', author: 'hemi', text: '子任务独立进度', parts: [{type: 'text', text: '子任务独立进度'}], createdAt: Date.now()}]}};
        apply({type: 'part-appended', runId: spec.runId, generation: spec.generation, part: {partId: 'delegation', kind: 'delegation', taskId: task.taskId, toolCallId: task.toolCallId, status: 'running', args: {agent: 'fixer', description: task.taskText}}});
        emit(task); await new Promise(resolve => {finish = resolve;}); return {};
      },
      async stop() {task = {...task, phase: 'terminal', outcome: 'stopped', endedAt: Date.now()}; emit(task); finish?.();}, async close() {finish?.();},
    })});
    const {instanceId} = await host.request('handshake');
    const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params}, {clientId: 'browser-verification'});
    await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
    const {id} = await call('session.create');
    await call('flow.command', {id, command: {type: 'send', input: {inputId: randomUUID(), text: '请执行子任务'}}});
    await wait(() => !!emit && !!finish, 'seed task');
    const options = {root: app, configFile: path.join(app, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error'};
    const server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, reducedMotion: 'reduce'});
    const result = {mode, checks: [], errors: [], screenshots: []}; report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    try {
      if (mode === 'dev') await server.listen();
      await installMobileBotEvents(context, host);
      await context.exposeBinding('__noticeRpc', async (_source, {method, params}) => {
        requests.push({method, params});
        if (rejectAcquire && method === 'session.control') return {ok: false, code: 'unsupported', message: '这项操作暂时无法在手机完成，请在电脑端操作。'};
        try {return {ok: true, result: await host.request(method, params, {clientId: 'browser-verification'})};}
        catch (error) {return {ok: false, code: error.code ?? 'failed', message: error.message};}
      });
      await context.addInitScript(target => {
        window.__failHistoryCache = true;
        const save = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {if (window.__failHistoryCache && key.endsWith(':snapshot')) throw new DOMException('Synthetic cache quota', 'QuotaExceededError'); return save.call(this, key, value);};
        window.CapacitorCustomPlatform = {name: 'ios'};
        window.Capacitor = {PluginHeaders: [{name: 'HemiBot', methods: ['restore', 'request'].map(name => ({name, rtype: 'promise'}))}], async nativePromise(_plugin, method, options) {
          if (method === 'restore') return {active: target};
          if (method === 'request') {const response = await window.__noticeRpc(options); if (!response.ok) throw Object.assign(new Error(response.message), {code: response.code}); return response;}
          throw new Error('Unexpected bridge call');
        }};
      }, {endpoint: 'https://fixture.invalid', botInstanceId: instanceId, name: 'Notice verification'});
      const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => result.errors.push(error.message));
      const shot = async name => {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const file = path.join(output, `${mode}-${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); result.screenshots.push(file);};
      await page.goto(server.resolvedUrls.local[0]);
      const cache = page.getByText('暂时无法保存离线聊天记录，当前对话仍可正常使用。', {exact: true});
      await cache.waitFor(); await shot('cache-notice');
      await cache.waitFor({state: 'hidden', timeout: 8000});
      check('history cache failure has plain copy and disappears automatically');
      const details = page.getByRole('button', {name: /查看执行过程：.*验收手机子任务/});
      await details.click();
      const panel = page.getByRole('dialog', {name: '子任务详情', exact: true});
      await panel.getByText('子任务独立进度', {exact: true}).waitFor();
      assert.equal(await page.getByText('移动端尚未接入此操作', {exact: true}).count(), 0);
      check('fixer opens a real child transcript without requiring the legacy log field');
      task = {...task, progressText: '进度已更新', conversation: {...task.conversation, revision: 2, messages: [...task.conversation.messages,
        {id: 'child-2', author: 'hemi', text: '实时更新已到达手机', parts: [{type: 'text', text: '实时更新已到达手机'}], createdAt: Date.now()}]}};
      emit(task); await panel.getByText('实时更新已到达手机', {exact: true}).waitFor();
      assert.equal(await cache.count(), 0, 'repeated cache failures must not reopen the notice');
      for (const width of [375, 768, 1440]) {await page.setViewportSize({width, height: 844}); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot(`task-${width}`);}
      await page.setViewportSize({width: 390, height: 844});
      check('open details update from actual Host events and remain usable at mobile/tablet widths');
      await panel.getByRole('button', {name: '关闭', exact: true}).click();
      await page.getByRole('button', {name: /停止 执行 fixer：验收手机子任务/}).click();
      await panel.getByText('将停止本次执行及其所有子任务，已完成的内容会保留。', {exact: true}).waitFor();
      assert.equal(requests.filter(request => request.method === 'flow.command' && request.params.command.type === 'stop').length, 0);
      await panel.getByRole('button', {name: '确认停止当前任务', exact: true}).click();
      await panel.getByRole('status').filter({hasText: '已停止'}).waitFor();
      assert.equal(requests.filter(request => request.method === 'flow.command' && request.params.command.type === 'stop').length, 1);
      assert.equal((await call('flow.snapshot', {id})).tasks['mobile-child'].outcome, 'stopped');
      await shot('stopped'); check('stop explains its whole-run scope, sends once after confirmation and receives terminal state');
      await panel.getByRole('button', {name: '关闭', exact: true}).click();
      rejectAcquire = true;
      await page.getByRole('button', {name: '编辑这条消息', exact: true}).click();
      const failure = page.getByText('这项操作暂时无法在手机完成，请在电脑端操作。', {exact: true});
      await failure.waitFor(); await shot('action-error');
      assert.equal(await page.locator('.h62-deliverable-error').count(), 0);
      assert.equal(await page.getByRole('textbox', {name: '编辑消息', exact: true}).count(), 0, 'a rejected edit must not leave a false editor');
      await failure.waitFor({state: 'hidden', timeout: 8000});
      await page.getByRole('button', {name: '编辑这条消息', exact: true}).click(); await failure.waitFor();
      check('action errors use a six-second toast; the same error can be shown again');
      rejectAcquire = false;
      await page.getByRole('textbox', {name: '消息', exact: true}).fill('缓存失败后仍可发送');
      await page.getByRole('button', {name: '发送消息', exact: true}).click();
      await wait(async () => (await call('flow.snapshot', {id})).timeline.some(row => row.kind === 'user' && row.text === '缓存失败后仍可发送'), 'send accepted');
      check('optional cache failures never block actual Host acceptance');
      assert.deepEqual(result.errors, []);
    } catch (error) {result.error = error.stack; await context.pages()[0]?.screenshot({path: path.join(output, `${mode}-failure.png`)}); throw error;}
    finally {finish?.(); await context.close(); await server.close(); await host.close(); await fs.rm(root, {recursive: true, force: true});}
  }
} finally {await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));}
