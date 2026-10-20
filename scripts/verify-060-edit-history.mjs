// 真实 Electron renderer → 编辑／重发 IPC → 生产 Pi SDK → 本机可控 provider。
// 仅替换外部模型边界；bash 工具真实执行。没有自动授权、内部工厂替换或运行态补写。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi060-edit-'));
const userData = path.join(root, 'userData');
const evidence = path.resolve(process.env.HEMI_EDIT_EVIDENCE ?? path.join('.visual/workflow/vision', `060-edit-${Date.now()}`));
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
// 已完成引导是配置资源，与既有自驱动入口一致；不复制任何模型 Key。
fs.copyFileSync(path.join(os.homedir(), 'Library/Application Support/hemi-dev/onboarding.json'), path.join(userData, 'onboarding.json'));
const requests = [], checks = {}, heldResponses = new Map();
// 同一真实产品入口附带缓存／原图回归；不替换内部工厂或读写运行态。
const verifyCache = process.env.HEMI_EDIT_CACHE === '1';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4ryDwHxkzkC4AAKLAIuEUh8J9AAAAAElFTkSuQmCC';
const stopStarted = path.join(root, 'stop-started'), stopPid = path.join(root, 'stop-pid'), stopLate = path.join(root, 'stop-late');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    const last = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
    const user = textOf(last ?? {});
    const marker = ['KEEP_REQUEST', 'REMOVE_REQUEST', 'NEW_REQUEST', 'AFTER_RELOAD', 'AFTER_RESTART', 'FIRST_EDIT_REQUEST', 'FIRST_EDIT_AGAIN', 'STOP_REQUEST', 'QUEUED_REQUEST'].find(m => user.split('\n')[0] === m);
    const tool = ['KEEP_REQUEST', 'REMOVE_REQUEST', 'STOP_REQUEST'].includes(marker) && body.messages.at(-1)?.role !== 'tool';
    const content = marker === 'KEEP_REQUEST' ? 'KEEP_ANSWER' : marker === 'REMOVE_REQUEST' ? 'REMOVE_ANSWER' : marker === 'NEW_REQUEST' ? 'NEW_ANSWER' : marker ? `${marker}_ANSWER` : '编辑回卷验证';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = data => res.write(`data: ${JSON.stringify({ id: `audit-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, ...data })}\n\n`);
    if (marker?.startsWith('FIRST_EDIT_')) {
      // 外部 provider 暂缓终态：先证明编辑后的用户项／正文在收口前已即时上屏。
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `${marker}_STREAM` }, finish_reason: null }] });
      heldResponses.set(marker, () => {
        chunk({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
        res.end('data: [DONE]\n\n');
        heldResponses.delete(marker);
      });
      return;
    }
    const command = marker === 'STOP_REQUEST'
      ? `printf START > ${shellQuote(stopStarted)}; printf '%s' "$$" > ${shellQuote(stopPid)}; sleep 30; printf LATE > ${shellQuote(stopLate)}`
      : `printf '${marker === 'KEEP_REQUEST' ? 'KEEP_TOOL' : 'REMOVE_TOOL'}'`;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] } : { role: 'assistant', content };
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main', providers: [{ id: 'audit', name: '本机回卷验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'hemi-audit', thinkingLevel: 'default', supportsVision: verifyCache }] }] }));
const waitFor = async (fn, label, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`超时：${label}`);
};
let child, ws, call, evalJs, currentUrl;
async function start() {
  const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
  const log = fs.openSync(path.join(evidence, `electron-${Date.now()}.log`), 'w');
  child = spawn(path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_LLM_API_KEY: 'local-dummy-key', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'hemi-audit' }, stdio: ['ignore', log, log],
  }); fs.closeSync(log);
  const page = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    return targets.find(t => t.type === 'page' && !/mode=/.test(t.url));
  }, '主窗口');
  currentUrl = page.url;
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  let seq = 0; const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  evalJs = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  await ready();
}
async function ready() { await waitFor(() => evalJs('Boolean(window.hemiVoice && document.querySelector("textarea.text-composer-input") && !document.querySelector(".setup-shell"))').catch(() => false), '输入框'); }
async function stop() {
  ws?.close(); if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
}
async function submit(text) {
  await evalJs(`(() => { const ta = document.querySelector('textarea.text-composer-input'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await waitFor(() => evalJs(`(() => { const b = document.querySelector('.text-composer-send:not(.is-stop)'); if (!b || b.disabled) return false; b.click(); return true; })()`), '发送按钮');
}
async function send(text) {
  await submit(text);
  await settled(text === 'KEEP_REQUEST' ? 'KEEP_ANSWER' : text === 'REMOVE_REQUEST' ? 'REMOVE_ANSWER' : `${text}_ANSWER`);
}
async function settled(answer) {
  await waitFor(() => evalJs(`document.body.innerText.includes(${JSON.stringify(answer)}) && !document.querySelector('.text-composer-send.is-stop, .text-composer-stop')`), `答复 ${answer}`);
}
function record() {
  const dir = path.join(userData, 'conversations');
  const files = fs.readdirSync(dir).filter(f => /^conv-.*\.json$/.test(f));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f)))).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
