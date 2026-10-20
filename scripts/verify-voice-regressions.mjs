// node scripts/verify-voice-regressions.mjs; VITE_DEV_SERVER_URL selects StrictMode dev.
// External boundaries only: silent microphone, local ASR WS and model SSE provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';

const { _electron } = await import(pathToFileURL(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/060-voice-${mode}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-voice-regression-'));
const ud = path.join(root, 'userData');
fs.mkdirSync(ud); fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
const requests = [], held = new Map(), errors = [], checks = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const wait = async (fn, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); }
  throw new Error(`等待超时：${label}`);
};
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const text = JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content ?? '');
  const marker = text.match(/VOICE_[A-Z]+/)?.[0] ?? 'VOICE_OTHER';
  const main = body.tools?.some(tool => tool.function?.name === 'task') === true;
  requests.push({ marker, main, model: body.model, body });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'voice-test', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (main && marker === 'VOICE_TOOL') {
    const args = { command: `printf '%s' $$ > '${path.join(root, 'tool.pid')}'; printf VOICE_TOOL_STARTED > '${path.join(root, 'tool-started')}'; sleep 8; printf VOICE_TOOL_LATE > '${path.join(root, 'tool-late')}'` };
    frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'voice-tool', type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) } }] });
    frame({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
  }
  frame({ role: 'assistant', content: `${marker} 回答开始。` });
  if (!main) { frame({}, 'stop'); res.end('data: [DONE]\n\n'); return; }
  held.set(marker, { done: () => { frame({ content: '回答完成。' }); frame({}, 'stop'); res.end('data: [DONE]\n\n'); held.delete(marker); }, res });
  res.on('close', () => { if (held.get(marker)?.res === res) held.delete(marker); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(ud, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main', providers: [{ id: 'audit', name: '隔离验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'voice-test', thinkingLevel: 'off' }] }] }));
