// node scripts/verify-model-list.mjs [--dev-url=http://127.0.0.1:5189]
// Real Electron renderer → preload → production IPC/service → local HTTP fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import electronPath from 'electron';

const devUrl = process.argv.find(arg => arg.startsWith('--dev-url='))?.slice(10);
const mode = devUrl ? 'dev' : 'built';
const out = path.resolve('.visual/workflow/vision/model-list');
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-model-list-'));
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
const requests = [], checks = [], errors = [];
const longId = `team/${'model-with-a-long-id-'.repeat(6)}vision`;
let catalog = ['current-model', 'server-only-model', longId], status = 200;
const held = [];
const server = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
  if (request.url.endsWith('/models')) {
    const send = () => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { data: catalog.map(id => ({ id })) } : { error: { message: 'synthetic service failure' } }));
    };
    if (request.url.startsWith('/slow/')) held.push(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'stale-model' }] })); });
    else send();
    return;
  }
  const body = JSON.parse(raw || '{}');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'OK', tool_calls: [{ type: 'function', function: { name: 'hemi_connection_check', arguments: '{"ok":true}' } }] } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const count = () => requests.filter(item => item.url.endsWith('/models')).length;
const check = name => { checks.push(name); console.log(`PASS ${mode}: ${name}`); };
let app, passed = false, failure = '';
try {
  app = await _electron.launch({ executablePath: electronPath, args: ['scripts/lib/verify-model-list-app.mjs'], env: { ...process.env, HEMI_SMOKE_TEST: '1', HEMI_USER_DATA_DIR: userData, ...(devUrl ? { VITE_DEV_SERVER_URL: devUrl } : { VITE_DEV_SERVER_URL: '' }) } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.hemiVoice?.saveModelProfile && document.querySelector('button[aria-label="设置"]')));
  await page.addStyleTag({ content: '.h65-perf { display: none !important; }' });
  await page.evaluate(async baseUrl => {
    await window.hemiVoice.saveModelProfile({ name: '目录验证', baseUrl, api: 'openai-completions', models: [{ model: 'current-model' }] });
  }, `${origin}/v1`);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '模型与路由', exact: true }).click();
  await page.locator('.h37m-provider-row').filter({ hasText: '目录验证' }).click();
  await page.getByRole('button', { name: 'server-only-model', exact: true }).waitFor();
  assert.equal(count(), 1);
  assert.equal(await page.getByText('常用型号', { exact: true }).count(), 0);
  assert.equal(requests.find(item => item.url.endsWith('/models')).authorization, undefined);
  check('详情首次自动通过真实服务拉取，本地免 Key，不显示内置推荐');
  await page.getByRole('button', { name: 'server-only-model', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.h37m-fetch-list button')].some(button => button.textContent.includes('server-only-model') && button.disabled));
  assert.ok(await page.evaluate(async () => (await window.hemiVoice.listModelProfiles()).providers[0].models.some(model => model.model === 'server-only-model')));
  await page.getByRole('textbox', { name: '新型号 ID', exact: true }).fill('manual-model');
  await page.getByRole('textbox', { name: '新型号 ID', exact: true }).press('Enter');
  await page.locator('.h37m-model-row').filter({ hasText: 'manual-model' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.h37m-fetch-copy')?.textContent.includes('共 3 个'));
  assert.equal(count(), 1);
  check('点选与手填均保存真实目录，普通重渲染不重复拉取');

  for (const width of [1440, 768, 375]) {
    await app.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(300, 400); window.setContentSize(width, 1000); }, width);
    await page.locator('.h37m-model-browser').scrollIntoViewIfNeeded();
    const layout = await page.locator('.h37m-model-browser').evaluate(element => {
      const rect = element.getBoundingClientRect();
      const input = element.querySelector('input').getBoundingClientRect();
      const add = element.querySelector('.h37m-add-row button').getBoundingClientRect();
      return { overflow: element.scrollWidth > element.clientWidth + 1, controlsFit: input.left >= rect.left && add.right <= rect.right && input.right <= add.left, paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom), buttonsFit: [...element.querySelectorAll('button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= rect.left && r.right <= rect.right; }) };
    });
    assert.ok(!layout.overflow && layout.controlsFit && layout.buttonsFit && layout.paddingBottom >= 12, JSON.stringify({ width, layout }));
    await page.screenshot({ path: path.join(out, `${mode}-detail-${width}.png`) });
    await page.locator('.h37m-model-browser').screenshot({ path: path.join(out, `${mode}-model-browser-${width}.png`) });
    check(`详情 ${width}px 无溢出，长型号省略并可悬停查看，输入和按钮对齐`);
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.locator('.h37m-model-browser').screenshot({ path: path.join(out, `${mode}-dark-preference.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal((await page.evaluate(() => window.hemiVoice.setAppearance({ requestId: 'model-list-gold', skinId: 'cafe-gold', mode: 'light' }))).ok, true);
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'cafe-gold');
  await page.locator('.h37m-model-browser').screenshot({ path: path.join(out, `${mode}-gold-model-browser.png`) });
  check('金色皮肤沿用主题颜色与控件间距');
  for (const key of ['SYNTHETIC_FIRST_KEY', 'SYNTHETIC_REPLACEMENT_KEY']) {
    await page.locator('#h37m-key').fill(key);
    await page.locator('#h37m-key').press('Enter');
    const deadline = Date.now() + 10000;
    while (requests.findLast(item => item.url.endsWith('/models'))?.authorization !== `Bearer ${key}` && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(requests.findLast(item => item.url.endsWith('/models')).authorization, `Bearer ${key}`);
    await page.getByRole('button', { name: longId, exact: true }).waitFor();
  }
  check('新增和更换已存 Key 后自动重新获取，不沿用旧鉴权结果');
  status = 503;
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.locator('.h37m-model-browser [role="alert"]').waitFor();
  const afterFailure = count();
  await page.getByRole('textbox', { name: '新型号 ID', exact: true }).fill('still-manual');
  assert.equal(count(), afterFailure);
  assert.equal(await page.getByRole('button', { name: '添加', exact: true }).isEnabled(), true);
  status = 200; catalog = ['fresh-only-model'];
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: 'fresh-only-model', exact: true }).waitFor();
  assert.equal(await page.locator('.h37m-fetch-list button').count(), 1);
  check('失败不循环重试、保留手填入口，刷新替换旧目录');

  await page.locator('.h37-back').click();
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  await page.getByRole('radio', { name: /手动配置/ }).click();
  await page.getByRole('radio', { name: /DeepSeek/ }).click();
  assert.equal(await page.locator('.h37m-chips [aria-pressed]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '刷新列表', exact: true }).isDisabled(), true);
  await page.getByRole('radio', { name: /自定义/ }).click();
  catalog = ['fresh-only-model', longId];
  await page.locator('#h37m-add-name').fill('新服务');
  await page.locator('#h37m-add-key').fill('SYNTHETIC_TEST_KEY');
  await page.locator('#h37m-add-url').fill(`${origin}/slow/v1`);
  await page.waitForFunction(() => document.querySelector('.h37m-steps')?.textContent.includes('拉取中'));
  const untilHeld = Date.now() + 10000;
  while (!held.length && Date.now() < untilHeld) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(held.length);
  await page.locator('#h37m-add-url').fill(`${origin}/new/v1`);
  await page.getByRole('button', { name: 'fresh-only-model', exact: true }).waitFor();
  held.splice(0).forEach(send => send());
  // 让旧 HTTP 响应经过 IPC 回到 renderer，再确认它没有覆盖新结果。
  await page.waitForTimeout(200);
  await page.waitForFunction(() => !document.querySelector('.h37m-steps')?.textContent.includes('拉取中'));
  assert.equal(await page.getByRole('button', { name: 'stale-model', exact: true }).count(), 0);
  assert.equal(await page.locator('.h37m-chips [aria-pressed="true"]').count(), 0);
  assert.equal(requests.findLast(item => item.url === '/new/v1/models').authorization, 'Bearer SYNTHETIC_TEST_KEY');
  check('添加页无预选，地址和 Key 就绪后拉取，旧请求不会覆盖新目录');
  for (const width of [375, 768, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 1000), width);
    await page.locator('.h37m-chips').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.h37m-chips').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    assert.ok(await page.locator('.h37m-catalog-head > .h37-actions').evaluate(element => Number.parseFloat(getComputedStyle(element).gap) >= 8));
    await page.screenshot({ path: path.join(out, `${mode}-add-${width}.png`) });
  }
  check('添加页三个宽度下目录均不溢出');
  await page.getByRole('button', { name: 'fresh-only-model', exact: true }).click();
  await page.getByText('连接成功', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加 1 个模型', exact: true }).click();
  await page.locator('.h37m-provider-row').filter({ hasText: '新服务' }).waitFor();
  const saved = await page.evaluate(async () => (await window.hemiVoice.listModelProfiles()).providers.find(provider => provider.name === '新服务'));
  assert.deepEqual(saved.models.map(model => model.model), ['fresh-only-model']);
  check('服务返回的型号经真实连通测试、保存并回到供应商列表');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = error.message;
  const page = app?.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(out, `${mode}-failure.png`) }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-1800));
    console.error('HTTP routes:', requests.map(item => `${item.method} ${item.url}`));
  }
  throw error;
} finally {
  held.splice(0).forEach(send => send());
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(userData, { recursive: true, force: true });
  await fs.writeFile(path.join(out, `${mode}-result.json`), JSON.stringify({ passed, failure, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), environment: { platform: process.platform, node: process.version, mode }, checks, errors, gaps: ['HTTP provider is synthetic; no external credentials or provider availability tested.', 'Hemi uses fixed skin palettes; dark OS preference does not introduce a separate dark palette.'] }, null, 2));
}
