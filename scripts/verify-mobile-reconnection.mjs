// Actual Host and mobile renderer; the native RPC/network boundary is controlled to delay old failures.
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
const output = path.join(repo, '.visual/workflow/mobile-reconnection');
await fs.mkdir(output, {recursive: true});
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, command: 'node scripts/verify-mobile-reconnection.mjs',
  gaps: ['Native TLS, physical-device network switching and installing the updated iOS bundle are outside this renderer regression.'], sources: {}, results: []};
for (const name of ['apps/mobile/src/bot/realtime.ts', 'apps/mobile/src/bot/workspace-client.ts', 'packages/conversation-flow/src/core/conversation.ts', 'packages/conversation-flow/src/core/flow-replica.ts', 'scripts/verify-mobile-reconnection.mjs'])
  report.sources[name] = createHash('sha256').update(await fs.readFile(path.join(repo, name))).digest('hex');
const browser = await chromium.launch({executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
const wait = async predicate => {
  const until = Date.now() + 12000;
  while (!await predicate()) {assert.ok(Date.now() < until, 'reconnection condition timed out'); await new Promise(resolve => setTimeout(resolve, 20));}
};
try {
  for (const mode of ['dev', 'built']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-mobile-reconnection-'));
    process.env.HEMI_USER_DATA_DIR = path.join(root, 'userData');
    const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {},
      executorFactory: () => ({async run() {return {};}, async stop() {}, async close() {}})});
    const {instanceId} = await host.request('handshake');
    const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params});
    await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
    const {id} = await call('session.create');
    const options = {root: app, configFile: path.join(app, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error'};
    const server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
    const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, reducedMotion: 'reduce'});
    const result = {mode, checks: [], errors: [], screenshots: []}; report.results.push(result);
    const check = value => {result.checks.push(value); console.log('PASS', mode, value);};
    let networkDown = false, holdReads = false, streamOpens = 0;
    const held = [];
    try {
      if (mode === 'dev') await server.listen();
      await installMobileBotEvents(context, {...host, watch(...args) {streamOpens++; return host.watch(...args);}}, {offline: () => networkDown});
      await context.exposeBinding('__reconnectionRpc', async (_source, {method, params}) => {
        if (holdReads && ['snapshot', 'flow.snapshot'].includes(method)) {
          await new Promise(resolve => held.push({method, resolve}));
          return {ok: false, code: 'network', message: 'Previous network request failed late'};
        }
        if (networkDown) return {ok: false, code: 'network', message: 'Isolated offline transport'};
        try {return {ok: true, result: await host.request(method, params)};}
        catch (error) {return {ok: false, code: error.code ?? 'failed', message: error.message};}
      });
      await context.addInitScript(target => {
        window.CapacitorCustomPlatform = {name: 'ios'};
        window.Capacitor = {PluginHeaders: [{name: 'HemiBot', methods: ['restore', 'request'].map(name => ({name, rtype: 'promise'}))}],
          async nativePromise(_plugin, method, options) {
            if (method === 'restore') return {active: target};
            if (method === 'request') {
              const response = await window.__reconnectionRpc(options);
              if (!response.ok) throw Object.assign(new Error(response.message), {code: response.code});
              return response;
            }
            throw new Error('Unexpected bridge call');
          }};
      }, {endpoint: 'https://fixture.invalid', botInstanceId: instanceId, name: 'Reconnection verification'});
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      page.on('pageerror', error => result.errors.push(error.message));
      await page.goto(server.resolvedUrls.local[0]);
      const input = page.getByRole('textbox', {name: '消息', exact: true});
      const title = page.getByRole('button', {name: '选择模型', exact: true});
      const banner = page.getByText('Bot 连接已断开', {exact: true});
      await input.waitFor(); await wait(() => title.isEnabled());
      await input.fill('重连期间保留的草稿');
      await page.waitForTimeout(150);
      networkDown = true; holdReads = true;
      await wait(() => held.some(value => value.method === 'flow.snapshot'));
      await banner.waitFor();
      const offlineShot = path.join(output, `${mode}-offline.png`); await page.screenshot({path: offlineShot}); result.screenshots.push(offlineShot);
      check('sustained outage shows the banner after its foreground grace period');

      networkDown = false;
      const opens = streamOpens, before = Date.now();
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await wait(() => streamOpens > opens);
      await banner.waitFor({state: 'hidden', timeout: 1500});
      await wait(() => title.isEnabled());
      result.recoveryMs = Date.now() - before;
      assert.ok(held.some(value => value.method === 'snapshot'), 'old catalog request is still held');
      assert.ok(held.some(value => value.method === 'flow.snapshot'), 'old conversation request is still held');
      assert.equal(await input.inputValue(), '重连期间保留的草稿');
      check('authenticated ready hides the banner while both old read requests remain pending');

      holdReads = false;
      for (const request of held.splice(0)) request.resolve();
      await page.waitForTimeout(400);
      assert.equal(await banner.count(), 0); assert.equal(await title.isEnabled(), true);
      const recoveredShot = path.join(output, `${mode}-recovered.png`); await page.screenshot({path: recoveredShot}); result.screenshots.push(recoveredShot);
      await page.getByRole('button', {name: '发送消息', exact: true}).click();
      await wait(async () => (await call('flow.snapshot', {id})).timeline.some(item => item.kind === 'user'));
      const users = (await call('flow.snapshot', {id})).timeline.filter(item => item.kind === 'user');
      assert.deepEqual(users.map(item => item.text), ['重连期间保留的草稿']);
      check('late old failures do not restore offline state; the preserved draft reaches the Host exactly once');
      assert.deepEqual(result.errors, []);
    } catch (error) {result.error = error.stack; throw error;}
    finally {for (const request of held) request.resolve(); await context.close(); await server.close(); await host.close(); await fs.rm(root, {recursive: true, force: true});}
  }
} finally {await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
