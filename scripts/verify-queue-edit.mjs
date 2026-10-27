// Real desktop renderer/IPC/controller and mobile renderer/Bot Host. Isolated data only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer, preview} from 'vite';
import {_electron, chromium} from 'playwright-core';
import electronPath from 'electron';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..'), out = path.join(repo, '.visual/workflow/vision/queue-edit');
await fs.mkdir(out, {recursive: true});
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  date: new Date().toISOString(), node: process.version, environment: `${process.platform}/${process.arch}`,
  command: 'node scripts/verify-queue-edit.mjs', gaps: ['Mobile native RPC and model executor use fixtures; physical devices and SSH are outside this focused check.',
    'The current appearance system declares light mode only, so dark mode capture is not applicable.'], results: []};
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  while (!await predicate()) {assert.ok(Date.now() < deadline, `Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 40));}
};
let browser;
try {
  for (const mode of (process.env.HEMI_QUEUE_MODE ? [process.env.HEMI_QUEUE_MODE] : ['dev', 'built'])) for (const platform of (process.env.HEMI_QUEUE_PLATFORM ? [process.env.HEMI_QUEUE_PLATFORM] : ['desktop', 'mobile'])) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-queue-edit-'));
    process.env.HEMI_USER_DATA_DIR = path.join(root, 'profile');
    const result = {mode, platform, checks: [], errors: [], screenshots: []}; report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, platform, name);};
    let app, server, context, host, provider, page, cid, requests = 0;
    let releaseFirst;
    const gate = new Promise(resolve => {releaseFirst = resolve;});
    const runs = [];
    try {
      let flow, finishFirst;
      if (platform === 'desktop') {
        const userData = process.env.HEMI_USER_DATA_DIR; await fs.mkdir(userData, {recursive: true});
        provider = http.createServer(async (req, res) => {
          let raw = ''; for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw), main = body.tools?.length > 0;
          if (main && ++requests === 1) await gate;
          res.writeHead(200, {'content-type': 'text/event-stream'});
          const event = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id: 'queue-edit', model: body.model, choices: [{index: 0, delta, finish_reason}]})}\n\n`);
          event({role: 'assistant', content: main ? '隔离任务已完成。' : '队列编辑验证'}); event({}, 'stop'); res.end('data: [DONE]\n\n');
        });
        await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
        await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
        await fs.writeFile(path.join(userData, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
        await fs.writeFile(path.join(userData, 'text-model-profiles.json'), JSON.stringify({version: 3, defaultModelId: 'queue/main', lastConversationModelKey: 'queue/main',
          providers: [{id: 'queue', name: '隔离验证', api: 'openai-completions', baseUrl, models: [{id: 'main', model: 'queue', thinkingLevel: 'off'}]}]}));
        if (mode === 'dev') {server = await createServer({configFile: path.join(repo, 'vite.config.ts'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}}); await server.listen();}
        const env = {...process.env, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'SYNTHETIC_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'queue'};
        if (server) env.VITE_DEV_SERVER_URL = server.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
        app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
        await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
        await page.locator('textarea.text-composer-input').waitFor();
        await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({id: 'queue', name: '隔离验证', api: 'openai-completions', baseUrl,
          apiKey: 'SYNTHETIC_ONLY', models: [{id: 'main', model: 'queue', thinkingLevel: 'off'}], makeDefault: true}), baseUrl);
        await page.reload();
        flow = () => page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid), cid);
        finishFirst = async () => {releaseFirst(); await wait(async () => (await flow()).phase === 'idle', 'first task completes');};
      } else {
        host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {},
          executorFactory: () => ({run(spec) {requests++; return new Promise(resolve => runs.push({spec, resolve}));}, async stop() {runs.at(-1)?.resolve({stopped: true});}, async close() {runs.forEach(run => run.resolve({stopped: true}));}})});
        const {instanceId} = await host.request('handshake');
        const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params});
        await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
        cid = (await call('session.create')).id;
        const options = {root: path.join(repo, 'apps/mobile'), configFile: path.join(repo, 'apps/mobile/vite.config.ts'), cacheDir: path.join(root, 'cache'), logLevel: 'error'};
        server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
        if (mode === 'dev') await server.listen();
        browser ??= await chromium.launch({executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
        context = await browser.newContext({viewport: {width: 375, height: 812}, isMobile: true, hasTouch: true, reducedMotion: 'reduce'});
        await installMobileBotEvents(context, host);
        let withdrawals = 0;
        await context.exposeBinding('__queueEditRpc', async (_source, {method, params}) => {
          try {
            const value = await host.request(method, params);
            if (method === 'flow.command') result.lastCommand = {params, value};
            // A previous Host version acknowledges withdrawal without echoing input.
            if (method === 'flow.command' && params.command.restoreToDraft) {
              withdrawals++;
              if (withdrawals === 1) delete value.input;
              if (withdrawals === 2) return {ok: false, code: 'network', message: 'Synthetic lost withdrawal receipt'};
            }
            return {ok: true, result: value};
          } catch (error) {return {ok: false, code: error.code, message: error.message};}
        });
        await context.addInitScript(target => {
          window.CapacitorCustomPlatform = {name: 'ios'};
          window.Capacitor = {PluginHeaders: [{name: 'HemiBot', methods: ['restore', 'request'].map(name => ({name, rtype: 'promise'}))}], async nativePromise(_plugin, method, options) {
            if (method === 'restore') return {active: target};
            if (method === 'request') {const result = await window.__queueEditRpc(options); if (!result.ok) throw Object.assign(new Error(result.message), {code: result.code}); return result;}
            throw Error('Unexpected native call');
          }};
        }, {endpoint: 'https://127.0.0.1:29421', botInstanceId: instanceId, name: 'Queue edit verification'});
        page = await context.newPage(); await page.goto(server.resolvedUrls.local[0]);
        flow = () => call('flow.snapshot', {id: cid});
        finishFirst = async () => {runs[0].resolve({}); await wait(async () => (await flow()).phase === 'idle', 'first task completes');};
      }
      page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(error.message));
      const input = platform === 'desktop' ? page.locator('textarea.text-composer-input') : page.getByRole('textbox', {name: '消息', exact: true});
      const send = platform === 'desktop' ? page.locator('.text-composer-send[data-action="send"]') : page.locator('.send-control');
      const submit = () => platform === 'desktop' ? input.press('Enter') : send.click();
      await input.waitFor();
      await input.fill('QUEUE_EDIT 正在核对项目状态'); await submit();
      await wait(() => requests === 1, 'first execution');
      if (platform === 'desktop') cid = await page.evaluate(async () => (await window.hemiVoice.listConversations()).sessions.find(item => item.title.includes('QUEUE_EDIT')).id);
      const queuedText = '下载后，配置 nginx 启动这个项目，要求通过指定地址访问，并检查部署结果。';
      for (const text of [queuedText, '整理后续部署清单']) {await input.fill(text); await submit(); await wait(async () => await input.inputValue() === '', 'accepted draft');}
      await wait(async () => (await flow()).pending.length === 2, 'two queued entries');
      const before = await flow(), removedId = before.pending[0].inputId;
      const size = async width => {
        if (app) {await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows().find(w => /^(http|file):/.test(w.webContents.getURL()) && !new URL(w.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(300, 400); win.setContentSize(width, 900);}, width);}
        else await page.setViewportSize({width, height: 812});
        await page.waitForFunction(width => innerWidth === width, width);
        if (app && mode === 'dev') {
          const graph = page.getByRole('button', {name: '移动性能监控', exact: true}), box = await graph.boundingBox();
          if (box) {await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(100, 130, {steps: 5}); await page.mouse.up();}
        }
      };
      const shot = async name => {const file = `${mode}-${platform}-${name}.png`; await page.screenshot({path: path.join(out, file), animations: 'disabled'}); result.screenshots.push(file);};
      for (const width of [1440, 768, 375]) {await size(width); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot(`queue-${width}`);}
      await size(platform === 'desktop' ? 1440 : 375);
      await input.fill('保留的未发送草稿');
      await page.getByRole('button', {name: '编辑这条', exact: true}).first().click();
      await wait(async () => (await flow()).pending.length === 1 && (await input.inputValue()).includes(queuedText), 'withdraw into composer');
      assert.equal(await input.inputValue(), `${queuedText}\n\n保留的未发送草稿`);
      await wait(async () => await input.evaluate(node => node === document.activeElement), 'focus restored');
      assert.equal(await page.locator('.queue-composer-editing,.composer-editing,.h24-queue-status').count(), 0);
      assert.equal((await flow()).pending[0].state, 'pending'); assert.equal(requests, 1);
      assert.ok(!((await flow()).timeline.some(item => item.id === removedId)));
      await shot('editing'); check('edit removes entry and restores focused ordinary draft, preserving existing text');
      if (platform === 'desktop') {
        const file = `${mode}-desktop-composer.png`;
        await page.locator('.h24-composer').screenshot({path: path.join(out, file), animations: 'disabled'}); result.screenshots.push(file);
      } else check('previous Host withdrawal response preserves the local input snapshot');
      await input.fill('修改后主动重发'); await send.click();
      await wait(async () => (await flow()).pending.length === 2, 'explicit resend');
      const resent = await flow();
      assert.deepEqual(resent.pending.map(item => item.text), ['整理后续部署清单', '修改后主动重发']);
      assert.notEqual(resent.pending[1].inputId, removedId); assert.equal(requests, 1);
      check('explicit send creates a new queue entry at the tail');
      await page.getByRole('button', {name: '撤回这条', exact: true}).first().click();
      await wait(async () => (await flow()).pending.length === 1, 'withdraw other entry');
      await page.getByRole('button', {name: '编辑这条', exact: true}).click();
      await wait(async () => (await flow()).pending.length === 0 && await input.inputValue() === '修改后主动重发', 'take last entry');
      assert.equal(await page.locator('.h24-queue-tray').count(), 0);
      await finishFirst(); assert.equal(requests, 1); assert.equal(await input.inputValue(), '修改后主动重发');
      await shot('idle-draft'); check('taking last entry hides tray; active completion does not dispatch edited draft');
      if (platform === 'mobile') check('lost withdrawal acknowledgement still preserves unsent text');
      await page.reload(); await input.waitFor();
      await wait(async () => await input.inputValue() === '修改后主动重发', 'persisted ordinary draft');
      assert.equal(requests, 1); check('reload restores withdrawn text as unsent draft');
      await input.fill('用户确认后发送'); await submit();
      await wait(() => requests === 2, 'idle explicit send');
      if (platform === 'mobile') runs[1].resolve({});
      await wait(async () => (await flow()).phase === 'idle', 'final task completes');
      assert.equal((await flow()).timeline.filter(item => item.kind === 'user' && item.text === '用户确认后发送').length, 1);
      assert.deepEqual(result.errors, []); check('idle explicit send executes exactly once without renderer errors');
    } catch (error) {
      result.error = error.stack; result.executions = requests;
      if (host && cid) result.snapshot = await host.request('flow.snapshot', {instanceId: (await host.request('handshake')).instanceId, id: cid, requestId: randomUUID()}).catch(() => null);
      if (page) {result.body = await page.locator('body').innerText().catch(() => null); await page.screenshot({path: path.join(out, `${mode}-${platform}-failure.png`)}).catch(() => {});}
      throw error;
    } finally {
      releaseFirst(); runs.forEach(run => run.resolve({stopped: true}));
      await app?.close(); await context?.close(); await server?.close(); await host?.close();
      if (provider) {provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));}
      await fs.rm(root, {recursive: true, force: true});
    }
  }
} finally {
  await browser?.close();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
