// Isolated product regression: real app/renderer/IPC/runtime, local SSE provider only.
// VITE_DEV_SERVER_URL=http://127.0.0.1:5186 selects the StrictMode dev renderer.
// HEMI_PLAYWRIGHT_MODULE may point to an installed Playwright index.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/061-send-${mode}`);
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-061-send-'));
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
const requests = [], checks = [], errors = [], held = new Map();
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const wait = async (predicate, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`等待超时：${label}`);
};
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const marker = JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content ?? '').match(/ATTACH_[A-Z]+/)?.[0] ?? 'OTHER';
  const main = body.tools?.some(t => t.function?.name === 'task') === true;
  requests.push({ marker, main, body });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'attachment-test', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  frame({ role: 'assistant', content: '已收到。' });
  const done = () => { frame({ content: '检查完成。' }); frame({}, 'stop'); res.end('data: [DONE]\n\n'); held.delete(marker); };
  if (main) {
    held.set(marker, { done, res });
    res.on('close', () => { if (held.get(marker)?.res === res) held.delete(marker); });
  } else done();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(ud, 'text-model-profiles.json'), JSON.stringify({
  version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main',
  providers: [{ id: 'audit', name: '附件验证', api: 'openai-completions', baseUrl,
    models: [{ id: 'main', model: 'attachment-test', supportsVision: true, thinkingLevel: 'off' }] }],
}));