const asr = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise(r => asr.on('listening', r));
let socket;
const asrFrame = (utterances, final = false) => {
  const body = Buffer.from(JSON.stringify({ result: { utterances } }));
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0x11, final ? 0x92 : 0x90, 0x10, 0]), size, body]);
};
asr.on('connection', ws => {
  socket = ws;
  ws.on('message', data => { if ((data[1] & 0xf) === 3) { ws.send(asrFrame([], true)); ws.close(); } });
});
const speech = (text, start, definite = false) => ({ text, start_time: start, end_time: start + 100, definite, additions: definite ? { speaker_id: '1' } : {} });
const emit = utterances => socket.send(asrFrame(utterances));
let electron, page, cdp;
const frames = [];
try {
  electron = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['scripts/lib/verify-voice-app.mjs'], env: { ...process.env, HEMI_USER_DATA_DIR: ud, HEMI_LLM_API_KEY: 'TEST_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'voice-test', DOUBAO_ASR_ENDPOINT: `ws://127.0.0.1:${asr.address().port}` } });
  electron.process().stderr.on('data', data => fs.appendFileSync(path.join(evidence, 'stderr.log'), data));
  await wait(() => { page = electron.windows().find(p => /^(?:http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, '主窗口');
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const fakeMicrophone = () => {
    // Real Web Audio graph, silent synthetic device; never opens the user's microphone.
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); const destination = context.createMediaStreamDestination();
      const source = context.createConstantSource(); source.offset.value = 0; source.connect(destination); source.start();
      const stream = destination.stream;
      stream.getTracks().forEach(track => { const stop = track.stop.bind(track); track.stop = () => { stop(); void context.close(); }; });
      return stream;
    };
  };
  await page.addInitScript(fakeMicrophone);
  await page.locator('textarea.text-composer-input').waitFor();
  await page.reload();
  await page.locator('textarea.text-composer-input').waitFor();
  await electron.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')); w.setMinimumSize(300, 400); w.setContentSize(1440, 900); w.show(); });
  const command = command => electron.evaluate(({ BrowserWindow }, command) => { BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).webContents.send('floating:command', command); }, command);
  const interim = () => page.locator('.h24-user-bubble.is-interim').allTextContents().then(texts => texts.join('\n'));
  const snapshot = () => page.evaluate(async () => { const sessions = await window.hemiVoice.listConversations(); const cid = sessions.sessions[0]?.id; return cid ? window.hemiVoice.flowGetSnapshot(cid) : null; });
  if (process.env.HEMI_VOICE_RECORD === '1') {
    const videoDir = path.join(evidence, 'video'); fs.mkdirSync(videoDir, { recursive: true });
    cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', frame => {
      const name = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
      fs.writeFileSync(path.join(videoDir, name), Buffer.from(frame.data, 'base64'));
      frames.push({ name, at: frame.metadata.timestamp });
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 1440, maxHeight: 900, everyNthFrame: 2 });
  }
  await command('hold-start');
  await wait(async () => socket?.readyState === 1 && (await page.evaluate(() => window.hemiVoice.getUiState())).sessionState === 'listening', '按住说话连接');
  emit([speech('第一句临时', 0)]);
  await wait(async () => (await interim()).includes('第一句临时'), '临时识别实时显示', 3000);
  emit([speech('第一句定稿。', 0, true), speech('第二句临时', 1000)]);
  await wait(async () => { const text = await interim(); return text.includes('第一句定稿。') && text.includes('第二句临时'); }, '定稿与下一句同时显示', 3000);
  assert.equal(requests.length, 0, '按住期间不提前发送');
  check('按住说话的 partial、final 和下一句持续展示');
  for (const width of [1440, 768, 375]) {
    await electron.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).setContentSize(width, 900); }, width);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(evidence, `speech-${width}.png`) });
    assert.equal(await page.locator('body').evaluate(el => el.scrollWidth > innerWidth), false);
  }
  emit([speech('VOICE_HOLD 修订后的第一句。', 0, true), speech('第二句定稿。', 1000, true)]);
  await command('hold-end');
  await wait(() => requests.some(r => r.marker === 'VOICE_HOLD'), '松手发送');
  await wait(async () => !await interim(), '受理撤下临时稿');
  assert.ok(JSON.stringify(requests.find(r => r.marker === 'VOICE_HOLD').body).includes('第二句定稿。'));
  held.get('VOICE_HOLD').done();
  await wait(async () => (await snapshot())?.phase === 'idle', '按住说话完整收口');
  check('二遍修订后松手一次发送全部分句，临时稿转正');
  await electron.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).setContentSize(1440, 900); });
  await page.getByRole('button', { name: '开始通话', exact: true }).click();
  await wait(async () => socket?.readyState === 1 && (await page.evaluate(() => window.hemiVoice.getUiState())).sessionState === 'listening', '通话连接');
  emit([speech('VOICE_FIRST 通话第一句临时', 2000)]);
  await wait(async () => (await interim()).includes('通话第一句临时'), '默认说话人过滤下首句实时预览');
  assert.equal(requests.filter(r => r.main).length, 1, '无编号临时识别不能触发执行');
  emit([speech('VOICE_FIRST 通话第一句。', 2000, true)]);
  const sentAt = Date.now();
  await wait(() => requests.some(r => r.marker === 'VOICE_FIRST'), '通话停顿发送', 3500);
  assert.ok(Date.now() - sentAt < 3500, '定稿不等待5秒识别超时');
  emit([speech('VOICE_SECOND 通话第二句临时。', 3000)]);
  await wait(async () => (await interim()).includes('通话第二句临时'), '锁定说话人后未知编号partial仍可预览');
  assert.ok(held.has('VOICE_FIRST'), '未定稿预览不打断正在处理的请求');
  emit([speech('VOICE_SECOND 通话第二句。', 3000, true)]);
  await wait(() => requests.some(r => r.marker === 'VOICE_SECOND'), '通话抢话处理', 5000);
  assert.equal(held.has('VOICE_FIRST'), false, '旧请求已取消');
  check('通话在模型请求中即时抢话，旧请求关闭');
  held.get('VOICE_SECOND').done();
  await wait(async () => (await snapshot())?.phase === 'idle', '第二句完整收口');
  assert.equal(await page.locator('.h24-user-bubble').filter({ hasText: 'VOICE_SECOND' }).count(), 1);
  assert.equal(await page.getByText(/待发送消息/).count(), 0);
  await page.screenshot({ path: path.join(evidence, 'call-interrupted-1440.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(evidence, 'call-interrupted-1440-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  emit([speech('VOICE_TOOL 执行工具。', 4000, true)]);
  await wait(() => fs.existsSync(path.join(root, 'tool-started')), '真实bash开始');
  const toolPid = Number(fs.readFileSync(path.join(root, 'tool.pid'), 'utf8'));
  process.kill(toolPid, 0);
  const sendText = async text => { await page.locator('textarea.text-composer-input').fill(text); await page.locator('textarea.text-composer-input').press('Enter'); };
  await sendText('VOICE_TEXT 普通文字仍排队。');
  await wait(async () => (await snapshot())?.pending.length === 1, '普通文字忙时排队');
  process.kill(toolPid, 0);
  assert.equal(requests.some(r => r.main && r.marker === 'VOICE_TEXT'), false);
  emit([speech('VOICE_AFTER 立即处理新句。', 5000, true)]);
  await wait(() => requests.some(r => r.main && r.marker === 'VOICE_AFTER'), '工具退出后通话接管');
  assert.throws(() => process.kill(toolPid, 0), { code: 'ESRCH' });
  assert.deepEqual((await snapshot()).pending.map(p => p.text), ['VOICE_TEXT 普通文字仍排队。']);
  held.get('VOICE_AFTER').done();
  await wait(() => held.has('VOICE_TEXT'), '普通队列在通话后继续');
  held.get('VOICE_TEXT').done();
  await wait(async () => (await snapshot())?.phase === 'idle', '文字完整收口');
  await command('toggle-call');
  await wait(async () => !(await page.evaluate(() => window.hemiVoice.getUiState())).callActive, '挂断');
  check('真实bash已经启动，通话接管确认进程退出；普通文字保持排队');
  await sendText('VOICE_BASE 普通任务在途。');
  await wait(() => held.has('VOICE_BASE'), '按住说话排队对照任务');
  await command('hold-start');
  await wait(async () => socket?.readyState === 1 && (await page.evaluate(() => window.hemiVoice.getUiState())).sessionState === 'listening', '忙时按住连接');
  emit([speech('VOICE_QUEUED 按住说话保留排队。', 6000, true)]);
  await wait(async () => (await interim()).includes('VOICE_QUEUED'), '忙时按住定稿实时可见');
  await command('hold-end');
  await wait(async () => (await snapshot())?.pending.length === 1, '按住说话忙时仍排队');
  assert.ok(held.has('VOICE_BASE'));
  assert.equal(requests.some(r => r.main && r.marker === 'VOICE_QUEUED'), false);
  held.get('VOICE_BASE').done();
  await wait(() => held.has('VOICE_QUEUED'), '按住说话出队');
  held.get('VOICE_QUEUED').done();
  await wait(async () => (await snapshot())?.phase === 'idle', '按住队列收口');
  // Past the original command's deadline: cancellation must prevent its trailing write.
  await new Promise(r => setTimeout(r, 8500));
  assert.equal(fs.existsSync(path.join(root, 'tool-late')), false);
  check('按住说话保留普通排队，工具停止后没有迟到文件写入');
  await page.reload();
  await page.locator('textarea.text-composer-input').waitFor();
  await wait(async () => await page.locator('.h24-user-bubble').filter({ hasText: 'VOICE_SECOND' }).count() === 1, '重载历史');
  assert.equal(await page.locator('.is-interim').count(), 0);
  check('通话结果单次落档，重载无临时稿或重复消息');
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(r => r.main && r.marker === 'VOICE_HOLD').length, 1);
  assert.equal(requests.filter(r => r.main && r.marker === 'VOICE_SECOND').length, 1);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ mode, url: page.url(), checks, requests: requests.map(({ marker, main, model }) => ({ marker, main, model })), errors }, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(-1800)); }
  throw error;
} finally {
  if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); }
  if (frames.length) {
    const videoDir = path.join(evidence, 'video');
    const concat = frames.map((frame, index) => `file '${frame.name}'\nduration ${Math.max(0.001, (frames[index + 1]?.at ?? frame.at + .1) - frame.at)}\n`).join('');
    fs.writeFileSync(path.join(videoDir, 'frames.txt'), concat + `file '${frames.at(-1).name}'\n`);
    const encoded = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', 'scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '../voice-regressions.mp4'], { cwd: videoDir });
    if (encoded.status !== 0) console.error('录屏编码失败', encoded.stderr?.toString());
  }
  if (electron) {
    await page?.close().catch(() => {});
    const timer = setTimeout(() => electron.process().kill('SIGKILL'), 3000);
    try { await electron.close(); } catch { /* app may have exited during cleanup */ }
    finally { clearTimeout(timer); }
  }
  for (const client of asr.clients) client.terminate();
  await new Promise(r => asr.close(r));
  server.closeAllConnections(); await new Promise(r => server.close(r));
  if (fs.existsSync(path.join(ud, 'hemi.log'))) fs.copyFileSync(path.join(ud, 'hemi.log'), path.join(evidence, 'hemi.log'));
  fs.rmSync(root, { recursive: true, force: true });
}
