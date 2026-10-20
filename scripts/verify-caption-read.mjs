// 真实 Electron 主窗口 → 生产对话/UiState IPC → 字幕窗口；模型边界使用本机端点。
// 运行：node scripts/verify-caption-read.mjs；设置 VITE_DEV_SERVER_URL 可复验开发入口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron, chromium } = await import(fs.existsSync(modulePath) ? pathToFileURL(modulePath).href : 'playwright');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-caption-read-'));
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'build';
const evidence = path.resolve('.visual/workflow/vision', `caption-read-${mode}`);
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
let held = false;
const pending = [], requests = [], checks = [], errors = [];
const reply = '这是本次的新回复，查看后不再重复提示。';
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    const finish = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: reply }, null], [{}, 'stop']]) {
        res.write(`data: ${JSON.stringify({ id: 'caption-check', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    };
    if (held) pending.push(finish); else finish();
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main', providers: [{ id: 'audit', name: '字幕本机验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'caption-check', thinkingLevel: 'default' }] }] }));
const wait = async (fn, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`超时：${label}`);
};
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log(`✓ ${label}`); };
let app, browser;
const watched = new WeakSet();
function watch(page) {
  if (watched.has(page)) return;
  watched.add(page);
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
}
try {
  app = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['.'], cwd: process.cwd(), env: { ...process.env, HEMI_USER_DATA_DIR: userData, DOUBAO_API_KEY: 'isolated-caption-dummy', HEMI_LLM_API_KEY: 'local-dummy', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'caption-check' } });
  app.on('window', watch);
  const main = await app.firstWindow();
  watch(main);
  await main.waitForSelector('textarea.text-composer-input');
  const win = await app.browserWindow(main);
  const focus = () => win.evaluate(w => { w.show(); w.focus(); });
  const hide = () => win.evaluate(w => w.hide());
  const ui = () => main.evaluate(() => window.hemiVoice.getUiState());
  const send = async (text, away = false) => {
    await focus();
    held = away;
    await main.locator('textarea.text-composer-input').fill(text);
    await main.locator('.text-composer-send:not(.is-stop)').click();
    if (away) {
      await hide();
      held = false;
      pending.splice(0).forEach(f => f());
    }
    await wait(() => main.locator('.h24-hemi-message').filter({ hasText: reply }).count().then(n => n >= Number(text.slice(-1))), '回复落地');
    await wait(async () => !(await main.locator('.text-composer-send.is-stop, .text-composer-stop').count()), '回合收口');
    await wait(async () => (await ui()).recentLines.at(-1)?.author === 'hemi', '字幕状态同步');
  };
  await send('CAPTION_REQUEST_1');
  check('前台回复携带稳定身份并标为已读', Boolean((await ui()).recentLines.at(-1)?.id) && (await ui()).recentLines.at(-1).captionRead === true);
  await hide();
  await wait(() => app.windows().some(p => p.url().includes('mode=caption')), '字幕窗口创建');
  const caption = app.windows().find(p => p.url().includes('mode=caption'));
  const finalTexts = () => caption.locator('[data-final="true"]').allTextContents();
  await wait(async () => (await finalTexts()).length === 0, '已读消息不展示');
  check('主窗口隐藏后旧回复没有重播', (await finalTexts()).length === 0);
  await caption.screenshot({ path: path.join(evidence, 'read-hidden.png') });

  await send('CAPTION_REQUEST_2', true);
  await wait(async () => (await finalTexts()).some(t => t.includes(reply)), '未读回复显示');
  check('离开主窗口后收到的新回复可见', (await ui()).recentLines.at(-1).captionRead === false);
  await caption.waitForTimeout(350);
  await caption.screenshot({ path: path.join(evidence, 'unread-visible.png') });
  const secondId = (await ui()).recentLines.at(-1).id;
  await focus();
  await wait(async () => (await ui()).recentLines.at(-1).captionRead === true, '焦点即时已读');
  await hide();
  await wait(async () => (await finalTexts()).length === 0, '读后即时移除');
  check('打开主窗阅读再离开，回复立即移除', (await finalTexts()).length === 0);
  await caption.screenshot({ path: path.join(evidence, 'after-reading.png') });
  await caption.reload();
  await wait(async () => (await finalTexts()).length === 0, '字幕重载后不重播');
  check('字幕 renderer 重载后仍不重播已读消息', (await finalTexts()).length === 0);

  await send('CAPTION_REQUEST_3', true);
  await wait(async () => (await finalTexts()).some(t => t.includes(reply)), '相同文案的新消息显示');
  check('相同文案的另一条新回复仍然显示', (await ui()).recentLines.at(-1).id !== secondId);

  // 任务行保活时不能夹带已读／已淡出的文字；该项是组件场景验证。
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const fixture = await browser.newPage();
  watch(fixture);
  for (const width of [1440, 768, 375]) {
    await fixture.setViewportSize({ width, height: 760 });
    await fixture.goto(`${process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5173'}/fixtures.html?scene=caption-read`);
    await fixture.locator('.caption-task-row').waitFor();
    check(`任务进度继续可见且无已读正文 ${width}`, await fixture.locator('[data-final="true"]').count() === 0);
    await fixture.waitForTimeout(350);
    await fixture.screenshot({ path: path.join(evidence, `task-only-${width}.png`) });
  }
  await fixture.evaluate(async () => {
    const ui = await window.hemiVoice.getUiState();
    window.__hemiTestUiStatePush({ ...ui, recentLines: [{ id: 'new:reply', text: '新字幕只提示一次', author: 'hemi' }] });
  });
  await fixture.locator('[data-final="true"]').waitFor();
  await fixture.waitForTimeout(4800);
  check('任务仍在运行时已淡出的正文不再展示', await fixture.locator('[data-final="true"]').count() === 0 && await fixture.locator('.caption-task-row').count() === 1);
  await fixture.evaluate(async () => {
    const ui = await window.hemiVoice.getUiState();
    window.__hemiTestUiStatePush({ ...ui, elapsedSeconds: 99, recentLines: [{ id: 'new:reply', text: '新字幕只提示一次', author: 'hemi' }] });
  });
  check('耗时更新不重新点亮已淡出的正文', await fixture.locator('[data-final="true"]').count() === 0);
  await fixture.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await fixture.screenshot({ path: path.join(evidence, 'task-only-dark.png') });
  check('renderer 无异常', errors.length === 0);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ mode, mainUrl: main.url(), captionUrl: caption.url(), checks, requests: requests.length, errors }, null, 2));
  console.log(`CAPTION_READ_OK ${mode} ${checks.length} 项`);
} finally {
  pending.splice(0).forEach(f => f());
  await browser?.close();
  await app?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
