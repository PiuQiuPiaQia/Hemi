// 真实应用导航/IPC/flow + 隔离历史资源；仅模型边界使用本地可控流。
// VITE_DEV_SERVER_URL=http://127.0.0.1:5173 node scripts/verify-conversation-open-scroll.mjs
// npm run build && node scripts/verify-conversation-open-scroll.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createConversationStore } from '../src/main/history/conversation-store.mjs';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(existsSync(modulePath) ? pathToFileURL(modulePath).href : 'playwright');
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const out = path.resolve(process.env.HEMI_SCROLL_EVIDENCE ?? `.visual/workflow/vision/015-open-scroll/${mode}`);
const ud = mkdtempSync(path.join(os.tmpdir(), 'hemi-open-scroll-'));
mkdirSync(out, { recursive: true });
const checks = [], errors = [], samples = [];
let stream, requests = 0, electron, rendererUrl, page, cdp;
const recording = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests += 1;
  assert.equal(body.model, 'scroll-test');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: `scroll-${requests}`, object: 'chat.completion.chunk', model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  frame({ role: 'assistant', content: '滚动回归验证开始。\n\n' });
  stream = { append: text => frame({ content: text }), finish: () => {
    if (res.writableEnded) return;
    frame({}, 'stop'); res.end('data: [DONE]\n\n');
  } };
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
writeFileSync(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now(), updatedAt: Date.now() }));
writeFileSync(path.join(ud, 'text-model-profiles.json'), JSON.stringify({
  version: 3, defaultModelId: 'scroll/main', providers: [{ id: 'scroll', name: '滚动回归本地端点', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'scroll-test', thinkingLevel: 'default' }] }],
}));
const store = createConversationStore({ dir: path.join(ud, 'conversations') });
for (const [tag, count] of [['B', 6], ['A', 16]]) {
  const turns = Array.from({ length: count * 2 }, (_, i) => ({
    id: `scroll-${tag}-${i}`, author: i % 2 ? 'hemi' : 'user', createdAt: Date.now() - 100_000 + i * 1000,
    text: i % 2 ? `这是第 ${Math.floor(i / 2) + 1} 轮的历史回复。\n\n${'历史内容应该在打开时直接出现在正确位置。'.repeat(10)}\n\n本轮核对完成。` : `SCROLL_${tag} 第 ${Math.floor(i / 2) + 1} 轮，请继续核对。`,
  }));
  const id = `conv-scroll-${tag.toLowerCase()}`;
  assert.ok(store.saveSession({ id, turns, profileId: 'scroll/main', workspaceId: 'default' }).ok);
  assert.ok(store.renameSession(id, `滚动验证${tag}`).ok);
}
try {
  electron = await _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: ['.'],
    env: { ...process.env, HEMI_USER_DATA_DIR: ud, HEMI_LLM_API_KEY: 'local-dummy-key', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'scroll-test' },
  });
  const deadline = Date.now() + 30_000;
  while (!page && Date.now() < deadline) {
    page = electron.windows().find(p => (p.url().startsWith('http') || p.url().includes('index.html')) && !new URL(p.url()).searchParams.has('mode'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(page, '主窗口必须实际载入');
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.locator('.text-composer-input').waitFor();
  await electron.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(1, 1); win.setContentSize(1440, 900); win.show();
  });
  rendererUrl = page.url();
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', frame => {
    recording.push({ data: frame.data, timestamp: frame.metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1440, maxHeight: 900 });
  // rAF 在绘制前记录每个可见历史帧，捕获「最后已经到底，但中间滑过」的回归。
  await page.context().addInitScript(() => {
    window.__scrollFrames = [];
    const sample = () => {
      const viewport = document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
      const user = [...document.querySelectorAll('.h24-user-bubble')].at(-1)?.textContent;
      if (viewport && user) window.__scrollFrames.push({ user, top: viewport.scrollTop, distance: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const viewport = () => page.locator('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
  const position = () => viewport().evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, distance: el.scrollHeight - el.clientHeight - el.scrollTop }));
  const collect = async (name, tag, action) => {
    await page.evaluate(() => { window.__scrollFrames = []; });
    await action();
    await page.waitForFunction(tag => [...document.querySelectorAll('.h24-user-bubble')].at(-1)?.textContent.includes(`SCROLL_${tag}`), tag);
    await page.waitForTimeout(650);
    const frames = await page.evaluate(tag => window.__scrollFrames.filter(f => f.user.includes(`SCROLL_${tag}`)), tag);
    samples.push({ name, frames });
    check(name, frames.length > 5 && frames.every(f => Math.abs(f.distance) <= 1), { frames: frames.length, maxDistance: Math.max(...frames.map(f => Math.abs(f.distance))) });
  };
  const open = async tag => {
    if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.locator('.h24-sidebar-open').filter({ hasText: `滚动验证${tag}` }).click();
  };
  for (const width of [1440, 768, 375]) {
    await electron.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).setContentSize(width, 900), width);
    await collect(`${width} 重载首帧贴底`, 'A', () => page.reload());
    await viewport().hover(); await page.mouse.wheel(0, -350); await page.waitForTimeout(120);
    check(`${width} 确实上翻历史`, (await position()).distance > 100);
    await collect(`${width} 打开较短会话直接定位`, 'B', () => open('B'));
    await collect(`${width} 返回较长会话直接定位`, 'A', () => open('A'));
    check(`${width} 无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, `opened-${width}.png`) });
  }
  // 真正发送一轮并按需追加 provider 分片，验证跟随/暂停/恢复没有一起被禁用。
  await page.locator('.text-composer-input').fill('SCROLL_LIVE 检查流式跟随。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.conversation-list')?.textContent.includes('滚动回归验证开始'));
  assert.ok(stream, '必须已经发出真实 provider 请求');
  await page.waitForTimeout(650);
  const before = await position();
  const first = '第一段流式内容。\n\n'.repeat(18);
  stream.append(first);
  await page.waitForFunction(text => document.querySelector('.conversation-list')?.textContent.includes(text), '第一段流式内容');
  await page.waitForTimeout(650);
  check('流式增长仍跟随', (await position()).top > before.top && (await position()).distance <= 1);
  await viewport().hover(); await page.mouse.wheel(0, -300); await page.waitForTimeout(150);
  const reading = await position();
  assert.ok(reading.distance > 100, '必须已经离开底部');
  stream.append('第二段追加内容。\n\n'.repeat(12));
  await page.waitForFunction(() => document.querySelector('.conversation-list')?.textContent.includes('第二段追加内容'));
  await page.waitForTimeout(650);
  check('上翻后新分片保持阅读位置', Math.abs((await position()).top - reading.top) <= 1);
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  await page.waitForTimeout(650);
  check('回到底部恢复跟随', (await position()).distance <= 1);
  stream.finish();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await viewport().hover(); await page.mouse.wheel(0, -300); await page.waitForTimeout(150);
  const beforeSend = await position(), previousRequests = requests;
  assert.ok(beforeSend.distance > 100, '发送前必须处于回看历史的位置');
  await page.locator('.text-composer-input').fill('SCROLL_SEND 上翻后主动发送。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.h24-user-bubble')].at(-1)?.textContent.includes('SCROLL_SEND'));
  await page.waitForTimeout(650);
  check('主动发送后恢复贴底且已到 provider', requests > previousRequests && (await position()).distance <= 1 && (await position()).top > beforeSend.top);
  stream.finish();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.locator('.h24-user-message').last().hover();
  await page.getByRole('button', { name: '编辑这条消息', exact: true }).last().click();
  await page.getByRole('textbox', { name: '编辑消息', exact: true }).fill('SCROLL_EDIT 编辑并重新发送。');
  await page.getByRole('button', { name: '重新发送', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.h24-user-bubble')].at(-1)?.textContent.includes('SCROLL_EDIT'));
  await page.waitForTimeout(650);
  check('编辑重发正常贴底', requests > previousRequests + 1 && (await position()).distance <= 1);
  stream.finish();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  const saved = await page.evaluate(() => window.hemiVoice.openConversation('conv-scroll-a'));
  check('编辑内容实际入档', saved.turns.some(t => t.text === 'SCROLL_EDIT 编辑并重新发送。') && !saved.turns.some(t => t.text === 'SCROLL_SEND 上翻后主动发送。'));
  await collect('编辑后切走直接定位', 'B', () => open('B'));
  await collect('重开编辑后的会话首帧贴底', 'EDIT', () => open('A'));
  await collect('重载编辑后的会话首帧贴底', 'EDIT', () => page.reload());
  // 隐藏/重开真实窗口，历史不再走一次入场滚动。
  await electron.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.hide(); win.show();
  });
  await page.waitForTimeout(200);
  check('窗口重开仍贴底', (await position()).distance <= 1);
  check('renderer 无错误', errors.length === 0, errors);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  stream?.finish();
  if (electron) await electron.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ mode, rendererUrl, checks, errors, requests, samples }, null, 2));
  if (recording.length) {
    const framesDir = path.join(out, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const concat = recording.map((frame, i) => {
      const name = `frame-${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(path.join(framesDir, name), Buffer.from(frame.data, 'base64'));
      return `file 'frames/${name}'\nduration ${Math.max(0.01, (recording[i + 1]?.timestamp ?? frame.timestamp + 0.1) - frame.timestamp)}`;
    }).join('\n');
    writeFileSync(path.join(out, 'frames.txt'), concat);
    execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(out, 'frames.txt'), '-vf', 'scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', path.join(out, 'navigation.webm')], { stdio: 'ignore' });
  }
  rmSync(ud, { recursive: true, force: true });
}
assert.ok(checks.length >= 20 && checks.every(c => c.ok), '滚动验收未通过，见 results.json');
