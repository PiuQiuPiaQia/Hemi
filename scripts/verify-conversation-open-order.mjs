// Real Electron renderer/preload/IPC and controller facts; isolated data, no model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { initializeRuntimeStorage, runtimeDataDir } from '../src/main/agent-runtime/storage-migration.mjs';
import { createConversationStore } from '../src/main/history/conversation-store.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-open-order-'));
const output = path.join(repo, '.visual/workflow/vision/conversation-open-order');
await fs.mkdir(output, { recursive: true });
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, results: [],
  boundary: 'Real renderer, preload, conversation IPC, store and controller; synthetic runtime facts, no external provider or device.',
};
const ids = ['conv-order-newest', 'conv-order-recent', 'conv-order-old'];
const names = { [ids[0]]: '最新会话', [ids[1]]: '稍早会话', [ids[2]]: '持续更新的旧会话' };
let app, vite;
try {
  vite = await createServer({ configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    const profile = path.join(root, mode);
    await initializeRuntimeStorage({ userDataDir: profile });
    const dir = path.join(runtimeDataDir(profile), 'conversations');
    const store = createConversationStore({ dir });
    const now = Date.now();
    for (const [index, id] of ids.entries()) {
      const at = now - [0, 3600000, 2 * 86400000][index];
      store.saveSession({ id, now: at, turns: [{ id: `input-${index}`, author: 'user', text: names[id], createdAt: at }] });
    }
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', completedAt: now }));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({ globalPushToTalkEnabled: false }));
    const env = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0' };
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = { mode, checks: [], screenshots: [], errors: [] }; report.results.push(result);
    app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env });
    app.process().stderr.on('data', chunk => { void fs.appendFile(path.join(output, `${mode}-stderr.log`), chunk); });
    let page;
    for (let attempt = 0; attempt < 300 && !page; attempt++) {
      page = app.windows().find(win => /^(http|file):/.test(win.url()) && !new URL(win.url()).searchParams.has('mode'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, 'main window');
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
    await page.locator('textarea.text-composer-input').waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
      win.setMinimumSize(300, 400); win.setContentSize(1440, 900); win.show();
    });
    const rows = () => page.locator('.h24-sidebar-open .h24-sidebar-item-text').allTextContents();
    const expectOrder = async order => {
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.h24-sidebar-open .h24-sidebar-item-text')].map(row => row.textContent)) === JSON.stringify(expected), order.map(id => names[id]));
      assert.deepEqual(await rows(), order.map(id => names[id]));
    };
    const readList = () => page.evaluate(() => window.hemiVoice.listConversations());
    const invokeMain = async action => app.evaluate(async (_, { moduleUrl, action }) => {
      const vm = process.getBuiltinModule('node:vm');
      const serviceModule = await new vm.Script(`import(${JSON.stringify(moduleUrl)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }).runInThisContext();
      const service = serviceModule.getConversationFlowService();
      const controller = service.controllerFor('conv-order-old');
      const at = Date.now();
      const apply = fact => { const result = controller.applyFact(fact); if (!result.applied) throw new Error(JSON.stringify(result)); };
      if (action === 'start') {
        apply({ type: 'run-preparing', runId: 'order-stream', source: 'event', at });
        apply({ type: 'run-started', runId: 'order-stream', at });
        apply({ type: 'part-appended', runId: 'order-stream', part: { kind: 'text', partId: 'stream-text', content: '正在持续更新。' } });
      } else if (action === 'finish') {
        apply({ type: 'run-closed', runId: 'order-stream', outcome: 'completed', at });
      } else {
        for (let i = 0; i < 30; i++) apply({ type: 'part-updated', runId: 'order-stream', partId: 'stream-text', patch: { content: `持续更新 ${action}-${i}` } });
      }
      await service.store.flush('conv-order-old');
    }, { moduleUrl: pathToFileURL(path.join(repo, 'src/main/services/conversation-flow-service.mjs')).href, action });
    await expectOrder(ids);
    const original = (await readList()).sessions.find(session => session.id === ids[2]);
    await invokeMain('start');
    await page.waitForFunction(() => [...document.querySelectorAll('.h24-sidebar-open')].some(row => row.textContent.includes('持续更新的旧会话') && row.querySelector('[data-status="running"]')));
    await invokeMain('background');
    await expectOrder(ids);
    result.checks.push('running status and background streaming keep the original order');

    await page.locator('.h24-sidebar-open').filter({ hasText: names[ids[2]] }).click();
    await expectOrder(ids);
    await page.waitForFunction(() => document.querySelector('.h24-conversation-title')?.textContent === '持续更新的旧会话');
    const opened = (await readList()).sessions.find(session => session.id === ids[2]);
    assert.equal(opened.updatedAt, original.updatedAt, 'opening leaves content timestamp intact');
    assert.ok(!(await page.locator('.h24-sidebar-group').first().innerText()).includes('持续更新的旧会话'));
    assert.equal('lastOpenedAt' in opened, false);
    result.checks.push('opening an old running conversation does not promote it or change its date');

    await page.locator('.h24-sidebar-open').filter({ hasText: names[ids[0]] }).click();
    await expectOrder(ids);
    await invokeMain('after-switch');
    // Exercise the production host archive append as well as flow events.
    const appendArchive = async id => app.evaluate(async (_, { moduleUrl, id }) => {
      const vm = process.getBuiltinModule('node:vm');
      const { persistConversationTurns } = await new vm.Script(`import(${JSON.stringify(moduleUrl)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }).runInThisContext();
      const result = persistConversationTurns(id, [{ id: 'late-result', author: 'hemi', text: '后台的新结果', createdAt: Date.now() }]);
      if (!result.ok) throw new Error('host archive append failed');
    }, { moduleUrl: pathToFileURL(path.join(repo, 'src/main/ipc/conversation.ipc.mjs')).href, id });
    await appendArchive(ids[2]);
    await invokeMain('finish');
    await page.waitForFunction(() => [...document.querySelectorAll('.h24-sidebar-open')].some(row => row.textContent.includes('持续更新的旧会话') && row.querySelector('[data-status="unread"]')));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expectOrder(ids);
    assert.ok(!(await page.locator('.h24-sidebar-group').first().innerText()).includes('持续更新的旧会话'));
    result.checks.push('background tokens, host saves, completion, unread and focus refresh do not reorder or change date groups');

    // Another conversation has a later real update: opening the target must place it in the middle.
    await page.waitForTimeout(10);
    await appendArchive(ids[0]);
    const updated = (await readList()).sessions;
    const targetTime = updated.find(session => session.id === ids[2]).updatedAt;
    assert.ok(targetTime > original.updatedAt);
    assert.ok(updated.find(session => session.id === ids[0]).updatedAt > targetTime);
    await page.locator('.h24-sidebar-open').filter({ hasText: names[ids[2]] }).click();
    const stable = [ids[0], ids[2], ids[1]];
    await expectOrder(stable);
    assert.equal((await readList()).sessions.find(session => session.id === ids[2]).updatedAt, targetTime);
    assert.ok((await page.locator('.h24-sidebar-group').first().innerText()).includes('持续更新的旧会话'));
    result.checks.push('opening refreshes order and groups by real update time; the selected conversation belongs in the middle');

    await page.reload();
    await page.locator('textarea.text-composer-input').waitFor();
    await expectOrder(stable);
    assert.equal((await readList()).sessions.find(session => session.id === ids[2]).updatedAt, targetTime);
    await page.evaluate(() => window.hemiVoice.openConversation('conv-order-recent'));
    await expectOrder(stable);
    result.checks.push('reload and read-only open preserve the saved order');

    // A current row click refreshes ordering without rehydrating or clearing its draft.
    await page.evaluate(async ids => window.hemiVoice.reorderConversations(ids), [ids[2], ids[0], ids[1]]);
    await expectOrder([ids[2], ids[0], ids[1]]);
    await page.locator('textarea.text-composer-input').fill('保留当前草稿');
    await page.locator('.h24-sidebar-open').filter({ hasText: names[ids[2]] }).click();
    await expectOrder(stable);
    assert.equal(await page.locator('textarea.text-composer-input').inputValue(), '保留当前草稿');
    result.checks.push('clicking the current row restores update-time order without clearing the draft');

    await page.getByRole('button', { name: '查看全部会话', exact: true }).click();
    await page.locator('.history-item-main').filter({ hasText: '稍早会话' }).click();
    await expectOrder(stable);
    result.checks.push('opening an older conversation from full history does not promote it');

    for (const width of [1440, 768, 375]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
        win.setContentSize(width, 900);
      }, width);
      await page.waitForFunction(width => innerWidth === width, width);
      if (width < 1000) {
        await page.getByRole('button', { name: '对话', exact: true }).hover();
        await page.locator('.h24-sidebar').waitFor({ state: 'visible' });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
      const file = `${mode}-${width}.png`;
      await page.screenshot({ path: path.join(output, file), animations: 'disabled' }); result.screenshots.push(file);
    }
    result.darkMode = 'Skipped: the current appearance runtime supports light mode only.';
    assert.deepEqual(result.errors, []);
    console.log(`PASS ${mode}: ${result.checks.join('; ')}`);
    await app.close(); app = null;
    assert.deepEqual(createConversationStore({ dir }).listSessions().sessions.map(session => session.id), stable);
    result.checks.push('saved order survives closing the application');
  }
  report.ok = true;
} catch (error) {
  report.failure = error.stack;
  for (const [index, page] of (app?.windows() ?? []).entries()) await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally {
  await app?.close(); await vite?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
