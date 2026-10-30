// Focused renderer-boundary regression; never connects to a real Bot or reads app data.
// node scripts/verify-bot-settings.mjs [--built]
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';

const built = process.argv.includes('--built');
const mode = built ? 'built' : 'dev';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, '.visual/bot-settings');
await mkdir(evidence, {recursive: true});
let server, directory, browser;
let base = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5199';
const checks = [], errors = [];
const baseLabels = ['通用', '语音与通话', '模型与路由', '电脑与浏览器', '联网搜索', '记忆', '技能中心'];
const labels = ['通用', '语音与通话', '模型与路由', '电脑与浏览器', '联网搜索', '记忆', '技能中心'];
const keys = ['general', 'voice', 'models', 'control', 'web', 'memory', 'skills'];
const check = name => {checks.push(name); console.log(`PASS ${mode}: ${name}`);};
try {
  if (built) {
    // Same production resolver and build transforms, with fixtures as the entry instead of index.html.
    // This is a renderer test, not a packaged Electron/SSH end-to-end test.
    directory = await mkdtemp(path.join(os.tmpdir(), 'hemi-bot-settings-built-'));
    const {build} = await import('vite');
    await build({configFile: path.join(root, 'vite.config.ts'), build: {
      outDir: directory,
      rollupOptions: {input: path.join(root, 'src/renderer/fixtures.html')},
    }});
    server = http.createServer(async (request, response) => {
      try {
        const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.resolve(directory, `.${name}`);
        if (!file.startsWith(directory + path.sep)) {response.writeHead(403); response.end(); return;}
        const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'};
        response.setHeader('content-type', mime[path.extname(file)] ?? 'application/octet-stream');
        response.end(await readFile(file));
      } catch {response.writeHead(404); response.end();}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch({headless: true, executablePath: process.env.HEMI_DESIGN_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.on('pageerror', error => errors.push(error.message));
  const open = async (key = 'general', state = 'online') => {
    await page.goto(`${base}/fixtures.html?scene=settings-bot&page=${key}&state=${state}`);
    await page.locator('.settings-shell[data-settings-environment="bot"]').waitFor();
    await page.getByRole('heading', {name: labels[keys.indexOf(key)], exact: true, level: 2}).waitFor();
  };
  const pick = async label => {
    if (await page.locator('.h37-settings-drawer-trigger').isVisible()) {
      await page.locator('.h37-settings-drawer-trigger').click();
      await page.getByRole('dialog', {name: '设置分类'}).getByRole('button', {name: label, exact: true}).click();
    } else {
      await page.getByRole('navigation', {name: '设置导航'}).getByRole('button', {name: label, exact: true}).click();
    }
    await page.getByRole('heading', {name: label, exact: true, level: 2}).waitFor();
  };
  const calls = () => page.evaluate(() => window.__botSettingsCalls ?? []);
  await open();
  assert.deepEqual(await page.getByRole('navigation', {name: '设置导航'}).locator('button').allTextContents(), labels);
  assert.equal(await page.getByRole('switch').count(), 0, 'general must not contain capability switches');
  check('本地与 Bot 同为七分类（含技能中心），通用不再混入能力设置');
  for (const label of labels) {
    await pick(label);
    if (label === '模型与路由') await page.getByRole('heading', {name: '浏览器决策模型（Jev）'}).waitFor();
    if (label === '电脑与浏览器') {
      await page.getByRole('switch', {name: '启用 Bot 浏览器控制', exact: true}).waitFor();
      assert.equal(await page.getByRole('switch', {name: '启用 Bot 联网检索'}).count(), 0);
      assert.equal(await page.getByLabel('Bot 浏览器决策接口地址').count(), 0);
      assert.equal(await page.getByRole('button', {name: '管理 Bot 技能'}).count(), 0, '技能入口应迁至独立分类');
    }
    if (label === '联网搜索') {
      await page.getByLabel('Bot Tavily API Key').waitFor();
      assert.equal(await page.getByRole('switch', {name: '启用 Bot 浏览器控制', exact: true}).count(), 0);
    }
    if (label === '记忆') await page.getByText('Bot 记忆（fixtures 桩）。').waitFor();
    if (label === '技能中心') {
      await page.locator('[aria-label="技能市场"]').waitFor();
      await page.getByText('nano-pdf').first().waitFor();
    }
    await page.screenshot({path: path.join(evidence, `${mode}-${keys[labels.indexOf(label)]}.png`)});
  }
  check('七分类可切换，操作/检索/决策/技能分别落位，记忆仍走远端桥');
  await pick('电脑与浏览器');
  await page.getByRole('button', {name: '配置决策模型 →'}).click();
  await page.getByRole('heading', {name: '模型与路由', exact: true, level: 2}).waitFor();
  await page.locator('#bot-browser-decision-form').waitFor();
  await page.getByRole('button', {name: '返回浏览器控制'}).click();
  await page.getByRole('heading', {name: '电脑与浏览器', exact: true, level: 2}).waitFor();
  check('决策模型在电脑与浏览器与模型与路由之间双向定位且默认展开');
  await pick('联网搜索');
  await page.getByLabel('Bot Tavily API Key').fill('fixture-search-key');
  await page.getByRole('button', {name: '保存', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Bot Tavily API Key"]')?.value === '');
  let updates = (await calls()).filter(call => call.method === 'capabilities.configure');
  assert.deepEqual(updates.at(-1).params, {config: {searchApiKey: 'fixture-search-key'}, expectedInstanceId: 'fixture-bot'});
  check('Tavily 保存仅提交本区块字段与 Bot 实例身份，成功后清空写入框');
  await pick('电脑与浏览器');
  const control = page.getByRole('switch', {name: '启用 Bot 浏览器控制', exact: true});
  await control.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="启用 Bot 浏览器控制"]')?.getAttribute('aria-checked') === 'false');
  await pick('联网搜索');
  await pick('电脑与浏览器');
  assert.equal(await control.getAttribute('aria-checked'), 'false');
  updates = (await calls()).filter(call => call.method === 'capabilities.configure');
  assert.deepEqual(updates.at(-1).params.config, {browserEnabled: false});
  check('操作开关保存后跨页重读保持，不覆盖其他能力配置');
  await page.getByRole('combobox', {name: '设置对象'}).selectOption('local');
  assert.equal(await page.getByRole('heading', {name: '电脑与浏览器', exact: true, level: 2}).count(), 1);
  assert.deepEqual(
    (await page.getByRole('navigation', {name: '设置导航'}).locator('button').allTextContents()).filter(item => item !== '日志文件'),
    baseLabels);
  await page.getByRole('combobox', {name: '设置对象'}).selectOption('bot');
  await control.waitFor();
  assert.equal(await control.getAttribute('aria-checked'), 'false');
  check('本地/Bot 切换保留当前分类且重新读取各自配置');
  await pick('技能中心');
  await page.getByRole('combobox', {name: '设置对象'}).selectOption('local');
  await page.getByRole('heading', {name: '技能中心', exact: true, level: 2}).waitFor();
  await page.locator('[aria-label="技能市场"]').waitFor();
  await page.getByText('nano-pdf').first().waitFor();
  check('技能中心为本地与 Bot 共有分类，切换设置对象保留当前分类');
  for (const key of ['control', 'web', 'models']) {
    await open(key, 'offline');
    for (const button of await page.getByRole('switch').all()) assert.equal(await button.isDisabled(), true);
    assert.equal((await calls()).filter(call => call.method === 'capabilities.configure').length, 0);
  }
  check('离线能力开关禁用且不发起配置写入');
  await open('web', 'save-error');
  await page.getByLabel('Bot Tavily API Key').fill('retry-fixture-key');
  await page.getByRole('button', {name: '保存', exact: true}).click();
  await page.getByRole('alert').filter({hasText: 'Bot 配置保存失败（测试）'}).waitFor();
  assert.equal(await page.getByLabel('Bot Tavily API Key').inputValue(), 'retry-fixture-key');
  check('保存失败保留编辑值并显示错误');
  await open('control', 'inspect-error');
  await page.getByRole('alert').filter({hasText: 'Bot 能力读取失败（测试）'}).waitFor();
  assert.equal(await page.getByRole('switch', {name: '启用 Bot 浏览器控制', exact: true}).isDisabled(), true);
  check('读取失败不允许盲写能力开关');
  await page.setViewportSize({width: 375, height: 812});
  await open();
  for (const label of labels) {
    await pick(label);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${label}`);
    await page.screenshot({path: path.join(evidence, `${mode}-375-${keys[labels.indexOf(label)]}.png`)});
  }
  check('375px 分类抽屉可切全部分类且无页面水平溢出');
  assert.deepEqual(errors, []);
  check('渲染运行无 pageerror');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, {recursive: true, force: true});
  const report = {mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim(), worktree: 'uncommitted', node: process.version, platform: process.platform, checks, errors,
    gaps: ['Fixture/bridge boundary only; no live Bot, SSH, OS authorization or packaged app installation regression.']};
  await writeFile(path.join(evidence, `${mode}-report.json`), JSON.stringify(report, null, 2));
}
