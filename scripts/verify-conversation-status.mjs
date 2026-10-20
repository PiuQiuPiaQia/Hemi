// 真实 Electron renderer → 列表/对话 IPC → 生产 Pi SDK → 本机可控 provider。
// 仅替换外部模型边界；危险命令在真实确认卡拒绝，不自动授权或补写运行态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-status-'));
const userData = path.join(root, 'userData');
const evidence = path.resolve(process.env.HEMI_STATUS_EVIDENCE ?? path.join('.visual/workflow/vision', `060-status-${Date.now()}`));
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
// 已完成引导是配置资源，与既有自驱动入口一致；不复制任何模型 Key。
fs.copyFileSync(path.join(os.homedir(), 'Library/Application Support/hemi-dev/onboarding.json'), path.join(userData, 'onboarding.json'));
const requests = [], checks = {}, heldResponses = new Map();
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    const last = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
    const user = textOf(last ?? {});
    const marker = ['RUN_A', 'RUN_STOP', 'RUN_ERROR', 'RUN_WAIT'].find(m => user.includes(m)) ?? 'RUN_B';
    if (marker === 'RUN_ERROR') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'STATUS_INJECTED_FAILURE', type: 'invalid_request_error' } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = data => res.write(`data: ${JSON.stringify({ id: `status-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, ...data })}\n\n`);
    if (marker === 'RUN_WAIT' && body.messages.at(-1)?.role !== 'tool') {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'status-risk-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `rm -rf '${path.join(root, 'never-executed')}'` }) } }] }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n'); return;
    }
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `${marker}_STREAM` }, finish_reason: null }] });
    const finish = () => {
      chunk({ choices: [{ index: 0, delta: { content: `${marker}_ANSWER` }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      res.end('data: [DONE]\n\n'); heldResponses.delete(marker);
    };
    if (marker === 'RUN_B' || marker === 'RUN_WAIT') finish(); else heldResponses.set(marker, finish);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main', providers: [{ id: 'audit', name: '本机回卷验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'hemi-audit', thinkingLevel: 'default' }] }] }));
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
  await evalJs(`(() => { const ta=document.querySelector('textarea.text-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(text)}); ta.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => evalJs(`(() => { const b=document.querySelector('.text-composer-send:not(.is-stop)'); if (!b || b.disabled) return false; b.click(); return true; })()`), '发送按钮');
  await waitFor(() => requests.find(b => textOf([...b.messages].reverse().find(m=>m.role==='user')).includes(text)), '实际 provider 请求');
}
const row = title => `[...document.querySelectorAll('.h24-sidebar-open')].find(b => b.querySelector('.h24-sidebar-item-text')?.textContent.includes(${JSON.stringify(title)}))`;
async function status(title, expected) {
  await waitFor(() => evalJs(`(() => {const row=${row(title)}; return Boolean(row) && (row.querySelector('.conversation-status')?.dataset.status ?? null) === ${JSON.stringify(expected)};})()`), `${title} 状态 ${expected}`);
  assert.ok(await evalJs(`(() => {
    const row=${row(title)}, icon=row.querySelector('.conversation-status');
    if (${JSON.stringify(expected)} === null) return icon === null;
    return icon.getBoundingClientRect().left >= row.querySelector('.h24-sidebar-item-text').getBoundingClientRect().right;
  })()`), `${title}：标志应在标题后方，空闲不占位`);
}
async function sessionView(title) { return evalJs(`window.hemiVoice.listConversations().then(list=>list.sessions.find(s=>s.title.includes(${JSON.stringify(title)})))`); }
async function openChat(title) {
  await evalJs(`(${row(title)}).click()`);
  await waitFor(()=>evalJs(`document.querySelector('.h24-user-bubble')?.textContent.includes(${JSON.stringify(title)})`),'会话载入');
}
async function shot(name) {
  await evalJs('window.hemiVoice.showMainWindow()'); await call('Page.bringToFront');
  await new Promise(r=>setTimeout(r,350));
  const image=await call('Page.captureScreenshot',{format:'png',fromSurface:false});
  fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(image.data,'base64'));
}
async function newChat() { await evalJs(`document.querySelector('[aria-label="新建对话"]').click()`); await waitFor(()=>evalJs(`!document.querySelector('.h24-user-bubble')`),'新会话'); }
async function reload() {
  await evalJs('window.__statusReload = true'); await call('Page.reload',{ignoreCache:true});
  await waitFor(()=>evalJs('!window.__statusReload').catch(()=>false),'重载 renderer'); await ready();
}
try {
  await start();
  await evalJs('window.hemiVoice.showMainWindow()'); await call('Page.bringToFront');
  await submit('RUN_A'); await status('RUN_A','running');
  assert.ok(heldResponses.has('RUN_A'),'运行图标出现时 provider 必须仍在执行');
  await shot('running'); checks.realRequestShowsRunning=true;
  await newChat(); await submit('RUN_B');
  await waitFor(async()=> !(await sessionView('RUN_B'))?.unreadAt && (await sessionView('RUN_B'))?.status === null, '前台会话收口并清读');
  await status('RUN_B',null); await status('RUN_A','running');
  checks.foregroundResultHasNoTerminalIcon=true;
  heldResponses.get('RUN_A')(); await status('RUN_A','unread');
  const firstUnread=await sessionView('RUN_A'); assert.ok(firstUnread.unreadAt>0);
  checks.backgroundResultBecomesUnreadWithoutOpening=true;
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent==='查看全部').click()`);
  await waitFor(()=>evalJs(`Boolean(document.querySelector('.history-dialog .conversation-status[data-status="unread"]'))`),'全部记录状态');
  await shot('history-unread'); checks.historyDialogConsistent=true;
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor(()=>evalJs(`!document.querySelector('.history-dialog')`),'关闭全部记录');
  // 启动恢复最近一条：让当前 B 更新，避免重载自动打开未读 A 而正确清读。
  await submit('RUN_B_AGAIN');
  await waitFor(async()=> (await sessionView('RUN_B'))?.status===null && !(await sessionView('RUN_B'))?.unreadAt,'B 再次收口');
  await reload(); await status('RUN_A','unread'); checks.reloadKeepsUnread=true;
  const firstUrl=currentUrl;
  await stop(); await start(); await status('RUN_A','unread'); checks.restartKeepsUnread=true;
  await evalJs('window.hemiVoice.showMainWindow()'); await call('Page.bringToFront');
  await openChat('RUN_A'); await status('RUN_A',null);
  const read=await sessionView('RUN_A'); assert.equal(read.unreadAt,null); assert.equal(read.updatedAt,firstUnread.updatedAt,'打开清读不影响排序时间');
  checks.openingClearsUnreadWithoutReordering=true;
  await submit('RUN_A_AGAIN'); await status('RUN_A','running');
  await newChat(); heldResponses.get('RUN_A')(); await status('RUN_A','unread');
  const secondUnread=await sessionView('RUN_A'); assert.ok(secondUnread.unreadAt>firstUnread.unreadAt);
  const staleRead=await evalJs(`window.hemiVoice.markConversationRead(${JSON.stringify(firstUnread.id)},${firstUnread.unreadAt})`);
  assert.equal(staleRead.unreadAt,secondUnread.unreadAt); await status('RUN_A','unread');
  checks.staleReadCannotClearNewResult=true;
  await newChat(); await submit('RUN_STOP'); await status('RUN_STOP','running');
  assert.ok(heldResponses.has('RUN_STOP'));
  await evalJs(`document.querySelector('.text-composer-send.is-stop, .text-composer-stop').click()`);
  await waitFor(async()=> (await sessionView('RUN_STOP'))?.status===null,'真实停止收口');
  await status('RUN_STOP',null); heldResponses.delete('RUN_STOP'); checks.realStopRemovesSpinner=true;
  await newChat(); await submit('RUN_WAIT'); await status('RUN_WAIT','running');
  await waitFor(()=>evalJs(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='拒绝'))`),'真实确认卡');
  await shot('running-confirmation');
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='拒绝').click()`);
  await waitFor(async()=> (await sessionView('RUN_WAIT'))?.status===null && !(await sessionView('RUN_WAIT'))?.unreadAt,'确认回合收口');
  await status('RUN_WAIT',null); checks.confirmationUsesRunningOnly=true;
  await newChat(); await submit('RUN_ERROR');
  await waitFor(()=>evalJs(`document.body.textContent.includes('STATUS_INJECTED_FAILURE')`),'上游故障确实注入');
  await waitFor(async()=> (await sessionView('RUN_ERROR'))?.status===null && !(await sessionView('RUN_ERROR'))?.unreadAt,'前台故障已读');
  await status('RUN_ERROR',null); checks.failureHasNoExtraStatusIcon=true;
  assert.ok(await evalJs(`[...document.querySelectorAll('.conversation-status[data-status]')].every(n=>['unread','running'].includes(n.dataset.status))`));
  await shot('two-indicators'); checks.onlyUnreadAndRunningIndicators=true;
  const summary={ok:true,checks,rendererUrls:[firstUrl,currentUrl],requests:requests.length,userData,boundary:'Real renderer, IPC, production controller/runtime/SDK; only external provider is controlled.'};
  fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2));
  console.log('HEMI_VERIFY_CONVERSATION_STATUS='+JSON.stringify(summary));
} catch(error) { console.error(error); console.error(`证据与隔离数据：${evidence} ${userData}`); process.exitCode=1; }
finally { await stop(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