function checkCachePrefix(name) {
  if (!verifyCache) return;
  const bodies = requests.filter(body => body.tools?.some(tool => tool.function?.name === 'bash'));
  const kept = body => body.messages.find(m => m.role === 'user' && textOf(m).split('\n')[0] === 'KEEP_REQUEST');
  const first = bodies.find(kept);
  assert.ok(first, '真实主 agent 请求已到达可控 provider');
  const firstUser = kept(first);
  assert.match(textOf(firstUser), /本轮上下文/);
  assert.ok(firstUser.content.some(block => block.type === 'image_url'), '从真实粘贴入口发出了原图块');
  let compared = 0;
  for (const body of bodies.filter(kept)) {
    const end = first.messages.indexOf(firstUser) + 1;
    assert.deepEqual(body.messages.slice(0, end), first.messages.slice(0, end), '旧用户消息及其前缀在工具／续聊／编辑／重建中原样保留');
    assert.deepEqual(body.tools, first.tools);
    compared++;
  }
  assert.ok(compared >= 4, '至少覆盖两轮及其真实工具往返');
  checks[name] = { compared, imagePreserved: true, contextPreserved: true };
}
async function edit(targetText, nextText, { fail = false, firstEdit = false } = {}) {
  const count = requests.length;
  assert.equal(await evalJs(`(() => { const row = [...document.querySelectorAll('[data-flow-row]')].find(e => e.querySelector('.h24-user-bubble')?.textContent.trim() === ${JSON.stringify(targetText)}); const b = row?.querySelector('.h24-edit-btn'); b?.click(); return Boolean(b); })()`), true);
  await waitFor(() => evalJs('Boolean(document.querySelector(".h24-edit-input"))'), '原位编辑框');
  await evalJs(`(() => { const ta=document.querySelector('.h24-edit-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(nextText)}); ta.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await evalJs(`document.querySelector('.h24-resend-btn').click()`);
  if (fail) {
    await waitFor(() => evalJs('document.body.innerText.includes("修改尚未发送")'), '回卷写入失败提示');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(requests.length, count, '回卷失败不能继续发送模型请求');
    return null;
  }
  const request = await waitFor(() => requests.slice(count).find(b => {
    const lastUser = [...(b.messages ?? [])].reverse().find(m => m.role === 'user');
    return textOf(lastUser ?? {}).split('\n')[0] === nextText;
  }), '编辑必须真正发出模型请求');
  if (firstEdit) {
    await waitFor(() => evalJs(`(() => {
      const list = document.querySelector('.conversation-list');
      const users = [...list.querySelectorAll('.h24-user-bubble')].map(n => n.textContent.trim());
      return users.length === 1 && users[0] === ${JSON.stringify(nextText)}
        && list.textContent.includes(${JSON.stringify(`${nextText}_STREAM`)})
        && Boolean(document.querySelector('.text-composer-send.is-stop, .text-composer-stop'));
    })()`), '首条编辑的新用户项与流式正文即时上屏（provider 尚未收口）');
    const body = await evalJs(`document.querySelector('.conversation-list').textContent`);
    assert.doesNotMatch(body, /KEEP_REQUEST|KEEP_ANSWER|REMOVE_REQUEST|REMOVE_ANSWER|NEW_REQUEST|NEW_ANSWER|AFTER_RELOAD|AFTER_RESTART/);
    assert.ok(heldResponses.has(nextText), '必须确有在途 provider，不能用已收口回答冒充流式即时更新');
    const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: false });
    fs.writeFileSync(path.join(evidence, `${nextText.toLowerCase()}-streaming.png`), Buffer.from(shot.data, 'base64'));
    heldResponses.get(nextText)();
  }
  await settled(firstEdit ? `${nextText}_ANSWER` : 'NEW_ANSWER');
  return request;
}
function checkRequest(body, name, fresh = false) {
  const messages = body.messages.map(m => ({ role: m.role, text: textOf(m) })), flat = JSON.stringify(messages);
  assert.match(flat, /KEEP_REQUEST/); assert.match(flat, /KEEP_ANSWER/); assert.match(flat, /KEEP_TOOL/);
  assert.doesNotMatch(flat, /REMOVE_REQUEST|REMOVE_ANSWER|REMOVE_TOOL/);
  assert.equal(messages.filter(m => m.role === 'user' && m.text.split('\n')[0] === 'NEW_REQUEST').length, 1);
  if (fresh) assert.doesNotMatch(flat, /NEW_ANSWER/);
  checks[name] = true;
}
try {
  await start(); console.log('[edit060] 真实窗口已就绪');
  if (verifyCache) {
    await evalJs(`(() => {
      const bytes=Uint8Array.from(atob(${JSON.stringify(png)}), c=>c.charCodeAt(0));
      const data=new DataTransfer(); data.items.add(new File([bytes], 'cache-prefix.png', {type:'image/png'}));
      document.querySelector('textarea.text-composer-input').dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true}));
    })()`);
    await waitFor(() => evalJs('Boolean(document.querySelector(".h24-attach-card-image"))'), '真实粘贴附件已就绪');
  }
  await send('KEEP_REQUEST'); await send('REMOVE_REQUEST');
  checkCachePrefix('cachePrefixAcrossToolsAndTurns');
  if (verifyCache) {
    const rawUsers = await evalJs(`Array.from(document.querySelectorAll('.h24-user-bubble'), el=>el.textContent.trim())`);
    assert.deepEqual(rawUsers, ['KEEP_REQUEST', 'REMOVE_REQUEST'], '界面仍显示用户原话，不展示宿主上下文');
    checks.rawUserTextInUi = true;
    await submit('STOP_REQUEST');
    await waitFor(() => fs.existsSync(stopStarted) && fs.existsSync(stopPid), '真实命令已写入启动标记');
    const cid = record().id;
    const snapshot = () => evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`);
    const active = (await snapshot()).activeRunId;
    assert.ok(active, '慢命令所属运行确实在途');
    await submit('QUEUED_REQUEST');
    await waitFor(async () => (await snapshot()).pending.some(input => input.text === 'QUEUED_REQUEST'), '忙时普通发送确实排队');
    await evalJs(`(document.querySelector('.text-composer-stop') ?? document.querySelector('.text-composer-send.is-stop')).click()`);
    await waitFor(async () => (await snapshot()).runs[active]?.outcome === 'stopped', '停止屏障已完成');
    const pid = Number(fs.readFileSync(stopPid, 'utf8'));
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, '所属 shell 已结束');
    assert.equal(fs.existsSync(stopLate), false, '停止后没有迟到文件写入');
    assert.equal(requests.filter(body => body.messages?.some(m => m.role === 'user' && textOf(m).split('\n')[0] === 'QUEUED_REQUEST')).length, 0, '停止后未自动派发队列');
    await evalJs(`window.hemiVoice.resumeTurnQueue(${JSON.stringify(cid)})`);
    await settled('QUEUED_REQUEST_ANSWER');
    const resumed = requests.findLast(body => body.tools?.length && body.messages.some(m => m.role === 'user' && textOf(m).split('\n')[0] === 'QUEUED_REQUEST'));
    const stopped = resumed.messages.find(m => m.role === 'user' && textOf(m).split('\n')[0] === 'STOP_REQUEST');
    const initial = requests.find(body => body.tools?.length && body.messages.some(m => m.role === 'user' && textOf(m).split('\n')[0] === 'STOP_REQUEST'));
    assert.deepEqual(stopped, initial.messages.find(m => m.role === 'user' && textOf(m).split('\n')[0] === 'STOP_REQUEST'), '队列恢复没有改写已接收的停止轮上下文');
    checks.stopAndResumePreserveContext = true;
  }
  const before = record(); assert.match(JSON.stringify(before.agentSession), /REMOVE_TOOL/);
  // 新会话的 archivePayload 为空，覆盖不了用户报告；必须先重载、确认旧全文载入再编辑。
  await evalJs('window.__hemiLoadedEdit = true');
  await call('Page.reload', { ignoreCache: true });
  await waitFor(() => evalJs('!window.__hemiLoadedEdit').catch(() => false), '已载入历史的新 renderer');
  await ready(); await settled('REMOVE_ANSWER');
  checkRequest(await edit('REMOVE_REQUEST', 'NEW_REQUEST'), 'changedTextRemovesOldHistory', true);
  assert.doesNotMatch(await evalJs(`document.querySelector('.conversation-list').textContent`), /REMOVE_REQUEST|REMOVE_ANSWER/);
  checks.loadedMiddleEditUpdatesWithoutReload = true;
  assert.ok(record().cutKeys.some(k => /^reply-/.test(k)), '归档回答真实 ID 进入剪除键');
  checkRequest(await edit('NEW_REQUEST', 'NEW_REQUEST'), 'sameTextResendReplacesOldAnswer', true);
  await evalJs('window.__hemiEditProbeBeforeReload = true');
  await call('Page.reload', { ignoreCache: true });
  await waitFor(() => evalJs('!window.__hemiEditProbeBeforeReload').catch(() => false), '新 renderer 文档');
  await ready(); await send('AFTER_RELOAD');
  checkRequest(requests.findLast(b => b.messages?.some(m => m.role === 'user' && textOf(m).startsWith('AFTER_RELOAD'))), 'rendererReloadKeepsCorrectHistory');
  await evalJs('window.hemiVoice.showMainWindow()'); await call('Page.bringToFront');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: false }); fs.writeFileSync(path.join(evidence, 'after-edit.png'), Buffer.from(screenshot.data, 'base64'));
  const conversationsDir = path.join(userData, 'conversations');
  fs.chmodSync(conversationsDir, 0o500); // 外部文件系统边界注入真实写入故障。
  try { await edit('NEW_REQUEST', 'SHOULD_NOT_SEND', { fail: true }); }
  finally { fs.chmodSync(conversationsDir, 0o700); }
  checks.failedRewindDoesNotCallProvider = true;
  checkRequest(await edit('NEW_REQUEST', 'NEW_REQUEST'), 'retryAfterWriteFailure', true);
  const firstUrl = currentUrl;
  await stop(); await start(); await send('AFTER_RESTART');
  checkRequest(requests.findLast(b => b.messages?.some(m => m.role === 'user' && textOf(m).startsWith('AFTER_RESTART'))), 'processRestartKeepsCorrectHistory');
  const archive = record(); assert.doesNotMatch(JSON.stringify(archive.agentSession), /REMOVE_REQUEST|REMOVE_ANSWER|REMOVE_TOOL/);
  checkCachePrefix('cachePrefixAcrossEditAndProcessRestart');
  checks.archiveMatchesRequests = true;
  const firstEdit = await edit('KEEP_REQUEST', 'FIRST_EDIT_REQUEST', { firstEdit: true });
  assert.doesNotMatch(JSON.stringify(firstEdit.messages), /KEEP_REQUEST|KEEP_ANSWER|KEEP_TOOL|REMOVE_REQUEST|NEW_REQUEST|AFTER_RELOAD|AFTER_RESTART/);
  checks.loadedFirstEditStreamsWithoutReload = true;
  const repeatedEdit = await edit('FIRST_EDIT_REQUEST', 'FIRST_EDIT_AGAIN', { firstEdit: true });
  assert.doesNotMatch(JSON.stringify(repeatedEdit.messages), /FIRST_EDIT_REQUEST|KEEP_REQUEST|REMOVE_REQUEST|NEW_REQUEST/);
  checks.consecutiveFirstEditStreamsWithoutReload = true;
  const summary = { ok: true, checks, rendererUrls: [firstUrl, currentUrl], requests: requests.length, userData, toolsActuallyExecuted: true, boundary: 'Only provider is mocked; real renderer, IPC, runtime, SDK and bash tools.' };
  fs.writeFileSync(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`HEMI_VERIFY_060_EDIT_HISTORY=${JSON.stringify(summary)}`);
} catch (error) { console.error(error); console.error(`证据与隔离数据保留：${evidence} ${userData}`); process.exitCode = 1; }
finally { await stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