let electron, page, rendererUrl;
try {
  electron = await _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['.'],
    env: { ...process.env, HEMI_USER_DATA_DIR: ud, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'TEST_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'attachment-test' },
  });
  electron.process().stderr.on('data', data => fs.appendFileSync(path.join(evidence, 'stderr.log'), data));
  await wait(() => { page = electron.windows().find(p => /^(?:http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, '主窗口');
  rendererUrl = page.url();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const input = page.locator('textarea.text-composer-input');
  await input.waitFor();
  // Configure credentials through the public settings IPC, then reload the real view.
  await page.evaluate(async baseUrl => {
    await window.hemiVoice.saveModelProfile({ id: 'audit', name: '附件验证', api: 'openai-completions', baseUrl, apiKey: 'TEST_ONLY',
      models: [{ id: 'main', model: 'attachment-test', supportsVision: true, thinkingLevel: 'off' }], makeDefault: true });
  }, baseUrl);
  await page.reload(); await input.waitFor();
  const resize = width => electron.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(300, 400); win.setContentSize(width, 900); win.show();
  }, width);
  const paste = async color => {
    await input.focus();
    await input.evaluate((ta, color) => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 200);
      ctx.fillStyle = 'white'; ctx.fillRect(24, 24, 272, 152);
      ctx.fillStyle = color; ctx.font = '28px sans-serif'; ctx.fillText('HEMI 061', 80, 112);
      const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'test.png', { type: 'image/png' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, color);
    await wait(async () => await page.locator('.h24-attach-tray .h24-attach-thumb').count() === 1, '草稿缩略图');
  };
  const snapshot = () => page.evaluate(async () => {
    const { sessions } = await window.hemiVoice.listConversations();
    return sessions[0] ? window.hemiVoice.flowGetSnapshot(sessions[0].id) : null;
  });
  const bubble = page.locator('.h24-msg-attachment-image');
  await resize(1440);
  await paste('#247567');
  await input.fill('ATTACH_FIRST 看一下这张图');
  await page.screenshot({ path: path.join(evidence, 'before-send-1440.png') });
  await input.press('Enter');
  await wait(() => held.has('ATTACH_FIRST'), '首个真实模型请求已开始');
  await wait(async () => await input.inputValue() === '' && await bubble.count() === 1, '受理后消息气泡与空草稿');
  assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0, '发送成功后输入框不能残留历史图片');
  const firstSrc = await bubble.locator('img').getAttribute('src');
  assert.ok(firstSrc?.startsWith('data:image/'));
  const imageCount = request => {
    const content = request.body.messages.findLast(m => m.role === 'user')?.content;
    return Array.isArray(content) ? content.filter(p => p.type === 'image_url').length : 0;
  };
  assert.equal(imageCount(requests.find(r => r.main && r.marker === 'ATTACH_FIRST')), 1);
  check('受理后立即清空输入框图片，历史气泡与 provider 各保留一张');

  for (const width of [1440, 768, 375]) {
    await resize(width); await page.waitForTimeout(350);
    assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0);
    assert.ok(await input.isVisible());
    assert.ok(await page.locator('.text-composer-send').isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(evidence, `after-send-${width}.png`) });
  }
  await resize(1440); await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(evidence, 'after-send-1440-dark-preference.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  check('1440/768/375 与深色系统偏好下清理状态一致，无横向溢出（产品沿用浅色主题）');
  await bubble.click();
  await wait(() => page.locator('img.h24-preview-image').evaluateAll(imgs => imgs.some(img => img.naturalWidth === 320 && img.naturalHeight === 200)), '已发送图片仍能预览');
  await page.locator('img.h24-preview-image').waitFor({ state: 'visible' });
  await page.waitForTimeout(500); // Capture after the finite preview entry animation.
  await page.screenshot({ path: path.join(evidence, 'sent-preview-1440.png') });
  await page.getByRole('button', { name: '收起预览，返回对话' }).click();
  await bubble.click();
  await wait(() => page.locator('img.h24-preview-image').evaluateAll(imgs => imgs.some(img => img.naturalWidth === 320)), '关闭后重开预览');
  await page.getByRole('button', { name: '收起预览，返回对话' }).click();
  check('已发送图片可预览、关闭并再次打开');

  await input.fill('ATTACH_TEXT 下一条只有文字'); await input.press('Enter');
  await wait(async () => (await snapshot())?.pending.length === 1, '忙时纯文字入队');
  assert.equal((await snapshot()).pending[0].attachmentIds.length, 0);
  held.get('ATTACH_FIRST').done();
  await wait(() => held.has('ATTACH_TEXT'), '纯文字请求派发');
  const nextContent = requests.find(r => r.main && r.marker === 'ATTACH_TEXT').body.messages.findLast(m => m.role === 'user')?.content;
  assert.ok(typeof nextContent === 'string' || nextContent.every(p => p.type !== 'image_url'));
  check('下一条纯文字排队和实际 provider 请求均不重复携带旧图');
  await paste('#ad5e29');
  assert.notEqual(await page.locator('.h24-attach-tray img').getAttribute('src'), firstSrc);
  await input.fill('ATTACH_SECOND 第二张新图'); await input.press('Enter');
  await wait(async () => (await snapshot())?.pending.length === 1, '第二张图片入队');
  assert.equal((await snapshot()).pending[0].attachmentIds.length, 1);
  await wait(async () => await page.locator('.h24-attach-tray .h24-attach-card').count() === 0, '入队后草稿附件清理');
  held.get('ATTACH_TEXT').done();
  await wait(() => held.has('ATTACH_SECOND'), '第二张图片请求派发');
  assert.equal(imageCount(requests.find(r => r.main && r.marker === 'ATTACH_SECOND')), 1);
  held.get('ATTACH_SECOND').done();
  await wait(async () => (await snapshot())?.phase === 'idle', '全部回合收口');
  check('运行中粘贴新图只显示新草稿，入队清理且只发送一张新图');

  await page.reload(); await input.waitFor();
  await wait(async () => await bubble.count() === 2, '重载后恢复历史图片');
  assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0);
  await bubble.first().click();
  await wait(() => page.locator('img.h24-preview-image').evaluateAll(imgs => imgs.some(img => img.naturalWidth === 320)), '重载后仍可预览历史原图');
  await page.locator('img.h24-preview-image').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(evidence, 'reloaded-preview-1440.png') });
  check('重载后历史缩略图与原图预览保留，输入框无旧图');
  assert.deepEqual(errors, []);
  check('renderer 无 console error 或未捕获异常');
} finally {
  for (const { res } of held.values()) res.destroy();
  await electron?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({ mode, rendererUrl, userData: ud, checks, errors, requests: requests.map(({ marker, main }) => ({ marker, main })) }, null, 2));
}
console.log(`HEMI_061_SEND_RESULT=${JSON.stringify({ mode, checks: checks.length, errors, evidence })}`);
