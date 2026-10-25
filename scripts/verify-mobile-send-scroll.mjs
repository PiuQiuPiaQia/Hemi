// Actual mobile UI/client/Host/controller; synthetic native keyboard and model boundaries.
// Exercise long virtualized history while send, receipt and keyboard animation overlap.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..'), app = path.join(repo, 'apps/mobile');
const label = process.env.HEMI_SCROLL_LABEL ?? 'current';
const historyCount = Number(process.env.HEMI_SCROLL_HISTORY ?? 24);
const out = path.join(repo, '.visual/workflow/mobile-send-scroll', label);
await fs.mkdir(out, {recursive: true});
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, historyCount, sources: {}, results: [],
  gaps: ['Native keyboard notifications and model execution are fixtures. Actual controller preparation facts are replayed separately across the native event boundary; physical iPhone behavior requires device review.']};
for (const file of ['apps/mobile/src/app.tsx', 'apps/mobile/src/style.css', 'apps/mobile/src/host/app-viewport.ts',
  'packages/conversation-flow/src/core/presenter.ts', 'packages/conversation-flow/src/core/flow-timeline-view.ts',
  'packages/conversation-flow/src/components/virtual-transcript.tsx', 'packages/conversation-flow/src/components/turn-queue-tray.tsx',
  'src/main/services/conversation-controller.mjs', 'src/main/bot/host.mjs', 'scripts/verify-mobile-send-scroll.mjs'])
  report.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
