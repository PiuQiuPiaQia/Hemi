// 隔离的真实窗口/IPC/Pi + 本地可控流：导航、并发、重接、重载、停止与任务归属。
import assert from 'node:assert/strict';
import { app, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../src/shared/ipc-channels.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';
import { shutdownBrowserBridgeService } from '../src/main/services/browser-bridge-service.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { state } from '../src/main/state.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-switch-'));
app.setPath('userData', dir);
const out = path.resolve('.visual/workflow/vision/conversation-switch-fix');
mkdirSync(out, { recursive: true });
const pending = new Map();
const aborted = new Set();
const checks = [];
const errors = [];
let taskSubmission = false;
let calls = 0;
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls += 1;
    const user = String(body.messages.findLast((m) => m.role === 'user')?.content ?? '');
    const tools = body.tools?.map((t) => t.function.name) ?? [];
    const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (tools.includes('execute_task') && user.includes('验收I')) {
      pending.set('I', { response, release: () => {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('local verification: rejected');
      } });
      response.on('close', () => { if (!response.writableEnded) aborted.add('I'); });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: `local-${calls}`, model: 'gpt-4o-mini', choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const finish = (text) => { frame({ content: text }); frame({}, 'stop'); response.end('data: [DONE]\n\n'); };
    const toolCall = (name, args) => {
      frame({ tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      frame({}, 'tool_calls'); response.end('data: [DONE]\n\n');
    };
    const hold = (key, release) => {
      frame({ role: 'assistant', reasoning_content: `正在核对 ${key} 的依据。` });
      pending.set(key, { release, response });
      response.on('close', () => { if (!response.writableEnded) aborted.add(key); });
    };
    if (system.includes('你给一段对话起标题')) return finish('验收会话');
    if (tools.includes('submit_task_result')) {
      if (taskSubmission) return finish('任务核验已完成。');
      taskSubmission = true;
      return hold('task-G', () => toolCall('submit_task_result', {
        proposedVerdict: 'complete', summary: '切换后任务继续完成。',
        checks: [{ target: '验证任务会话归属', status: 'satisfied', kind: 'goal', evidence: '本地受控回路' }],
        missing: [], sideEffects: [],
      }));
    }
    if (tools.includes('execute_task') && user.includes('验收G')) {
      return hold('G', () => toolCall('execute_task', { task: '验收G：验证任务会话归属' }));
    }
    if (tools.includes('execute_task') && user.includes('验收K')) {
      return hold('K', () => { frame({ content: 'K受理：我去核对受理顺序。' }); toolCall('execute_task', { task: '验收K：核对受理顺序' }); });
    }
    const key = ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'Q'].find((tag) => user.includes(`验收${tag}`));
    if (key && tools.includes('execute_task')) return hold(key, () => finish(`回复${key}：仅属于原会话。`));
    finish('任务核验已完成。');
  } catch (error) {
    errors.push(error.message);
    response.end();
  }
});
const invoke = (channel, payload) => ipcMain._invokeHandlers.get(channel)({}, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(30); }
  throw new Error(`等待超时：${label}`);
}
const js = (code) => state.mainWindow.webContents.executeJavaScript(code);
const text = () => js('document.body.innerText');
const check = (label) => { checks.push(label); console.log(`PASS ${label}`); };
async function open(title) {
  assert.equal(await js(`(() => { const b = [...document.querySelectorAll('.h24-sidebar-item button')].find(b => b.textContent.trim() === ${JSON.stringify(title)}); b?.click(); return Boolean(b); })()`), true);
  await until(async () => (await js("document.querySelector('.h24-sidebar-item[data-current=true]')?.innerText"))?.trim() === title, `打开${title}`);
  await sleep(80);
}
async function send(prompt) {
  await js(`(() => { const el = document.querySelector('.text-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(prompt)}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await until(() => js("Boolean(document.querySelector('button[aria-label=\"发送消息\"]:not(:disabled)'))"), '发送按钮');
  await js("document.querySelector('button[aria-label=\"发送消息\"]').click()");
}
const running = (id) => invoke(IPC.llm.getTurnState, id);
const release = (key) => { assert.ok(pending.has(key), key); pending.get(key).release(); };
const waitPending = (key) => until(() => pending.has(key), `模型请求${key}`);
async function shot(name) {
  writeFileSync(path.join(out, `${name}.png`), (await state.mainWindow.webContents.capturePage()).toPNG());
}
async function main() {
  let exitCode = 0;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.HEMI_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    process.env.HEMI_LLM_API_KEY = 'local-mock-key';
    process.env.HEMI_LLM_MODEL = 'gpt-4o-mini';
    writeFileSync(path.join(dir, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now(), updatedAt: Date.now() }));
    await registerAllIpcHandlers();
    for (const [id, title] of [['conv-switch-a', '会话A'], ['conv-switch-b', '会话B']]) {
      await invoke(IPC.conversation.save, { id, turns: [] });
      await invoke(IPC.conversation.rename, { id, title });
    }
    await createMainWindow();
    state.mainWindow.setMinimumSize(1, 1); // 验收极窄布局，不改产品窗口限制。
    state.mainWindow.setBounds({ width: 1440, height: 900 });
    state.mainWindow.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    await until(() => js("Boolean(document.querySelector('.text-composer-input'))"), '主界面');
    await open('会话A');
    await send('验收A：切换后继续回答'); await waitPending('A');
    await open('会话B');
    assert.equal((await running('conv-switch-a')).status, 'running');
    assert.equal(aborted.has('A'), false);
    await send('验收B：独立并发回答'); await waitPending('B');
    assert.equal((await running('conv-switch-a')).status, 'running');
    check('切换和另一会话发送均不取消原请求');
    await open('会话A');
    await until(() => js("Boolean(document.querySelector('button[aria-label=\"停止回应\"]'))"), '重接停止键');
    assert.match(await text(), /正在核对 A/);
    for (const width of [1440, 768, 375]) {
      state.mainWindow.setBounds({ width, height: 900 });
      await until(() => js(`innerWidth === ${width}`), `窗口宽度${width}`);
      await sleep(300); await shot(`reattached-${width}`);
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    }
    state.mainWindow.setBounds({ width: 1440, height: 900 });
    check('返回会话恢复思考全文和停止操作，三档无横向溢出');
    release('B'); await until(async () => (await running('conv-switch-b')).status === 'complete', 'B完成');
    assert.doesNotMatch(await text(), /回复B/);
    await open('会话B');
    assert.match(await text(), /回复B/);
    release('A'); await until(async () => (await running('conv-switch-a')).status === 'complete', 'A后台完成');
    assert.doesNotMatch(await text(), /回复A/);
    await open('会话A');
    await until(async () => /回复A/.test(await text()), 'A结果恢复');
    assert.equal(await js("[...document.querySelectorAll('.chat-copy')].filter(el => el.textContent.includes('回复A')).length"), 1);
    check('后台完成只写原会话，返回结果仅出现一次');
    await send('验收C：重载后继续'); await waitPending('C');
    state.mainWindow.webContents.reload();
    await until(() => js("Boolean(document.querySelector('button[aria-label=\"停止回应\"]'))"), '重载重接');
    assert.equal(aborted.has('C'), false);
    release('C'); await until(async () => /回复C/.test(await text()), '重载后的结果');
    check('渲染层重载不取消，自动重接并收到结果');
    await send('验收D：只在明确停止时取消'); await waitPending('D');
    await open('会话B'); await open('会话A');
    await js("document.querySelector('button[aria-label=\"停止回应\"]').click()");
    await until(async () => (await running('conv-switch-a')).status === 'cancelled' && aborted.has('D'), '显式停止');
    check('重接后显式停止仍只取消当前请求');
    await js("(() => { const buttons = [...document.querySelectorAll('.h24-sidebar-item button')]; buttons.find(b => b.textContent.trim() === '会话B').click(); buttons.find(b => b.textContent.trim() === '会话A').click(); })()");
    await sleep(200);
    assert.equal((await js("document.querySelector('.h24-sidebar-item[data-current=true]')?.innerText"))?.trim(), '会话A');
    check('快速切换以最后一次选择为准');
    await send('验收E：新建会话不取消'); await waitPending('E');
    await js("document.querySelector('button[aria-label=\"新建对话\"]').click()");
    await sleep(100);
    await send('验收F：新会话正常回答'); await waitPending('F');
    assert.equal(aborted.has('E'), false);
    release('E'); release('F');
    await until(async () => /回复F/.test(await text()), '新会话回复');
    assert.doesNotMatch(await text(), /回复E/);
    await open('会话A'); await until(async () => /回复E/.test(await text()), '新建后原结果');
    check('新建会话保留旧请求，两个会话各自收取结果');
    await send('验收G：切换后派发任务'); await waitPending('G');
    await open('会话B'); release('G'); await waitPending('task-G');
    const task = (await invoke(IPC.task.getState)).tasks.find(t => t.taskText.includes('验收G'));
    assert.equal(task.conversationId, 'conv-switch-a');
    release('task-G');
    await until(async () => (await invoke(IPC.task.getState)).tasks.find(t => t.taskId === task.taskId)?.phase === 'terminal', '后台任务完成');
    const session = await invoke(IPC.conversation.open, 'conv-switch-a');
    assert.equal(session.turns.filter(t => t.kind === 'task' && t.taskId === task.taskId).length, 1);
    assert.equal(session.turns.filter(t => t.kind !== 'task' && t.taskId === task.taskId).length, 1);
    assert.doesNotMatch(await text(), /切换后任务继续完成/);
    check('离开后仍可派发并完成真实 Pi 任务，卡片与交代归原会话');
    await open('会话A'); await shot('completed-1440');
    // 2026-10-09 用户反馈：思考中切走再切回（重接），回合派生任务——受理语必须在
    // 它派生的任务卡之前（实时接回与重载同一顺序；此前卡先到、受理语落到卡下面）。
    const ackBeforeCard = () => js(`(() => {
      const ack = [...document.querySelectorAll('.h24-hemi-message')].find(el => el.textContent.includes('K受理'));
      const card = [...document.querySelectorAll('.chat-task-inline')].find(el => el.textContent.includes('验收K'));
      return ack && card ? Boolean(ack.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    })()`);
    await send('验收K：思考中切走再切回后派任务'); await waitPending('K');
    await open('会话B'); await open('会话A');
    await until(() => js("Boolean(document.querySelector('button[aria-label=\"停止回应\"]'))"), 'K 重接');
    release('K');
    await until(async () => (await ackBeforeCard()) !== null, 'K 受理语与任务卡入流');
    assert.equal(await ackBeforeCard(), true, '实时接回：受理语应在任务卡之前');
    const kTask = (await invoke(IPC.task.getState)).tasks.find(t => t.taskText.includes('验收K'));
    const kTurns = (await invoke(IPC.conversation.open, 'conv-switch-a')).turns;
    const kAck = kTurns.findIndex(t => t.author === 'hemi' && t.text.includes('K受理'));
    const kCard = kTurns.findIndex(t => t.kind === 'task' && t.taskId === kTask.taskId);
    assert.ok(kAck >= 0 && kCard > kAck, `档案顺序：受理语 ${kAck}、任务卡 ${kCard}`);
    await shot('ack-before-card-live-1440');
    await open('会话B'); await open('会话A');
    await until(async () => (await ackBeforeCard()) !== null, 'K 重载后入流');
    assert.equal(await ackBeforeCard(), true, '切回重载：受理语应在任务卡之前');
    await shot('ack-before-card-reloaded-1440');
    await until(async () => (await invoke(IPC.task.getState)).tasks.find(t => t.taskId === kTask.taskId)?.phase === 'terminal', 'K 任务收尾', 60000);
    check('思考中切走再切回后派任务：受理语在任务卡之前（实时、档案、重载一致）');
    await send('验收H：前台回合后续发排队消息'); await waitPending('H');
    await invoke(IPC.queue.resume, { conversationId: 'conv-switch-a' });
    await send('验收Q：排队回复继续可停止');
    await until(() => js("Boolean(document.querySelector('[role=menu][aria-label=\"选择发送方式\"]'))"), '排队方式菜单');
    await js("[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('排队发送')).click()");
    await until(async () => (await invoke(IPC.queue.list, { conversationId: 'conv-switch-a' })).items.length === 1, '排队受理');
    release('H'); await waitPending('Q');
    await until(async () => /正在核对 Q/.test(await text()), '队首重接');
    assert.equal(await js("Boolean(document.querySelector('button[aria-label=\"停止回应\"]'))"), true);
    release('Q'); await until(async () => /回复Q/.test(await text()), '排队回复');
    assert.equal(await js("[...document.querySelectorAll('.chat-copy')].filter(el => el.textContent.includes('回复Q')).length"), 1);
    check('排队续发恢复进行态，结果不重复');
    await send('验收I：后台失败也保留原因'); await waitPending('I');
    await open('会话B'); release('I');
    await until(async () => (await running('conv-switch-a')).status === 'error', '后台失败');
    const failed = await invoke(IPC.conversation.open, 'conv-switch-a');
    const failures = failed.turns.filter(t => t.kind === 'error');
    assert.equal(failures.length, 1);
    assert.match(failures[0].text, /401/);
    assert.doesNotMatch(await text(), /401/);
    await open('会话A'); await until(async () => /401/.test(await text()), '失败原因恢复');
    check('后台失败保存原因并归原会话');
    assert.deepEqual([...aborted], ['D']);
    assert.deepEqual(errors, []);
    const result = { ok: true, checks, calls, aborted: [...aborted], errors };
    writeFileSync(path.join(out, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(`HEMI_CONVERSATION_SWITCH_RESULT ${JSON.stringify(result)}`);
  } catch (error) {
    exitCode = 1; console.error(error);
    if (state.mainWindow) await shot('failure').catch(() => {});
  } finally {
    abortActiveTextModelTurn();
    disposeTaskManager();
    await shutdownBrowserBridgeService().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    state.isQuitting = true;
    state.mainWindow?.destroy();
    rmSync(dir, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
app.whenReady().then(main);
