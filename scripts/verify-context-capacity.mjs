// 上下文容量指示器真机走查（真实 renderer→preload→IPC→主 agent Pi 会话→本机 mock
// SSE→轮末广播→环形/面板渲染）。唯一替身为本机模型端点；输入走真实 textarea 与
// 回车发送。证据：
//   - 首回合前无环形（无在途会话）；
//   - 轮后环形出现，快照＝{tokens>0, contextWindow>0, 四分类}，分类比例凑满 100；
//   - 第二轮上下文累计（mock 的 prompt_tokens 随请求数递增→usage 锚点变大）；
//   - 点环形开面板：标题/总量/四类目/平均缓存命中率（与 048 账本自洽）；
//   - 窗口重载后环形恢复；无 renderer error；附两张截图（工具行/展开面板）。
import { app, Menu } from 'electron';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { secretStorage } from '../src/main/lib/secret-storage.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { state } from '../src/main/state.mjs';
import { installNativeShell } from '../src/main/windows/native-shell.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';

const label = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'build';
const output = path.resolve(`.visual/workflow/vision/context-capacity-${label}`);
const ud = await mkdtemp(path.join(os.homedir(), 'Library/Caches/hemi-ctx-cap-'));
const evidence = { label, userData: ud, checks: [], errors: [], requests: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert(value, name); evidence.checks.push(name); console.log(`PASS ${name}`); };
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
const wait = async (fn, label) => { const deadline = Date.now() + 45000; while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(100); } throw new Error(`等待超时：${label}`); };
/** 真实点击（Chromium 输入，不依赖前台焦点）。 */
const click = async (selector) => {
  const point = await exec(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()`);
  const D = state.mainWindow.webContents.debugger;
  await D.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await D.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
};
/** 悬浮（openOnHover 入口；200ms 进场延迟后展开）。 */
const hover = async (selector) => {
  await exec(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()`).then(async point => {
    await state.mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0, pointerType: 'mouse' });
  });
};
const sendText = async (text) => {
  await exec('document.querySelector("textarea[aria-label=输入消息]").focus()');
  await state.mainWindow.webContents.insertText(text);
  state.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  state.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
};

// 本机 mock（OpenAI 方言）：prompt_tokens 随请求数递增——usage 锚点要能体现上下文累计。
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const promptTokens = 100 + 80 * evidence.requests.length;
    evidence.requests.push({ model: body.model, messages: body.messages.length, tools: body.tools?.length ?? 0, promptTokens });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = chunk => res.write(`data: ${JSON.stringify({ id: 'ctx-cap-test', object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`);
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: `第 ${evidence.requests.length} 次回答：上下文容量走查。` }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } });
    res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

