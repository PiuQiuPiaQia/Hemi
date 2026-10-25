// Actual mobile renderer -> native RPC boundary fixture -> actual Bot Host/controller.
// Hold requests before acceptance to observe every intermediate queue state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..'), app = path.join(repo, 'apps/mobile');
const output = path.join(repo, '.visual/workflow/vision/mobile-send-queue');
await fs.mkdir(output, {recursive: true});
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, command: 'node scripts/verify-mobile-send-queue.mjs',
  gaps: ['Native TLS and physical-device installation are outside this renderer regression; the native RPC bridge and model executor are fixtures.'], sources: {}, results: []};
for (const name of ['apps/mobile/src/app.tsx', 'apps/mobile/src/style.css', 'packages/conversation-flow/src/core/conversation.ts', 'packages/conversation-flow/src/core/presenter.ts', 'packages/conversation-flow/src/core/queue.ts', 'scripts/verify-mobile-send-queue.mjs'])
  report.sources[name] = createHash('sha256').update(await fs.readFile(path.join(repo, name))).digest('hex');
const browser = await chromium.launch({executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
const wait = async predicate => {
  const until = Date.now() + 12000;
  while (!await predicate()) {assert.ok(Date.now() < until, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 20));}
};
try {
  for (const mode of ['dev', 'built']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-mobile-send-queue-'));
    process.env.HEMI_USER_DATA_DIR = path.join(root, 'userData');
    const runs = [], requests = [];
    let holdSend = false, releaseSend, networkDown = false, failSend = false;
    const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {},
      executorFactory: () => ({run(spec) {return new Promise(resolve => runs.push({spec, resolve}));},
        async stop(id) {runs.filter(run => run.spec.conversationId === id).at(-1)?.resolve({stopped: true});},
        async close() {for (const run of runs) run.resolve({stopped: true});}})});
    const {instanceId} = await host.request('handshake');
    const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params});
    await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
    const {id} = await call('session.create');
    const options = {root: app, configFile: path.join(app, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error'};
    const server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
    const context = await browser.newContext({viewport: {width: 375, height: 812}, hasTouch: true, isMobile: true, reducedMotion: 'reduce'});
    const result = {mode, checks: [], errors: [], screenshots: []}; report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    try {
      if (mode === 'dev') await server.listen();
      await installMobileBotEvents(context, host, {offline: () => networkDown});
      await context.exposeBinding('__sendQueueRpc', async (_source, {method, params}) => {
        requests.push({method, params});
        if (networkDown) return {ok: false, code: 'network', message: 'Isolated offline transport'};
        if (method === 'flow.command' && params.command.type === 'send') {
          if (holdSend) await new Promise(resolve => {releaseSend = resolve;});
          if (failSend) return {ok: false, code: 'network', message: 'Isolated unknown delivery'};
        }
        try {return {ok: true, result: await host.request(method, params)};}
        catch (error) {return {ok: false, code: error.code ?? 'failed', message: error.message};}
      });
      await context.addInitScript(target => {
        window.CapacitorCustomPlatform = {name: 'ios'};
        window.Capacitor = {PluginHeaders: [{name: 'HemiBot', methods: ['restore', 'request'].map(name => ({name, rtype: 'promise'}))}],
          async nativePromise(_plugin, method, options) {
            if (method === 'restore') return {active: target};
            if (method === 'request') {
              const response = await window.__sendQueueRpc(options);
              if (!response.ok) throw Object.assign(new Error(response.message), {code: response.code});
              return response;
            }
            throw new Error('Unexpected bridge call');
          }};
      }, {endpoint: 'https://127.0.0.1:29421', botInstanceId: instanceId, name: 'Isolated send verification'});
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
      const settle = async () => {
        await page.waitForFunction(() => Math.abs(document.querySelector('.mobile-shell').getBoundingClientRect().height - innerHeight) < 1);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForTimeout(200);
      };
      const shot = async name => {await settle(); const file = path.join(output, `${mode}-${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); result.screenshots.push(file);};
      await page.goto(server.resolvedUrls.local[0]);
      const input = page.getByRole('textbox', {name: '消息', exact: true}), send = page.locator('.send-control');
      await input.waitFor(); await wait(async () => await send.isDisabled());
      await page.evaluate(() => {
        window.__sendQueueFrames = [];
        new MutationObserver(() => {
          window.__sendQueueFrames.push([...document.querySelectorAll('.h24-queue-text')].map(node => node.textContent));
        }).observe(document, {childList: true, subtree: true, characterData: true});
      });
      holdSend = true; await input.fill('空闲发送直接上屏'); await send.click(); await wait(() => !!releaseSend);
      assert.equal(await input.inputValue(), '');
      assert.equal(await send.isDisabled(), true);
      assert.equal(await page.locator('.h24-queue-tray').count(), 0);
      await page.locator('.h24-user-bubble').filter({hasText: '空闲发送直接上屏'}).waitFor();
      assert.equal(await page.getByText('正在发送…', {exact: true}).count(), 0);
      assert.equal((await call('flow.snapshot', {id})).timeline.length, 0);
      for (const width of [375, 414, 768, 1440]) {
        await page.setViewportSize({width, height: 812});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await shot(`submitting-${width}`);
      }
      await input.fill('发送过程中输入的新草稿');
      holdSend = false; releaseSend(); releaseSend = null;
      await page.locator('.h24-user-bubble').filter({hasText: '空闲发送直接上屏'}).waitFor();
      await wait(() => runs.length === 1);
      assert.equal(await input.inputValue(), '发送过程中输入的新草稿');
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '空闲发送直接上屏'}).count(), 1);
      assert.ok((await page.evaluate(() => window.__sendQueueFrames)).every(items => items.length === 0), 'idle send flashed a queue');
      assert.equal(runs.length, 1);
      check('slow idle send immediately shows one message and clears its input without a sending notice; acceptance preserves newer typing');

      holdSend = true; await input.fill('忙碌时才进入队列'); await send.click(); await wait(() => !!releaseSend);
      assert.equal(await page.locator('.h24-queue-tray').count(), 0);
      assert.equal(await input.inputValue(), '');
      await page.locator('.h24-user-bubble').filter({hasText: '忙碌时才进入队列'}).waitFor();
      holdSend = false; releaseSend(); releaseSend = null;
      await page.locator('.h24-queue-text').filter({hasText: '忙碌时才进入队列'}).waitFor();
      assert.equal((await call('flow.snapshot', {id})).pending.length, 1);
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '忙碌时才进入队列'}).count(), 0);
      await page.setViewportSize({width: 375, height: 812}); await shot('actual-queue-375');
      runs[0].resolve({stopped: false}); await wait(() => runs.length === 2);
      await page.locator('.h24-user-bubble').filter({hasText: '忙碌时才进入队列'}).waitFor();
      await page.locator('.h24-queue-tray').waitFor({state: 'hidden'});
      const accepted = await call('flow.snapshot', {id});
      assert.deepEqual(accepted.timeline.filter(item => item.kind === 'user').map(item => item.text), ['空闲发送直接上屏', '忙碌时才进入队列']);
      check('actual busy queue stays visible until FIFO dispatch, then becomes exactly one user message');

      await input.fill('排队后撤回不会变回消息'); await send.click();
      await page.locator('.h24-queue-text').filter({hasText: '排队后撤回不会变回消息'}).waitFor();
      await wait(async () => await input.inputValue() === '');
      await page.getByRole('button', {name: '撤回这条', exact: true}).click();
      await page.locator('.h24-queue-tray').waitFor({state: 'hidden'});
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '排队后撤回不会变回消息'}).count(), 0);
      check('withdrawing a Host-queued input does not resurrect its optimistic message');

      await page.getByRole('button', {name: '停止任务', exact: true}).click();
      const resume = page.getByRole('button', {name: '继续任务', exact: true});
      await resume.waitFor();
      for (const width of [375, 414, 768, 1440]) {
        await page.setViewportSize({width, height: 812});
        assert.equal(await resume.evaluate(button => !!button.closest('.composer-surface, .mobile-composer')), false);
        const buttonBox = await resume.boundingBox(), composerBox = await page.locator('.composer-surface').boundingBox();
        assert.ok(buttonBox.y + buttonBox.height <= composerBox.y, 'continue button must sit above the bordered composer');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await shot(`continue-outside-${width}`);
      }
      await page.setViewportSize({width: 375, height: 812});
      holdSend = true; await resume.click(); await wait(() => !!releaseSend);
      await page.locator('.h24-user-bubble').filter({hasText: /^继续$/}).waitFor();
      assert.equal(await resume.count(), 0, 'a slow continue must not leave a second continue action');
      await shot('continuing-375');
      holdSend = false; releaseSend(); releaseSend = null;
      await wait(() => runs.length === 3);
      await page.getByRole('button', {name: '停止任务', exact: true}).waitFor();
      check('stopped task offers one continue action outside and above the composer; clicking immediately shows its message and resumes once');

      networkDown = true; await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await input.fill('离线消息仍然可见'); await send.click();
      await page.locator('.h24-queue-text').filter({hasText: '离线消息仍然可见'}).waitFor(); await shot('offline-375');
      const sends = requests.filter(item => item.method === 'flow.command' && item.params.command.type === 'send');
      assert.equal(sends.length, 4);
      await page.getByRole('button', {name: '撤回这条', exact: true}).click();
      await page.locator('.h24-queue-tray').waitFor({state: 'hidden'});
      check('offline local outbox remains visible and cancellable without transmitting');

      networkDown = false; failSend = true; await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await wait(() => requests.some(item => item.method === 'flow.snapshot' && item.params.id === id));
      await page.waitForTimeout(250);
      await input.fill('结果不明时仍可核对'); await send.click();
      await page.getByText('投递结果不明，待核对', {exact: true}).waitFor();
      await page.getByRole('button', {name: '核对结果', exact: true}).click();
      await page.waitForTimeout(150);
      assert.equal(requests.filter(item => item.method === 'flow.command' && item.params.command.type === 'send').length, 5);
      assert.equal(await input.inputValue(), '结果不明时仍可核对'); await shot('unknown-375');
      check('unknown delivery stays visible with its draft and read-only reconciliation does not replay the send');
      await page.emulateMedia({colorScheme: 'dark'}); await shot('system-dark-375');
      assert.deepEqual(result.errors, []);
      check('375/414/768/1440 layouts and system dark preference have no overflow or renderer errors');
    } catch (error) {result.error = error.stack; throw error;}
    finally {releaseSend?.(); await context.close(); await server.close(); await host.close(); await fs.rm(root, {recursive: true, force: true});}
  }
} finally {await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
