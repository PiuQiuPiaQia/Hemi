// Actual renderer -> production IPC/controller/Pi -> local provider -> persisted flow.
// Run once with VITE_DEV_SERVER_URL and once against npm run build's renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/turn-error-retry/${mode}`);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-error-retry-${mode}-`));
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
fs.writeFileSync(path.join(userData, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
const report = { mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, checks: [], errors: [], screenshots: [] };
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const wait = async (predicate, label, timeout = 25000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(`Timed out: ${label}`);
};
const requests = [], held = new Set();
let failProvider = true;
const diagnostic = 'Connection error. ' + 'upstream connection closed; '.repeat(30) + 'END_OF_ORIGINAL_DIAGNOSTIC';
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const main = body.tools?.length > 0;
    if (main) requests.push(body);
    if (main && failProvider) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: diagnostic, type: 'api_error' } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'retry-check', model: body.model,
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: main ? '重试请求已到达实际模型边界。' : '重试验证' });
    const done = () => { if (!res.destroyed) { chunk({ content: '处理完成。' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); } held.delete(done); };
    if (main) { held.add(done); res.on('close', () => held.delete(done)); } else done();
  } catch (error) { report.errors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3,
  defaultModelId: 'retry/main', lastConversationModelKey: 'retry/main', providers: [{ id: 'retry', name: '重试验证', api: 'openai-completions', baseUrl,
    models: [{ id: 'main', model: 'retry-test', thinkingLevel: 'off', supportsVision: true }] }] }));