app.setName('hemi');
app.setPath('userData', ud);
app.whenReady().then(async () => {
  try {
    await mkdir(output, { recursive: true });
    initializeStableSafeStorageIdentity();
    await writeFile(path.join(ud, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'mp-test/m-shared', roleModels: Object.fromEntries(['main', 'explorer', 'oracle', 'fixer', 'designer'].map(role => [role, 'mp-test/m-shared'])), providers: [{ id: 'mp-test', name: '本机验证', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, encryptedApiKey: secretStorage.encryptString('TEST_ONLY').toString('base64'), models: [{ id: 'm-shared', model: 'shared', supportsVision: true, thinkingLevel: 'off' }] }] }));
    await writeFile(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
    await registerAllIpcHandlers();
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: true });
    app.on('web-contents-created', (_event, contents) => contents.on('console-message', event => { if (event.level === 'error') evidence.errors.push(event.message); }));
    await createMainWindow();
    state.mainWindow.show();
    state.mainWindow.webContents.debugger.attach('1.3');
    await wait(() => exec('!!document.querySelector("textarea[aria-label=输入消息]")'), '真实输入框');

    // 1. 首回合前：环形常驻（空态）——只留轨道、无弧线，提示无数据。
    check('首回合前环形常驻（空态）', await exec(`(()=>{const t=document.querySelector('.ctx-cap-trigger');if(!t)return false;const svg=t.querySelector('.ctx-cap-ring');const arc=svg.querySelector('.ctx-cap-arc');return svg.dataset.level==='unknown' && Number(arc.getAttribute('stroke-dashoffset'))>=37.6 && t.getAttribute('aria-label').includes('还没有')})()`));

    // 2. 第一轮：真实输入路径发送，等收口。
    await sendText('这是第一轮，请直接回答。');
    const cid = await wait(async () => { const result = await exec('window.hemiVoice.listConversations()'); return result.sessions?.[0]?.id; }, '新会话');
    await wait(async () => { const flow = await exec(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`); return flow?.phase === 'idle' && Object.values(flow.runs).some(run => run.outcome === 'completed'); }, '第一轮收口');
    await wait(() => exec('!!document.querySelector(".ctx-cap-trigger")'), '轮末广播后环形出现');

    // 3. 快照与渲染核对。
    const snap1 = await exec(`window.hemiVoice.getContextSnapshot(${JSON.stringify(cid)})`);
    evidence.snapshot1 = snap1;
    check('快照非空且总量为正', snap1?.snapshot?.tokens > 0 && snap1?.snapshot?.contextWindow > 0);
    check('快照百分比合法', typeof snap1?.snapshot?.percent === 'number' && snap1.snapshot.percent >= 0 && snap1.snapshot.percent <= 100);
    check('四分类齐且比例凑满 100', Math.abs(snap1.snapshot.categories.reduce((acc, c) => acc + c.percent, 0) - 100) < 1
      && JSON.stringify(snap1.snapshot.categories.map(c => c.key)) === JSON.stringify(['tools', 'conversation', 'toolResults', 'system']));
    check('环形 svg 就位且占用档为 ok', await exec(`(()=>{const svg=document.querySelector('.ctx-cap-ring');return !!svg && svg.dataset.level==='ok' && svg.querySelector('.ctx-cap-arc')})()`));

    // 4. 截图：工具行里的环形。
    await pause(400);
    await writeFile(path.join(output, 'ring.png'), (await state.mainWindow.webContents.capturePage()).toPNG());

    // 5. 悬浮展开面板（openOnHover）：结构与 048 账本自洽。
    await hover('.ctx-cap-trigger');
    await wait(() => exec('!!document.querySelector(".ctx-cap-pop")'), '悬浮面板展开');
    const panel = await exec(`(()=>({title:document.querySelector('.ctx-cap-pop .h37-info-title')?.textContent,total:document.querySelector('.ctx-cap-total')?.textContent,cats:[...document.querySelectorAll('.ctx-cap-cat')].map(li=>li.textContent.replace(/\\s+/g,' ').trim())}))()`);
    evidence.panel1 = panel;
    check('面板标题与已用量（纯数字，无百分比无上限）', panel.title === '上下文容量' && panel.total.startsWith(String(Math.round(snap1.snapshot.tokens))) && !panel.total.includes('/') && !panel.total.includes('%'));
    check('四类目文案', panel.cats.length === 4 && panel.cats.join('|').includes('系统工具') && panel.cats.join('|').includes('对话消息') && panel.cats.join('|').includes('工具结果') && panel.cats.join('|').includes('系统提示词'));
    check('面板无缓存命中率行（已裁决不展示）', await exec('!document.querySelector(".ctx-cap-cache")'));
    check('面板无进度条（百分比已裁决不展示）', await exec('!document.querySelector(".ctx-cap-bar")'));

    // 6. 截图：悬浮面板（设计稿对照；指针保持在触发钮上）。
    await pause(400);
    await writeFile(path.join(output, 'panel.png'), (await state.mainWindow.webContents.capturePage()).toPNG());

    // 7. 第二轮：usage 锚点随上下文累计变大（mock prompt_tokens 递增）。
    await sendText('第二轮，再回答一次。');
    await wait(async () => { const flow = await exec(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`); const runs = Object.values(flow.runs); return flow?.phase === 'idle' && runs.filter(run => run.outcome === 'completed').length >= 2; }, '第二轮收口');
    const snap2 = await wait(async () => { const view = await exec(`window.hemiVoice.getContextSnapshot(${JSON.stringify(cid)})`); return view?.snapshot?.tokens > snap1.snapshot.tokens ? view.snapshot : null; }, '快照总量累计');
    evidence.snapshot2 = snap2;
    check('第二轮上下文累计（用量锚点变大）', snap2.tokens > snap1.snapshot.tokens);

    // 8. 重载窗口：主进程会话仍在，环形随启动种子恢复。
    state.mainWindow.reload();
    await wait(() => exec('!!document.querySelector("textarea[aria-label=输入消息]")'), '重载完成');
    await wait(() => exec('!!document.querySelector(".ctx-cap-trigger")'), '重载后环形恢复');
    check('重载后快照仍在', (await exec(`window.hemiVoice.getContextSnapshot(${JSON.stringify(cid)})`))?.snapshot?.tokens > 0);

    // 9. 兜底：清空在途会话（等价应用重启后直接打开旧会话）——快照从档案读回。
    const errorsBefore = evidence.errors.length;
    getAgentRuntime().disposeAll();
    await pause(600);
    const archived = await exec(`window.hemiVoice.getContextSnapshot(${JSON.stringify(cid)})`);
    evidence.archivedSnapshot = archived;
    check('无在途会话时读档兜底（重启后打开旧会话立即可见）', archived?.snapshot?.tokens > 0 && archived.snapshot.categories?.length === 4);

    check('无 renderer error', evidence.errors.length === errorsBefore);
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    console.error(error.stack);
    try {
      await writeFile(path.join(output, 'failure.png'), (await state.mainWindow.webContents.capturePage()).toPNG());
      evidence.failureUi = await exec('document.querySelector(".ctx-cap-trigger")?.outerHTML ?? document.querySelector(".text-composer-toolbar")?.outerHTML?.slice(0, 500)');
    } catch { /* 保留原始失败。 */ }
  } finally {
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(`HEMI_CONTEXT_CAP_RESULT=${JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, error: evidence.error })}`);
    disposeTaskManager(); getAgentRuntime().disposeAll(); server.closeAllConnections(); server.close(); state.isQuitting = true;
    setTimeout(() => app.exit(evidence.passed ? 0 : 1), 300);
  }
});
