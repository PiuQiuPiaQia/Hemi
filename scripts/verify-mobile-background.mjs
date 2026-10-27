// Mobile UI -> native bridge fixture -> actual Bot Host/SDK -> real background shell.
// Model responses, native transport and keyboard notifications are controlled boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
import {replyToGoalCheck} from './lib/goal-model-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..'), app = path.join(repo, 'apps/mobile');
const output = path.join(repo, '.visual/workflow/mobile-background');
await fs.mkdir(output, {recursive: true});
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, sources: {}, results: [],
  gaps: ['Native TLS, physical iPhone and Windows shell execution are not exercised by this browser verification.']};
for (const file of ['apps/mobile/src/app.tsx', 'apps/mobile/src/style.css', 'apps/mobile/src/bot/realtime.ts',
  'packages/conversation-flow/src/components/run-activity.tsx', 'src/main/bot/host.mjs', 'scripts/verify-mobile-background.mjs'])
  report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
const browser = await chromium.launch({executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
const wait = async read => {const until = Date.now() + 15000; while (!await read()) {assert.ok(Date.now() < until, 'Condition timed out'); await new Promise(resolve => setTimeout(resolve, 30));}};
const description = '检查依赖安装进度，等待后台命令完成后继续核对项目是否可以正常启动';
function reply(res, content, commands = []) {
  if (res.destroyed) return;
  res.writeHead(200, {'content-type': 'text/event-stream'});
  const delta = commands.length ? {role: 'assistant', tool_calls: commands.map((command, index) => ({index, id: randomUUID(), type: 'function', function: {name: 'bash', arguments: JSON.stringify(command)}}))} : {role: 'assistant', content};
  for (const [value, finish] of [[delta, null], [{}, commands.length ? 'tool_calls' : 'stop']])
    res.write(`data: ${JSON.stringify({id: randomUUID(), model: 'fixture', choices: [{index: 0, delta: value, finish_reason: finish}], ...(finish ? {usage: {prompt_tokens: 30, completion_tokens: 10}} : {})})}\n\n`);
  res.end('data: [DONE]\n\n');
}
try {
  for (const mode of ['dev', 'built']) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-mobile-background-'))), work = path.join(root, 'workspace');
    process.env.HEMI_USER_DATA_DIR = path.join(root, 'userData');
    let networkDown = false;
    const requests = [];
    const model = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), messages = JSON.stringify(body.messages); requests.push(body);
      if (replyToGoalCheck(body, res)) return;
      if (!body.tools?.length) {reply(res, '后台任务验证'); return;}
      if (messages.includes('［后台命令完成')) {reply(res, '后台任务完成，已核对输出。'); return;}
      if (body.messages.some(message => message.role === 'tool')) {reply(res, '后台命令已启动，完成后继续。'); return;}
      const multi = messages.includes('BACKGROUND_MULTI');
      reply(res, '', (multi ? ['one', 'two'] : ['single']).map(name => ({
        command: `printf '${name}_STARTED'; printed=; until [ -f release-${name} ]; do if [ -z "$printed" ] && [ -f progress-${name} ]; then printf '\\n${name}_PROGRESS_中文'; printed=1; fi; sleep 0.05; done; printf '\\n${name}_DONE'`,
        description: multi ? `检查后台任务 ${name}` : description, run_in_background: true, yield_ms: 20,
      })));
    });
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
    const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: work, allowLoopbackModels: true, validateModel: async () => {}});
    const {instanceId} = await host.request('handshake');
    const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params}, {clientId: 'browser-verification'});
    await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: '本地验证', model: 'fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'SYNTHETIC_ONLY'}]});
    const other = await call('session.create'); await call('session.rename', {id: other.id, title: '另一个对话'});
    const session = await call('session.create'); await call('session.rename', {id: session.id, title: '后台任务验证'});
    const options = {root: app, configFile: path.join(app, 'vite.config.ts'), cacheDir: path.join(root, 'cache'), logLevel: 'error'};
    const server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, reducedMotion: 'reduce'});
    const result = {mode, checks: [], errors: [], screenshots: []}; report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    let page;
    try {
      if (mode === 'dev') await server.listen();
      await installMobileBotEvents(context, host, {offline: () => networkDown});
      await context.exposeBinding('__backgroundRpc', async (_source, {method, params}) => {
        if (networkDown) throw new Error('Isolated connection unavailable');
        try {return {ok: true, result: await host.request(method, params, {clientId: 'browser-verification'})};}
        catch (error) {return {ok: false, code: error.code ?? 'failed', message: error.message};}
      });
      await context.addInitScript(target => {
        const callbacks = new Map(); let next = 0;
        window.__backgroundKeyboard = height => {for (const item of callbacks.values()) if (item.eventName === (height ? 'keyboardWillShow' : 'keyboardWillHide')) item.callback({keyboardHeight: height});};
        window.CapacitorCustomPlatform = {name: 'ios'};
        window.Capacitor = {PluginHeaders: [{name: 'HemiBot', methods: ['restore', 'request'].map(name => ({name, rtype: 'promise'}))},
          {name: 'Keyboard', methods: [{name: 'addListener', rtype: 'callback'}, {name: 'removeListener', rtype: 'promise'}]}],
          nativeCallback(plugin, method, options, callback) {
            assertKeyboard(plugin, method);
            const id = String(++next); callbacks.set(id, {eventName: options.eventName, callback}); return Promise.resolve(id);
          }, async nativePromise(plugin, method, options) {
            if (plugin === 'Keyboard' && method === 'removeListener') {callbacks.delete(options.callbackId); return {};}
            if (method === 'restore') return {active: target};
            if (method === 'request') {const value = await window.__backgroundRpc(options); if (!value.ok) throw Object.assign(new Error(value.message), {code: value.code}); return value;}
            throw new Error('Unexpected native bridge method');
          }};
        function assertKeyboard(plugin, method) {if (plugin !== 'Keyboard' || method !== 'addListener') throw new Error('Unexpected keyboard callback');}
      }, {endpoint: 'https://127.0.0.1:29421', botInstanceId: instanceId, name: 'Isolated background Bot'});
      page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
      const shot = async name => {const file = path.join(output, `${mode}-${name}.png`); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.screenshot({path: file, fullPage: true, animations: 'disabled'}); result.screenshots.push(file);};
      const activity = page.getByRole('region', {name: '当前任务状态', exact: true});
      const input = page.getByRole('textbox', {name: '消息', exact: true});
      const send = async text => {await input.fill(text); await page.getByRole('button', {name: '发送消息', exact: true}).click();};
      const select = async name => {await page.getByRole('button', {name: '打开对话列表', exact: true}).click(); await page.locator('.drawer-row').filter({hasText: name}).click();};
      await page.goto(server.resolvedUrls.local[0]); await input.waitFor();
      await send('BACKGROUND_SINGLE'); await activity.waitFor();
      await activity.locator('summary').click();
      await wait(async () => (await activity.getByLabel('后台命令最近输出', {exact: true}).innerText()).includes('single_STARTED'));
      assert.match(await activity.getByLabel('后台命令', {exact: true}).innerText(), /until.*release-single/);
      assert.ok((await activity.locator('summary').boundingBox()).height >= 44);
      await fs.writeFile(path.join(work, 'progress-single'), 'progress');
      await wait(async () => (await activity.getByLabel('后台命令最近输出', {exact: true}).innerText()).includes('single_PROGRESS_中文'));
      check('actual SDK background shell appears above composer with description, elapsed time, command and live UTF-8 output');

      for (const width of [320, 375, 390, 768, 1440]) {
        await page.setViewportSize({width, height: 844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await activity.evaluate(node => node.scrollWidth > node.clientWidth), false);
        await shot(`expanded-${width}`);
      }
      await page.setViewportSize({width: 375, height: 480});
      assert.ok((await input.boundingBox()).height > 0); await shot('short-375');
      await page.setViewportSize({width: 390, height: 844});
      await page.evaluate(() => window.__backgroundKeyboard(336));
      await wait(async () => (await page.locator('.mobile-shell').boundingBox()).height <= 508);
      assert.ok((await page.getByRole('button', {name: '停止任务', exact: true}).boundingBox()).y < 508);
      assert.ok(await page.locator('.h56-run-activity-body').evaluate(node => node.scrollHeight > node.clientHeight));
      await shot('keyboard-390'); await page.evaluate(() => window.__backgroundKeyboard(0));
      await page.emulateMedia({colorScheme: 'dark'}); await shot('system-dark-390');
      assert.equal(await page.locator('main').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
      await page.emulateMedia({colorScheme: 'light'});
      check('320/375/390/768/1440, short viewport, native keyboard inset and declared light appearance retain readable scrollable details and reachable controls');

      await select('另一个对话'); assert.equal(await activity.count(), 0);
      await select('后台任务验证'); await activity.waitFor();
      await activity.locator('summary').click(); await activity.getByLabel('后台命令最近输出', {exact: true}).waitFor();
      await page.reload(); await activity.waitFor();
      await activity.locator('summary').click();
      await wait(async () => (await activity.innerText()).includes('single_PROGRESS_中文'));
      check('switching conversations isolates the task; returning and reloading recover actual active-run details');

      networkDown = true; await page.getByText('Bot 连接已断开', {exact: true}).waitFor();
      await fs.writeFile(path.join(work, 'release-single'), 'done');
      await wait(async () => (await call('flow.snapshot', {id: session.id})).phase === 'idle');
      networkDown = false; await page.getByRole('button', {name: '恢复连接', exact: true}).click();
      await activity.waitFor({state: 'hidden'});
      await page.getByText('后台任务完成，已核对输出。', {exact: true}).waitFor();
      assert.equal(requests.filter(body => body.tools?.length && JSON.stringify(body.messages).includes('［后台命令完成')).length, 1);
      check('completion while offline resumes its owning goal once; reconnect removes stale activity and shows final result in transcript');

      const multiple = await call('session.create'); await call('session.rename', {id: multiple.id, title: '多个后台任务'});
      await select('多个后台任务');
      await send('BACKGROUND_MULTI'); await activity.waitFor();
      await wait(async () => {const flow = await call('flow.snapshot', {id: multiple.id}); return flow.runs[flow.activeRunId]?.activity?.jobs.length === 2;});
      await activity.locator('summary').click();
      await wait(async () => await activity.getByLabel('后台命令最近输出', {exact: true}).count() === 2);
      await shot('multiple-390');
      await page.getByRole('button', {name: '停止任务', exact: true}).click();
      await activity.waitFor({state: 'hidden'});
      await wait(async () => (await call('flow.snapshot', {id: multiple.id})).phase === 'idle');
      check('multiple real background commands are listed; the existing stop action clears activity after Host cancellation');
      assert.deepEqual(result.errors, []); check('no renderer errors');
    } catch (error) {
      result.failure = error.stack;
      if (page) {await page.screenshot({path: path.join(output, `${mode}-failure.png`)}).catch(() => {}); await fs.writeFile(path.join(output, `${mode}-failure.txt`), await page.locator('body').innerText().catch(() => ''));}
      throw error;
    } finally {
      await context.close(); await server.close(); await host.close();
      model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await fs.rm(root, {recursive: true, force: true});
    }
  }
} finally {await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