const browser = await chromium.launch({executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
const wait = async predicate => {const end = Date.now() + 12000; while (!await predicate()) {assert.ok(Date.now() < end, 'Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20));}};
try {
  for (const mode of (process.env.HEMI_SCROLL_MODES ?? 'dev,built').split(',')) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-send-scroll-'));
    process.env.HEMI_USER_DATA_DIR = path.join(root, 'userData');
    let holdRun = false, sendDelay = 0, releaseRun, holdSend = false, releaseSend, firstTokenDelay = 0, eventDelay = 0;
    let flowService, preparingSnapshot, replayingPrepare;
    const live = [];
    const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {},
      executorFactory: services => {flowService = services.flowService; return {async run(spec, emit) {
        live.push({spec, emit});
        if (firstTokenDelay) await new Promise(resolve => setTimeout(resolve, firstTokenDelay));
        emit({type: 'part-appended', runId: spec.runId, generation: spec.generation,
          part: {kind: 'text', partId: spec.runId + '-text', content: `执行记录 ${live.length}\n\n${'保留历史阅读位置，查看最新消息与键盘收起后的布局。'.repeat(live.length % 4 + 2)}`}});
        if (holdRun) await new Promise(resolve => {releaseRun = resolve;});
        return {stopped: false};
      }, async stop() {releaseRun?.();}, async close() {releaseRun?.();}};}});
    const {instanceId} = await host.request('handshake');
    const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params});
    await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: '测试模型', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'SYNTHETIC_ONLY'}]});
    const {id} = await call('session.create');
    const controller = flowService.controllerFor(id);
    controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      if (eventDelay && snapshot.phase === 'preparing' && !snapshot.timeline.some(item => item.kind === 'user' && item.runId === snapshot.activeRunId))
        preparingSnapshot = structuredClone(snapshot);
    });
    for (let i = 0; i < historyCount; i++) {
      await call('flow.command', {id, command: {type: 'send', input: {inputId: randomUUID(), text: `历史消息 ${i + 1}：${'可变高度长文本。'.repeat(i % 3 + 3)}`, attachmentIds: []}}});
      await wait(async () => (await call('flow.snapshot', {id})).phase === 'idle');
    }
    const options = {root: app, configFile: path.join(app, 'vite.config.ts'), cacheDir: path.join(root, 'cache'), logLevel: 'error'};
    const server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, reducedMotion: 'no-preference'});
    const result = {mode, checks: [], errors: [], samples: [], screenshots: []}; report.results.push(result);
    let page;
    try {
      if (mode === 'dev') await server.listen();
      // Keep real Host facts in order, but expose the valid preparing snapshot for several
      // frames instead of relying on fast local persistence/network delivery to hide it.
      await installMobileBotEvents(context, {watch(options, receive, disconnected, identity) {
        let chain = Promise.resolve(), disposed = false;
        const release = host.watch(options, frame => {
          const delay = eventDelay;
          chain = chain.then(async () => {
            if (disposed) return;
            if (delay && frame.type === 'flow' && preparingSnapshot) {
              const snapshot = preparingSnapshot; preparingSnapshot = null;
              replayingPrepare = snapshot;
              // Replay the actual controller's preparing fact separately from the Host's
              // coalesced delivery, as can happen over a slow native event connection.
              receive({...frame, change: {kind: 'snapshot', snapshot}});
              await new Promise(resolve => setTimeout(resolve, 120));
              if (!disposed && page) {
                const file = path.join(out, `${mode}-preparing-${sendDelay}.png`);
                await page.screenshot({path: file}); result.screenshots.push(file);
              }
              await new Promise(resolve => setTimeout(resolve, 180));
              replayingPrepare = null;
            } else if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            if (!disposed) receive(frame);
          });
        }, disconnected, identity);
        return () => {disposed = true; release();};
      }});
      await context.exposeBinding('__scrollRpc', async (_source, {method, params}) => {
        if (method === 'flow.command' && params.command.type === 'send' && holdSend) await new Promise(resolve => {releaseSend = resolve;});
        if (method === 'flow.command' && params.command.type === 'send' && sendDelay) await new Promise(resolve => setTimeout(resolve, sendDelay));
        try {
          const result = await host.request(method, params);
          if (method === 'flow.command' && eventDelay) await new Promise(resolve => setTimeout(resolve, 650));
          if (method === 'flow.snapshot' && replayingPrepare) return {ok: true, result: replayingPrepare};
          return {ok: true, result};
        }
        catch (error) {return {ok: false, code: error.code ?? 'failed', message: error.message};}
      });
      await context.addInitScript(target => {
        window.__scrollErrors = [];
        window.addEventListener('error', event => window.__scrollErrors.push(event.message));
        const callbacks = new Map(); let sequence = 0;
        const emit = (eventName, keyboardHeight = 0) => {for (const item of callbacks.values()) if (item.eventName === eventName) item.callback({keyboardHeight});};
        window.__keyboard = {emit, closeOnSend: false};
        document.addEventListener('pointerdown', event => {
          if (!window.__keyboard.closeOnSend || !event.target.closest('.send-control')) return;
          document.activeElement?.blur(); emit('keyboardWillHide');
          setTimeout(() => emit('keyboardDidHide'), 250);
        }, true);
        window.CapacitorCustomPlatform = {name: 'ios'};
        window.Capacitor = {PluginHeaders: [{name: 'HemiBot', methods: ['restore', 'request'].map(name => ({name, rtype: 'promise'}))},
          {name: 'Keyboard', methods: [{name: 'addListener', rtype: 'callback'}, {name: 'removeListener', rtype: 'promise'}]}],
          nativeCallback(plugin, method, options, callback) {
            if (plugin !== 'Keyboard' || method !== 'addListener') throw new Error('Unexpected callback');
            const id = String(++sequence); callbacks.set(id, {eventName: options.eventName, callback}); return Promise.resolve(id);
          }, async nativePromise(plugin, method, options) {
            if (plugin === 'Keyboard' && method === 'removeListener') {callbacks.delete(options.callbackId); return {};}
            if (method === 'restore') return {active: target};
            if (method === 'request') {const response = await window.__scrollRpc(options); if (!response.ok) throw Object.assign(new Error(response.message), {code: response.code}); return response;}
            throw new Error('Unexpected native promise');
          }};
      }, {endpoint: 'https://127.0.0.1:29421', botInstanceId: instanceId, name: '滚动回归'});
      page = await context.newPage(); page.setDefaultTimeout(12000);
      result.navigations = [];
      page.on('framenavigated', frame => {if (frame === page.mainFrame()) result.navigations.push({url: frame.url(), time: Date.now()});});
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('console', item => {if (item.type() === 'error') result.errors.push(item.text());});
      await page.goto(server.resolvedUrls.local[0]);
      const input = page.getByRole('textbox', {name: '消息', exact: true}), send = page.locator('.send-control');
      const scroll = page.locator('.conversation-frame [data-slot="scroll-area-viewport"]');
      await input.waitFor(); await scroll.waitFor({state: 'attached'});
      const position = () => scroll.evaluate(el => ({top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight,
        distance: el.scrollHeight - el.clientHeight - el.scrollTop, pinned: document.querySelector('.jump-btn')?.dataset.visible === 'false',
        last: [...document.querySelectorAll('.h24-user-bubble')].at(-1)?.textContent}));
      const bottom = () => position().then(value => Math.abs(value.distance) < 3 && value.pinned);
      await wait(bottom);
      await page.evaluate(() => {
        window.__scrollFrames = [];
        const sample = () => {
          const el = document.querySelector('.conversation-frame [data-slot="scroll-area-viewport"]');
          if (el) window.__scrollFrames.push({time: performance.now(), top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight,
            distance: el.scrollHeight - el.clientHeight - el.scrollTop, pinned: document.querySelector('.jump-btn')?.dataset.visible === 'false',
            last: [...document.querySelectorAll('.h24-user-bubble')].at(-1)?.textContent,
            waiting: [...document.querySelectorAll('.h24-waiting-status')].map(node => {
              const row = node.closest('[data-virtual-row]'), user = [...document.querySelectorAll('.h24-user-bubble')].at(-1);
              const box = node.getBoundingClientRect(), userBox = user?.getBoundingClientRect();
              return {row: row?.dataset.virtualRow, index: Number(row?.dataset.index), top: box.top, bottom: box.bottom,
                transform: row?.style.transform, userRow: user?.closest('[data-virtual-row]')?.dataset.virtualRow,
                userIndex: Number(user?.closest('[data-virtual-row]')?.dataset.index), userBottom: userBox?.bottom,
                userTransform: user?.closest('[data-virtual-row]')?.style.transform};
            })});
          requestAnimationFrame(sample);
        }; requestAnimationFrame(sample);
      });
      const check = (name, detail) => {result.checks.push({name, detail}); console.log('PASS', mode, name);};
      const shot = async name => {const file = path.join(out, `${mode}-${name}.png`); await page.screenshot({path: file}); result.screenshots.push(file);};
      for (const [index, delay] of [0, 120, 400].entries()) {
        await input.click();
        await page.evaluate(() => {window.__keyboard.emit('keyboardWillShow', 344); window.__keyboard.emit('keyboardDidShow', 344);});
        await wait(async () => Math.abs(await page.locator('.mobile-shell').evaluate(el => el.getBoundingClientRect().height) - 500) < 1);
        await wait(bottom);
        const text = `发送并收起键盘 ${index + 1}\n${'输入框变高后发送。'.repeat(24)}`;
        await input.fill(text); await wait(bottom);
        await page.evaluate(() => {window.__scrollFrames = []; window.__keyboard.closeOnSend = true;});
        sendDelay = delay; firstTokenDelay = 650; eventDelay = 140; await send.click();
        await page.locator('.h24-user-bubble').filter({hasText: `发送并收起键盘 ${index + 1}`}).waitFor();
        await wait(async () => (await call('flow.snapshot', {id})).phase === 'idle');
        await page.waitForTimeout(1400);
        const after = await position(), frames = await page.evaluate(() => window.__scrollFrames);
        result.samples.push({name: `send-${delay}`, after, frames});
        const waiting = frames.flatMap(frame => frame.waiting ?? []);
        assert.ok(waiting.length > 5, 'First-token waiting state was not exercised');
        assert.equal(new Set(waiting.map(row => row.row)).size, 1, 'The waiting row changed identity before the first output');
        assert.deepEqual(waiting.filter(row => row.index <= row.userIndex || row.top < row.userBottom - 1), [],
          'Thinking status rendered above or over the new user message');
        check(`thinking stays below its user message on every frame with ${delay}ms acceptance`, {frames: waiting.length});
        await shot(`send-${delay}`);
        assert.ok(Math.abs(after.distance) < 3 && after.pinned, 'Send/keyboard collapse lost the end anchor: ' + JSON.stringify(after));
        check(`send and keyboard collapse stay pinned with ${delay}ms acceptance`, after);
      }
      if (process.env.HEMI_SCROLL_ONLY_SEND === '1') {
        result.errors.push(...await page.evaluate(() => window.__scrollErrors));
        assert.deepEqual(result.errors, []); check('renderer has no console or runtime errors');
        continue;
      }
      eventDelay = 0; firstTokenDelay = 0;
      await scroll.hover(); await page.mouse.wheel(0, -700); await page.waitForTimeout(350);
      const reading = await position(); assert.ok(reading.distance > 100 && !reading.pinned);
      await page.evaluate(() => {window.__keyboard.emit('keyboardWillShow', 344); window.__keyboard.emit('keyboardDidShow', 344);});
      await page.waitForTimeout(400);
      await page.evaluate(() => {window.__keyboard.emit('keyboardWillHide'); window.__keyboard.emit('keyboardDidHide');});
      await page.waitForTimeout(400);
      const restored = await position();
      assert.ok(Math.abs(restored.top - reading.top) < 3 && !restored.pinned, 'Keyboard resize stole the history position');
      check('keyboard show/hide preserves manual history reading', restored);
      await input.click();
      await page.evaluate(() => {window.__keyboard.emit('keyboardWillShow', 344); window.__keyboard.emit('keyboardDidShow', 344);});
      await page.waitForTimeout(350);
      await input.fill('从历史位置主动发送，回到最新消息'); sendDelay = 120; await send.click();
      await page.locator('.h24-user-bubble').filter({hasText: '从历史位置主动发送'}).waitFor();
      await wait(async () => (await call('flow.snapshot', {id})).phase === 'idle'); await page.waitForTimeout(700);
      assert.ok(await bottom()); check('an own send restores follow after history reading', await position());

      holdRun = true; firstTokenDelay = 0; sendDelay = 0; await input.fill('流式回复增长和队列布局回归'); await send.click();
      await wait(() => !!releaseRun); await wait(bottom);
      const active = live.at(-1);
      const append = text => active.emit({type: 'part-updated', runId: active.spec.runId, generation: active.spec.generation,
        partId: active.spec.runId + '-text', patch: {content: text}});
      append('持续增长的回复。\n\n'.repeat(45));
      await page.waitForTimeout(500); assert.ok(await bottom());
      check('an existing streaming row growing stays at the end', await position());

      await input.click();
      await page.evaluate(() => {window.__keyboard.emit('keyboardWillShow', 344); window.__keyboard.emit('keyboardDidShow', 344);});
      await page.waitForTimeout(350); await input.fill('排队确认期间手动上翻，不能再被拉回底部');
      holdSend = true; sendDelay = 0; await send.click();
      await page.locator('.h24-user-bubble').filter({hasText: '排队确认期间手动上翻'}).waitFor();
      await scroll.hover(); await page.mouse.wheel(0, -600); await page.waitForTimeout(150);
      const interrupted = await position(); assert.ok(!interrupted.pinned && interrupted.distance > 100, JSON.stringify(interrupted));
      holdSend = false; releaseSend(); releaseSend = null;
      await page.locator('.h24-queue-text').filter({hasText: '排队确认期间手动上翻'}).waitFor();
      await page.waitForTimeout(500);
      const afterQueue = await position();
      assert.ok(!afterQueue.pinned && afterQueue.distance > 100 && Math.abs(afterQueue.top - interrupted.top) < 3,
        'Host queue takeover overrode a manual gesture: ' + JSON.stringify({interrupted, afterQueue}));
      append('持续增长的回复。\n\n'.repeat(60)); await page.waitForTimeout(400);
      assert.ok(Math.abs((await position()).top - afterQueue.top) < 3);
      check('manual scrolling cancels follow through animation, Host queue takeover and subsequent stream growth', await position());

      sendDelay = 0;
      for (const text of ['队列里的长消息：检查下载、渲染与最终输出，确保正文有完整的阅读空间。', '另一条待发送消息，保留原来的执行顺序。']) {
        await input.fill(text); await send.click(); await wait(async () => await input.inputValue() === '');
      }
      await wait(async () => (await call('flow.snapshot', {id})).pending.length === 3);
      for (const width of [320, 375, 414]) {
        await page.setViewportSize({width, height: 844}); await page.waitForTimeout(300);
        const geometry = await page.locator('.h24-queue-item').first().evaluate(row => {
          const content = row.querySelector('.h24-queue-text').getBoundingClientRect(), actions = row.querySelector('.h24-queue-item-actions').getBoundingClientRect();
          const run = row.querySelector('.h24-queue-run');
          return {rowHeight: row.getBoundingClientRect().height, fontSize: getComputedStyle(row.querySelector('.h24-queue-text')).fontSize,
            headerHeight: row.closest('.h24-queue-tray').querySelector('.h24-queue-head').getBoundingClientRect().height, trayHeight: row.closest('.h24-queue-tray').getBoundingClientRect().height,
            textWidth: content.width, contentTop: content.top, contentBottom: content.bottom, contentHeight: content.height, actionsTop: actions.top, actionsBottom: actions.bottom,
            singleLine: getComputedStyle(row.querySelector('.h24-queue-text')).whiteSpace === 'nowrap', runLabelHidden: getComputedStyle(run.querySelector('span')).display === 'none', runLabel: run.getAttribute('aria-label'),
            targets: [...row.querySelectorAll('button')].filter(button => getComputedStyle(button).display !== 'none').map(button => {const box = button.getBoundingClientRect(); return {width: box.width, height: box.height};})};
        });
        assert.ok(geometry.textWidth >= 80 && geometry.singleLine && geometry.contentHeight < 25 && geometry.actionsTop <= geometry.contentTop && geometry.actionsBottom >= geometry.contentBottom, JSON.stringify(geometry));
        assert.ok(geometry.runLabelHidden && geometry.runLabel === '直接运行', JSON.stringify(geometry));
        assert.ok(geometry.targets.every(box => box.width >= 36 && box.height >= 36));
        (result.queueGeometry ??= []).push({width, ...geometry});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await shot(`queue-${width}`);
      }
      await page.setViewportSize({width: 390, height: 844});
      await input.click(); await page.evaluate(() => {window.__keyboard.emit('keyboardWillShow', 344); window.__keyboard.emit('keyboardDidShow', 344);});
      await page.waitForTimeout(350);
      assert.ok(await page.locator('.composer-surface').evaluate(node => node.getBoundingClientRect().bottom <= 501));
      assert.ok(await scroll.evaluate(node => node.clientHeight > 100));
      await shot('queue-keyboard-390');
      await page.locator('.h24-queue-head').click(); await page.waitForTimeout(350);
      assert.equal(await page.locator('.h24-queue-body').count(), 0);
      await page.locator('.h24-queue-head').click(); await page.waitForTimeout(250);
      await page.getByRole('button', {name: '编辑这条', exact: true}).first().click();
      await page.locator('.composer-editing').waitFor();
      assert.equal(await input.inputValue(), '排队确认期间手动上翻，不能再被拉回底部');
      await input.fill('从队列编辑后保存的完整消息'); await shot('queue-editing-390');
      await page.getByRole('button', {name: '保存修改', exact: true}).click();
      await page.locator('.h24-queue-text').filter({hasText: '从队列编辑后保存的完整消息'}).waitFor();
      await page.locator('.composer-editing').waitFor({state: 'hidden'});
      assert.equal(await input.inputValue(), '');
      check('compact mobile queue uses one line per message and icon-only run, preserves 36px controls and keyboard space, and supports collapse/edit/save');
      result.errors.push(...await page.evaluate(() => window.__scrollErrors));
      assert.deepEqual(result.errors, []);
      check('renderer has no console or runtime errors');
    } catch (error) {
      result.error = error.stack;
      if (page) {await page.screenshot({path: path.join(out, `${mode}-failure.png`)}).catch(() => {}); result.frames = await page.evaluate(() => window.__scrollFrames).catch(() => []);}
      throw error;
    } finally {releaseSend?.(); releaseRun?.(); await context.close(); await server.close(); await host.close(); await fs.rm(root, {recursive: true, force: true});}
  }
} finally {await browser.close(); await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