let app, page;
const input = () => page.locator('textarea.text-composer-input');
const retry = () => page.locator('.turn-error-retry');
const lastNotice = () => page.locator('.h24-hemi-message[data-error="true"] .turn-error-notice').last();
const release = () => { for (const done of [...held]) done(); };
const flow = cid => page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid), cid);
const findChat = marker => page.evaluate(async marker => (await window.hemiVoice.listConversations()).sessions.find(s => s.title.includes(marker)), marker);
const screenshot = async name => {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), scale: 'css' }); report.screenshots.push(`${name}.png`);
};
async function start() {
  app = await _electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env,
    HEMI_USER_DATA_DIR: userData, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'TEST_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'retry-test' } });
  await wait(() => { page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, 'main window');
  page.setDefaultTimeout(15000); report.rendererUrl = page.url();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.getByRole('button', { name: '对话', exact: true }).waitFor();
  if (!await input().isVisible()) await page.getByRole('button', { name: '对话', exact: true }).click();
  await input().waitFor();
}
async function resize(width) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(300, 400); win.setContentSize(width, 900); win.show();
  }, width);
  await page.waitForFunction(width => innerWidth === width, width);
  await page.mouse.move(width - 20, 450);
  await page.waitForTimeout(350); // Let the existing navigation drawer finish its finite resize transition.
}
async function submit(text) { await input().fill(text); await input().press('Enter'); }
async function openChat(marker) {
  const row = page.locator('.h24-sidebar-open').filter({ hasText: marker });
  if (!await row.isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await row.click(); await page.waitForFunction(marker => document.querySelector('.h24-user-bubble')?.textContent.includes(marker), marker);
}
async function waitFailure(cid) {
  await wait(async () => (await flow(cid))?.phase === 'idle' && Object.values((await flow(cid))?.runs ?? {}).at(-1)?.outcome === 'failed', 'failed run settled');
  await retry().waitFor(); assert.equal(await retry().count(), 1);
}
try {
  await start();
  await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ id: 'retry', name: '重试验证', api: 'openai-completions', baseUrl, apiKey: 'TEST_ONLY',
    models: [{ id: 'main', model: 'retry-test', thinkingLevel: 'off', supportsVision: true }], makeDefault: true }), baseUrl);
  await page.reload(); await input().waitFor(); await resize(1440);
  // Use the actual paste handler, registration IPC and renderer submit path.
  await input().evaluate(ta => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
    canvas.getContext('2d').fillRect(0, 0, 40, 30);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'original.png', { type: 'image/png' }));
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.locator('.h24-attach-tray .h24-attach-thumb').waitFor();
  await submit('RETRY_ALPHA 请检查原始附件');
  let chat; await wait(async () => { chat = await findChat('RETRY_ALPHA'); return !!chat; }, 'chat persisted');
  const cid = chat.id; await waitFailure(cid);
  const original = (await flow(cid)).timeline.find(item => item.kind === 'user');
  assert.equal(original.attachmentIds.length, 1);
  assert.equal(await page.locator('.h24-turn-error').count(), 0, 'same model error must not repeat above the composer');
  assert.equal(await lastNotice().locator('details[open]').count(), 0);
  assert.match(await lastNotice().innerText(), /连接模型失败/);
  assert.doesNotMatch(await lastNotice().innerText(), /END_OF_ORIGINAL_DIAGNOSTIC/);
  check('真实模型失败只显示一处简短提示，完整诊断默认折叠');
  for (const width of [1440, 768, 375]) {
    await resize(width); await lastNotice().scrollIntoViewIfNeeded();
    assert.ok(await retry().isEnabled());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(`error-${width}`);
  }
  const summary = lastNotice().locator('summary');
  await page.keyboard.press('Tab'); await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await lastNotice().locator('details[open]').count(), 1);
  assert.match(await lastNotice().locator('pre').innerText(), /END_OF_ORIGINAL_DIAGNOSTIC/);
  assert.ok(await lastNotice().locator('pre').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await screenshot('details-375'); await summary.press('Enter');
  check('1440/768/375 无横向溢出，键盘可展开与收起完整错误详情');
  await resize(1440); await page.emulateMedia({ colorScheme: 'dark' }); await screenshot('error-dark-preference');
  await page.emulateMedia({ colorScheme: 'light' });
  check('深色系统偏好下沿用产品声明的浅色主题');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  failProvider = false; await submit('RETRY_OTHER 另一个会话');
  await wait(() => held.size > 0, 'other conversation request'); release();
  await wait(async () => (await findChat('RETRY_OTHER'))?.status !== 'running', 'other conversation complete');
  await openChat('RETRY_ALPHA'); await retry().waitFor();
  await input().fill('尚未发送的草稿');
  const before = requests.length, runsBefore = Object.keys((await flow(cid)).runs).length;
  await retry().dblclick();
  await wait(() => held.size > 0, 'retry actually reaches provider');
  assert.equal(requests.length, before + 1, 'double click must submit exactly once');
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1)), /RETRY_ALPHA/);
  const current = await flow(cid), user = current.timeline.filter(item => item.kind === 'user').at(-1);
  assert.deepEqual(user.attachmentIds, original.attachmentIds);
  assert.equal(user.inputSource, 'text');
  assert.equal(Object.keys(current.runs).length, runsBefore + 1);
  assert.equal(current.pending.length, 0);
  const lastUser = requests.at(-1).messages.findLast(item => item.role === 'user');
  assert.equal(lastUser.content.filter(part => part.type === 'image_url').length, 1, 'original image must reach provider');
  assert.equal(await input().inputValue(), '尚未发送的草稿');
  release(); await wait(async () => (await flow(cid)).phase === 'idle', 'retried run completes');
  check('切走再回来重试实际执行，连点只提交一次，原附件送达模型且当前草稿保留');
  failProvider = true; await submit('RETRY_RELOAD 重载和重启后的重试'); await waitFailure(cid);
  await page.reload(); await input().waitFor(); await retry().waitFor();
  assert.equal(await page.locator('.h24-turn-error').count(), 0);
  check('renderer 重载后错误与可用重试入口从持久化 flow 恢复');
  await app.close(); app = null; await start(); await resize(1440); await retry().waitFor();
  failProvider = false; const restartBefore = requests.length;
  await page.keyboard.press('Tab'); await retry().focus(); await page.keyboard.press('Enter');
  await wait(() => held.size > 0, 'restart retry provider request');
  assert.equal(requests.length, restartBefore + 1);
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1)), /RETRY_RELOAD/);
  release(); await wait(async () => (await flow(cid)).phase === 'idle', 'restart retry complete');
  assert.equal(await retry().count(), 0, 'historical errors have no stale retry actions');
  await screenshot('retried-success');
  check('应用重启后键盘重试到达正确模型输入，成功后历史错误不显示过期重试按钮');
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error?.stack ?? error);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  throw error;
} finally {
  release(); await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ...report, requests: requests.length, userData }, null, 2));
}
