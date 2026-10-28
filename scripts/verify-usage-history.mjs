// Actual Electron renderer -> preload/IPC -> runtime journal projection.
// Synthetic journal facts only; no user configuration or external model credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import electronPath from 'electron';
import {initializeRuntimeStorage} from '../src/main/agent-runtime/storage-migration.mjs';

const {_electron} = await import(process.env.HEMI_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.HEMI_PLAYWRIGHT_MODULE).href : 'playwright-core');

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-usage-ui-'));
const output = path.join(repo, '.visual/workflow/vision/usage-history');
await fs.mkdir(output, {recursive: true});
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTree: true, environment: {node: process.version, platform: process.platform}, results: []};
let app, vite;
const wait = async (read, label) => {
  const end = Date.now() + 30000;
  while (!await read()) {
    assert.ok(Date.now() < end, 'Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
try {
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite'),
    logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await vite.listen();
  for (const mode of process.env.HEMI_VERIFY_MODE ? [process.env.HEMI_VERIFY_MODE] : ['dev', 'built']) {
    const profile = path.join(root, mode);
    await initializeRuntimeStorage({userDataDir: profile});
    const requests = {}, now = Date.now();
    for (let i = 0; i < 123; i++) {
      const startedAt = now - i * 3600000;
      const error = i % 3 === 0;
      requests['request-' + i] = {requestId: 'request-' + i,
        owner: {conversationId: 'isolated-usage', rootRunId: 'isolated-root', generation: 1},
        startedAt, endedAt: startedAt + 2000, firstOutputAt: startedAt + 500,
        actualModel: {model: i % 59 === 0 ? 'needle-model' : 'fixture-model', api: 'openai-completions', thinkingLevel: 'high'},
        role: 'main', purpose: 'main', httpStatus: error ? 500 : 200,
        url: 'https://fixture.invalid/v1/chat/completions?secret=DO_NOT_DISPLAY',
        tokenUsage: {uncachedInput: 100, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: null},
        error: error ? 'Synthetic failure' : null};
    }
    await fs.writeFile(path.join(profile, 'runtime-v2/run-journal.json'), JSON.stringify({
      version: 2, roots: {}, dispatches: {}, tasks: {}, inbox: {}, observations: {}, processes: {}, requests,
    }));
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', completedAt: now}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    app.process().stderr.on('data', chunk => { void fs.appendFile(path.join(output, mode + '-stderr.log'), chunk); });
    let page;
    await wait(() => {page = app.windows().find(page => /^(http|file):/.test(page.url()) && !new URL(page.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(20000);
    const result = {mode, checks: [], screenshots: [], errors: []}; report.results.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
    await page.getByRole('button', {name: '使用记录', exact: true}).click();
    await page.locator('.h37-usage-row').first().waitFor();
    assert.equal(await page.locator('.h37-usage-row').count(), 50);
    assert.equal((await page.evaluate(() => window.hemiVoice.getUsageHistory({}))).total, 123);
    result.checks.push('production navigation, preload, IPC and journal return 123 records');
    await page.getByRole('button', {name: '下一页', exact: true}).click();
    await wait(async () => (await page.locator('.h37-usage-pagination-info').innerText()).includes('51–100'), 'next page');
    await page.getByRole('textbox', {name: '搜索请求记录', exact: true}).fill('needle-model');
    await wait(async () => await page.locator('.h37-usage-row').count() === 3, 'search resets page');
    await page.getByRole('combobox', {name: '状态', exact: true}).selectOption('error');
    await wait(async () => await page.locator('.h37-usage-row').count() === 1, 'status filter');
    await page.locator('.h37-usage-row').first().focus(); await page.keyboard.press('Enter');
    await page.locator('.h37-usage-detail').waitFor();
    assert.ok((await page.locator('.h37-usage-detail').innerText()).includes('https://fixture.invalid/v1/chat/completions'));
    assert.ok(!(await page.locator('.h37-usage-detail').innerText()).includes('DO_NOT_DISPLAY'));
    assert.ok(await page.locator('.h37-usage-heatmap-week .h37-usage-heatmap-cell[data-level="0"]').count() > 70);
    result.checks.push('pagination, search reset, status filter, keyboard details, URL redaction, empty calendar days');
    await page.getByRole('button', {name: '清除搜索', exact: true}).click();
    await page.getByRole('combobox', {name: '状态', exact: true}).selectOption('all');
    await wait(async () => await page.locator('.h37-usage-row').count() === 50, 'clear filters');

    // 验证数字格式化：K/M/B 单位，避免1000K，精确值在 title
    const firstCell = page.locator('.h37-usage-td-right').first();
    const cellText = await firstCell.innerText();
    const cellTitle = await firstCell.getAttribute('title');
    assert.ok(cellText.match(/^\d+$|^\d+\.?\d*[KMB]$|^—$/), 'number format uses K/M/B');
    assert.ok(!cellText.includes('1000K') && !cellText.includes('1000M'), 'no 1000K or 1000M');
    if (cellTitle && cellTitle !== '—') {
      const numericTitle = Number(cellTitle.replace(/,/g, ''));
      assert.ok(!isNaN(numericTitle), 'title shows precise number');
    }
    result.checks.push('number formatting: compact K/M/B units, no 1000K, precise title');

    // 写入新的真实 journal 记录，再从主进程发出真实 IPC 广播。
    const firstRowBefore = await page.locator('.h37-usage-row').first().innerText();
    await page.evaluate(() => {
      window.__usageChangedReceived = false;
      const unsubscribe = window.hemiVoice.onUsageChanged(() => {
        window.__usageChangedReceived = true;
        unsubscribe();
      });
    });
    await app.evaluate(async ({BrowserWindow}, moduleUrl) => {
      const vm = process.getBuiltinModule('node:vm');
      const {getAgentRuntime} = await new vm.Script(`import(${JSON.stringify(moduleUrl)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }).runInThisContext();
      const runtime = getAgentRuntime();
      const owner = {conversationId: 'isolated-refresh', rootRunId: 'isolated-refresh-root', generation: 0};
      await runtime.journal.beginRoot(owner);
      await runtime.journal.requestStart(owner, {requestId: 'request-refresh-check', role: 'main', purpose: 'main',
        actualModel: {model: 'manual-refresh-fixture', api: 'openai-completions'}}, 5);
      await runtime.journal.requestEnd('request-refresh-check', {httpStatus: 200,
        tokenUsage: {uncachedInput: 100, output: 20, cacheRead: 0, cacheWrite: 0}});
      await runtime.journal.finishRoot(owner, 'completed');
      globalThis.__usageHistoryVerificationCalls = 0;
      const original = runtime.usageHistory;
      runtime.usageHistory = async options => {
        globalThis.__usageHistoryVerificationCalls += 1;
        // 让按钮禁用状态可观测，查询和投影仍调用实际服务。
        await new Promise(resolve => setTimeout(resolve, 150));
        return original(options);
      };
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('usage:changed', {conversationId: owner.conversationId});
    }, pathToFileURL(path.join(repo, 'src/main/ipc/llm.ipc.mjs')).href);
    await wait(() => page.evaluate(() => window.__usageChangedReceived), 'real usageChanged broadcast');
    await page.waitForTimeout(300);
    const firstRowAfter = await page.locator('.h37-usage-row').first().innerText();
    assert.equal(firstRowAfter, firstRowBefore, 'data unchanged after usageChanged event');
    assert.equal(await app.evaluate(() => globalThis.__usageHistoryVerificationCalls), 0, 'broadcast does not query history');
    result.checks.push('no auto-refresh: usageChanged event does not refresh data');

    // 验证手动刷新按钮：点击后loading状态出现并消失
    const refreshButton = page.getByRole('button', {name: '刷新数据', exact: true});
    assert.ok(await refreshButton.isVisible(), 'refresh button exists');

    await refreshButton.click();
    assert.equal(await refreshButton.isDisabled(), true, 'refresh disables duplicate clicks while loading');

    // 等待刷新完成
    await wait(async () => !(await refreshButton.isDisabled()), 'refresh completes');

    await wait(async () => (await page.locator('.h37-usage-row').first().innerText()).includes('manual-refresh-fixture'), 'new journal record rendered');
    assert.equal(await app.evaluate(() => globalThis.__usageHistoryVerificationCalls), 1, 'manual refresh queries the real service once');

    result.checks.push('manual refresh: button triggers reload, shows loading state, prevents double-click');

    // 验证热力图 Tooltip（鼠标悬浮）
    const heatmapCell = page.locator('.h37-usage-heatmap-cell').first();
    await heatmapCell.hover();
    await page.waitForSelector('.h37-tooltip', {timeout: 1000});
    const tooltipText = await page.locator('.h37-tooltip').innerText();
    assert.ok(tooltipText.includes('202') && (tooltipText.includes('请求') || tooltipText.includes('tokens')), 'heatmap tooltip shows date and metric');
    await page.mouse.move(0, 0); // 移开鼠标
    await page.waitForSelector('.h37-tooltip', {state: 'hidden', timeout: 1000});
    result.checks.push('heatmap tooltip: custom component with date/metric, hide on mouse leave');

    // 验证热力图 Tooltip（键盘 focus 和 Escape）
    await heatmapCell.focus();
    await page.waitForSelector('.h37-tooltip', {timeout: 1000});
    assert.ok(await page.locator('.h37-tooltip').isVisible(), 'tooltip visible on keyboard focus');
    const tooltipId = await page.locator('.h37-tooltip').getAttribute('id');
    const ariaDescribedby = await heatmapCell.getAttribute('aria-describedby');
    assert.ok(tooltipId && ariaDescribedby === tooltipId, 'tooltip has id and aria-describedby linkage');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.h37-tooltip', {state: 'hidden', timeout: 1000});
    result.checks.push('heatmap tooltip: keyboard focus support, aria-describedby, Escape dismisses');

    for (const width of [1440, 768, 375]) {
      await app.evaluate(({BrowserWindow}, width) => {
        const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
        win.setMinimumSize(300, 400); win.setContentSize(width, 900);
      }, width);
      await wait(() => page.evaluate(width => innerWidth === width, width), 'resize');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page overflow');
      assert.ok(await page.locator('.h37-usage-main').evaluate(element => Math.abs(element.getBoundingClientRect().right - innerWidth) <= 1), 'content fills workspace');
      const screenshot = mode + '-' + width + '.png';
      await page.screenshot({path: path.join(output, screenshot), animations: 'disabled'});
      result.screenshots.push(screenshot);
      await heatmapCell.hover();
      await page.locator('.h37-tooltip').waitFor();
      const tooltipScreenshot = mode + '-' + width + '-tooltip.png';
      await page.screenshot({path: path.join(output, tooltipScreenshot), animations: 'disabled'});
      result.screenshots.push(tooltipScreenshot);
      await page.mouse.move(0, 0);
      await page.locator('.h37-tooltip').waitFor({state: 'hidden'});
    }
    assert.deepEqual(result.errors, []);
    console.log('PASS ' + mode + ': ' + result.checks.join('; '));
    await app.close(); app = null;
  }
} catch (error) {
  if (app) {
    report.failure = {message: error.message, windows: app.windows().map(page => page.url())};
    for (const [index, page] of app.windows().entries()) await page.screenshot({path: path.join(output, 'failure-' + index + '.png')}).catch(() => {});
  }
  throw error;
} finally {
  await app?.close(); await vite?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, {recursive: true, force: true});
}
