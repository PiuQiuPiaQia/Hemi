// 隔离 Electron renderer → 真实 preload / IPC → runtime journal。
// 仅合成 journal 事实，不读取用户配置、历史或外部模型凭据。
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
const output = path.join(repo, '.visual/workflow/vision/usage-history-filters');
await fs.mkdir(output, {recursive: true});
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  workingTree: true, environment: {node: process.version, platform: process.platform}, results: []};
const runtimeModule = pathToFileURL(path.join(repo, 'src/main/ipc/llm.ipc.mjs')).href;
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
        actualModel: {model: i === 122 ? 'historical-only-model' : i === 121 ? 'fixture-model-plus'
          : i % 59 === 0 ? 'needle-model' : 'fixture-model', api: 'openai-completions', thinkingLevel: 'high'},
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
    const result = {mode, checks: [], screenshots: [], errors: [],
      runtime: await app.evaluate(() => ({node: process.version, electron: process.versions.electron, chromium: process.versions.chrome}))};
    report.results.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
    // 记录真实查询；延迟/失败仅用于观察边界状态，成功查询始终调用实际投影。
    await app.evaluate(async (_, moduleUrl) => {
      const vm = process.getBuiltinModule('node:vm');
      const {getAgentRuntime} = await new vm.Script(`import(${JSON.stringify(moduleUrl)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }).runInThisContext();
      const runtime = getAgentRuntime();
      const original = runtime.usageHistory;
      globalThis.__usageQueries = [];
      runtime.usageHistory = async options => {
        globalThis.__usageQueries.push(options);
        if (globalThis.__usageFailNext) { globalThis.__usageFailNext = false; throw new Error('合成测试：暂时无法加载，请重试。'); }
        if (options.query === 'slow-no-match') await new Promise(resolve => setTimeout(resolve, 650));
        return original(options);
      };
    }, runtimeModule);
    const settled = () => wait(async () => !(await page.getByRole('button', {name: '刷新数据', exact: true}).isDisabled()), 'query settles');
    const latestQuery = () => app.evaluate(() => globalThis.__usageQueries.at(-1));
    const assertProjection = async label => {
      await settled();
      const query = await latestQuery();
      const response = await page.evaluate(query => window.hemiVoice.getUsageHistory(query), query);
      assert.equal(await page.locator('.h37-usage-row').count(), response.records.length, label + ': records');
      assert.equal(await page.locator('.h37-usage-stat-value').first().getAttribute('title'), response.totals.requests.toLocaleString(), label + ': requests');
      const tokenTotal = response.totals.input + response.totals.output + response.totals.cacheRead + response.totals.cacheWrite;
      assert.equal(await page.locator('.h37-usage-stat-value').nth(1).getAttribute('title'), tokenTotal.toLocaleString(), label + ': tokens');
      assert.deepEqual(await page.locator('#usage-model-filter option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), response.models, label + ': global models');
      return {query, response};
    };
    const preset = name => page.getByRole('group', {name: '日期范围', exact: true}).getByRole('button', {name, exact: true});
    const screenshot = async name => {
      await page.locator('.h37-usage-main').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({path: path.join(output, name), animations: 'disabled'});
      result.screenshots.push(name);
    };
    await page.getByRole('button', {name: '使用记录', exact: true}).click();
    await settled();
    assert.equal(await preset('今天').getAttribute('aria-pressed'), 'true');
    const localBounds = await page.evaluate(() => {
      const first = new Date(); first.setHours(0, 0, 0, 0);
      const next = new Date(first); next.setDate(next.getDate() + 1);
      const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const yesterday = new Date(first); yesterday.setDate(yesterday.getDate() - 1);
      return {from: first.getTime(), to: next.getTime() - 1, today: key(first), yesterday: key(yesterday),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone};
    });
    result.timezone = localBounds.timezone;
    const initial = await assertProjection('default today');
    assert.equal(initial.query.from, localBounds.from);
    assert.equal(initial.query.to, localBounds.to);
    assert.equal(initial.query.offset, 0);
    assert.ok(initial.response.total > 0 && initial.response.total < 50);
    assert.ok(initial.response.records.every(record => record.at >= localBounds.from && record.at <= localBounds.to));
    assert.ok(initial.response.models.includes('historical-only-model'));
    assert.equal(await page.locator('.h37-usage-heatmap').count(), 0, 'one day does not masquerade as 12 weeks');
    await screenshot(mode + '-today.png');
    result.checks.push('默认本地今天完整日界，统计与真实服务一致；短范围不显示误导性 12 周图');

    await page.getByRole('combobox', {name: '模型', exact: true}).selectOption('historical-only-model');
    await assertProjection('empty model today');
    assert.ok(await page.getByText('当前筛选下暂无记录', {exact: true}).isVisible());
    assert.ok(await preset('全部').isVisible());
    assert.ok(await page.getByRole('button', {name: '刷新数据', exact: true}).isEnabled());
    await screenshot(mode + '-empty-model-today.png');
    await preset('全部').click();
    await settled();
    assert.equal(await page.locator('.h37-usage-row').count(), 1, 'historical model recovers through date controls');
    await page.getByRole('combobox', {name: '模型', exact: true}).selectOption('fixture-model');
    const exactModel = await assertProjection('exact model');
    assert.equal(exactModel.query.model, 'fixture-model');
    assert.ok(exactModel.response.records.every(record => record.model === 'fixture-model'));
    assert.equal(exactModel.response.total, 118, 'exact model does not match fixture-model-plus');
    await page.getByRole('button', {name: '下一页', exact: true}).click();
    await settled();
    // native-input 策略：点过的控件不吃 Enter——键盘激活只属于键盘巡航模式
    // （src/renderer/src/lib/native-input.ts）。真实键盘用户先按方向键/Tab 进入
    // 巡航（html.kb-nav），Enter 才会激活按钮；只 focus()+Enter 会被按策略截掉。
    await preset('昨天').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const yesterday = await assertProjection('yesterday resets page');
    assert.equal(yesterday.query.offset, 0);
    assert.equal(yesterday.query.to, localBounds.from - 1);
    await page.getByRole('combobox', {name: '模型', exact: true}).selectOption('');
    await preset('近 7 天').click();
    const week = await assertProjection('last seven days');
    assert.equal(week.response.total, 123);
    assert.equal(week.query.to, localBounds.to);
    result.checks.push('模型精确匹配，选项跨日期/空结果/分页保留；昨天、近 7 天可组合且筛选归零分页');

    await preset('自定义').click();
    await page.getByLabel('开始日期', {exact: true}).fill(localBounds.today);
    await page.getByLabel('结束日期', {exact: true}).fill(localBounds.yesterday);
    const beforeInvalid = await app.evaluate(() => globalThis.__usageQueries.length);
    await page.getByRole('button', {name: '应用日期', exact: true}).click();
    assert.ok(await page.getByRole('alert').getByText('开始日期不能晚于结束日期。', {exact: true}).isVisible());
    assert.equal(await app.evaluate(() => globalThis.__usageQueries.length), beforeInvalid, 'invalid dates do not query');
    assert.equal(await page.getByLabel('开始日期', {exact: true}).getAttribute('aria-invalid'), 'true');
    await screenshot(mode + '-invalid-dates.png');
    await page.getByLabel('开始日期', {exact: true}).fill('');
    await page.getByRole('button', {name: '应用日期', exact: true}).click();
    assert.ok(await page.getByText('请选择开始日期和结束日期。', {exact: true}).isVisible());
    await page.getByLabel('开始日期', {exact: true}).fill(localBounds.yesterday);
    await page.getByRole('button', {name: '应用日期', exact: true}).click();
    const custom = await assertProjection('custom inclusive dates');
    assert.equal(custom.query.to, localBounds.from - 1);
    assert.equal(new Date(custom.query.from).getHours(), 0);
    await screenshot(mode + '-custom-dates.png');
    await preset('全部').click();
    await settled();
    assert.equal(await page.locator('.h37-usage-row').count(), 50);
    assert.equal((await page.evaluate(() => window.hemiVoice.getUsageHistory({}))).total, 123);
    await page.getByRole('button', {name: '下一页', exact: true}).click();
    await wait(async () => (await page.locator('.h37-usage-pagination-info').innerText()).includes('51–100'), 'next page');
    await page.getByRole('textbox', {name: '搜索请求记录', exact: true}).fill('needle-model');
    await settled();
    assert.equal(await page.locator('.h37-usage-row').count(), 3, 'search resets page');
    await page.getByRole('combobox', {name: '模型', exact: true}).selectOption('needle-model');
    await page.getByRole('combobox', {name: '状态', exact: true}).selectOption('error');
    const combined = await assertProjection('combined filters');
    assert.equal(combined.response.total, 1);
    await page.locator('.h37-usage-row').first().focus(); await page.keyboard.press('Enter');
    await page.locator('.h37-usage-detail').waitFor();
    assert.ok((await page.locator('.h37-usage-detail').innerText()).includes('https://fixture.invalid/v1/chat/completions'));
    assert.ok(!(await page.locator('.h37-usage-detail').innerText()).includes('DO_NOT_DISPLAY'));
    assert.ok(await page.locator('.h37-usage-heatmap-week .h37-usage-heatmap-cell[data-level="0"]').count() > 70);
    result.checks.push('自定义空值/倒序验证、含端点日期；原有分页/搜索/状态/键盘展开/URL脱敏/空日历回归');
    await page.getByRole('button', {name: '清除搜索', exact: true}).click();
    await page.getByRole('combobox', {name: '状态', exact: true}).selectOption('all');
    await page.getByRole('combobox', {name: '模型', exact: true}).selectOption('');
    await settled();

    // 延迟真实查询以观察旧结果隐藏及乱序响应隔离。
    await page.getByRole('textbox', {name: '搜索请求记录', exact: true}).fill('slow-no-match');
    await wait(async () => (await latestQuery()).query === 'slow-no-match', 'slow request started');
    assert.equal(await page.locator('.h37-usage-row').count(), 0);
    assert.equal(await page.locator('.h37-usage-heatmap').count(), 0);
    assert.equal(await page.locator('.h37-usage-stat-value').first().innerText(), '—');
    await page.getByRole('textbox', {name: '搜索请求记录', exact: true}).fill('needle-model');
    await settled();
    assert.equal(await page.locator('.h37-usage-row').count(), 3);
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.h37-usage-row').count(), 3, 'late stale response ignored');
    await app.evaluate(() => {globalThis.__usageFailNext = true;});
    await page.getByRole('combobox', {name: '状态', exact: true}).selectOption('running');
    await page.getByRole('button', {name: '重试', exact: true}).waitFor();
    assert.equal(await page.locator('.h37-usage-stat-value').first().innerText(), '—');
    await page.getByRole('button', {name: '重试', exact: true}).click();
    await settled();
    assert.ok(await page.getByText('当前筛选下暂无记录', {exact: true}).isVisible());
    await page.getByRole('button', {name: '清除搜索', exact: true}).click();
    await page.getByRole('combobox', {name: '状态', exact: true}).selectOption('all');
    await settled();
    result.checks.push('加载/刷新隐藏旧统计、表格和热力图；乱序查询不覆盖；错误可重试、空结果可恢复');

    const firstCell = page.locator('.h37-usage-td-right').first();
    const cellText = await firstCell.innerText();
    const cellTitle = await firstCell.getAttribute('title');
    assert.ok(cellText.match(/^[\d,]+(?:\.\d+)?(?:万|亿)?$|^—$/), 'number format uses incumbent Chinese units');
    assert.ok(!cellText.includes('10000万'), 'no 10000万');
    if (cellTitle && cellTitle !== '—') assert.ok(Number.isFinite(Number(cellTitle.replace(/,/g, ''))));
    result.checks.push('数字格式保留中文万/亿，title 显示精确数值');

    const firstRowBefore = await page.locator('.h37-usage-row').first().innerText();
    await page.evaluate(() => {
      window.__usageChangedReceived = false;
      const unsubscribe = window.hemiVoice.onUsageChanged(() => {window.__usageChangedReceived = true; unsubscribe();});
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
        await new Promise(resolve => setTimeout(resolve, 150));
        return original(options);
      };
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('usage:changed', {conversationId: owner.conversationId});
    }, runtimeModule);
    await wait(() => page.evaluate(() => window.__usageChangedReceived), 'real usageChanged broadcast');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.h37-usage-row').first().innerText(), firstRowBefore);
    assert.equal(await app.evaluate(() => globalThis.__usageHistoryVerificationCalls), 0);
    const refreshButton = page.getByRole('button', {name: '刷新数据', exact: true});
    await refreshButton.click();
    assert.equal(await refreshButton.isDisabled(), true);
    assert.equal(await page.locator('.h37-usage-stat-value').first().innerText(), '—');
    assert.equal(await page.locator('.h37-usage-row').count(), 0);
    await settled();
    assert.ok((await page.locator('.h37-usage-row').first().innerText()).includes('manual-refresh-fixture'));
    assert.equal(await app.evaluate(() => globalThis.__usageHistoryVerificationCalls), 1);
    assert.ok(await page.locator('#usage-model-filter option[value="manual-refresh-fixture"]').count());
    result.checks.push('usageChanged 不自动刷新；手动刷新只查询一次、禁用重复点击、更新全局模型');

    const heatmapCell = page.locator('.h37-usage-heatmap-week .h37-usage-heatmap-cell').first();
    await heatmapCell.hover();
    await page.waitForSelector('.h37-tooltip', {timeout: 3000});
    const tooltipText = await page.locator('.h37-tooltip').innerText();
    assert.ok(/\d{4}-\d{2}-\d{2}/.test(tooltipText) && (tooltipText.includes('请求') || tooltipText.includes('tokens')));
    await page.mouse.move(0, 0);
    await page.waitForSelector('.h37-tooltip', {state: 'hidden', timeout: 3000});
    await heatmapCell.focus();
    await page.waitForSelector('.h37-tooltip', {timeout: 3000});
    assert.equal(await heatmapCell.getAttribute('aria-describedby'), await page.locator('.h37-tooltip').getAttribute('id'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.h37-tooltip', {state: 'hidden', timeout: 3000});
    result.checks.push('热力图当前筛选及明确日期范围；tooltip 鼠标/键盘/aria 关联/Escape 回归');

    // 当前 appearance/schema.mjs 明确只接受 light；不以无效属性伪造“深色主题”。
    result.appearanceScope = '当前产品仅支持浅色主题；分别核验系统 light/dark 偏好仍遵循现有 light 外观。';
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({colorScheme: theme});
      const appearance = await page.evaluate(async () => ({
        snapshot: await window.hemiVoice.getAppearance(), mode: document.documentElement.dataset.colorMode,
      }));
      assert.equal(appearance.snapshot.resolvedMode, 'light');
      assert.equal(appearance.mode, 'light');
      for (const width of [1440, 768, 375]) {
        await app.evaluate(({BrowserWindow}, width) => {
          const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
          win.setMinimumSize(300, 400); win.setContentSize(width, 900);
        }, width);
        await wait(() => page.evaluate(width => innerWidth === width, width), 'resize');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page overflow');
        assert.ok(await page.locator('.h37-usage-main').evaluate(element => Math.abs(element.getBoundingClientRect().right - innerWidth) <= 1), 'content fills workspace');
        await screenshot(`${mode}-system-${theme}-${width}.png`);
        await preset('自定义').click();
        for (const label of ['开始日期', '结束日期']) {
          const field = page.getByLabel(label, {exact: true});
          assert.ok(await field.isVisible());
          assert.ok(await field.evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'date field fits');
        }
        await page.getByLabel('开始日期', {exact: true}).focus();
        assert.ok(await page.getByLabel('开始日期', {exact: true}).evaluate(element => element === document.activeElement));
        await screenshot(`${mode}-system-${theme}-${width}-custom.png`);
        await preset('今天').click();
        await settled();
        await screenshot(`${mode}-system-${theme}-${width}-today.png`);
        await preset('全部').click();
        await settled();
      }
    }
    result.checks.push('1440 / 768 / 375，系统浅/深色偏好下的现有浅色主题；日期/模型无页面溢出、标签与键盘焦点');

    // 仅改变隔离 renderer 的时钟；后端仍查询真实合成 journal。
    await page.clock.install({time: new Date(localBounds.to - 900)});
    await page.clock.pauseAt(new Date(localBounds.to - 800));
    await page.getByRole('button', {name: '返回对话', exact: true}).click();
    await page.getByRole('button', {name: '使用记录', exact: true}).click();
    await settled();
    assert.equal((await latestQuery()).from, localBounds.from);
    await page.clock.fastForward(1500);
    await wait(async () => (await latestQuery()).from === localBounds.to + 1, 'today rollover');
    await settled();
    assert.equal(await preset('今天').getAttribute('aria-pressed'), 'true');
    await preset('昨天').click();
    await settled();
    assert.equal((await latestQuery()).from, localBounds.from);
    const nextDayBounds = await page.evaluate(() => {
      const first = new Date(); first.setHours(0, 0, 0, 0);
      const next = new Date(first); next.setDate(next.getDate() + 1);
      return {from: first.getTime(), next: next.getTime()};
    });
    await page.clock.fastForward(await page.evaluate(next => next - Date.now() + 100, nextDayBounds.next));
    await wait(async () => (await latestQuery()).from === nextDayBounds.from, 'yesterday rollover');
    await settled();
    const focusBounds = await page.evaluate(() => {
      const first = new Date(); first.setHours(0, 0, 0, 0);
      const next = new Date(first); next.setDate(next.getDate() + 1); next.setHours(12);
      return {now: next.getTime(), yesterdayFrom: first.getTime()};
    });
    await page.clock.setSystemTime(new Date(focusBounds.now));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await wait(async () => (await latestQuery()).from === focusBounds.yesterdayFrom, 'wake/focus catches missed midnight');
    await settled();
    result.checks.push('renderer 假时钟跨午夜：今天/昨天自动滚动日界，切回窗口再次核对；无用户实例/系统时钟改动');
    assert.deepEqual(result.errors, []);
    console.log('PASS ' + mode + ': ' + result.checks.join('; '));
    await app.close(); app = null;
  }
} catch (error) {
  report.failure = {message: error.message, windows: app?.windows().map(page => page.url()) ?? []};
  if (app) for (const [index, page] of app.windows().entries()) await page.screenshot({path: path.join(output, 'failure-' + index + '.png')}).catch(() => {});
  throw error;
} finally {
  await app?.close(); await vite?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, {recursive: true, force: true});
}
