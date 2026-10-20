// 真实 renderer→preload→IPC→主／子 Pi→HTTP→持久账本→角色表。
// 唯一替身为本机模型端点；不自动批准权限，不替换内部工厂。
import { app, safeStorage, Menu } from 'electron';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { state } from '../src/main/state.mjs';
import { installNativeShell } from '../src/main/windows/native-shell.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';

const label = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'build';
const output = path.resolve(`.visual/workflow/vision/048-usage-product-${label}${process.env.HEMI_USAGE_VERIFY_VARIANT ? `-${process.env.HEMI_USAGE_VERIFY_VARIANT}` : ''}`);
const ud = await mkdtemp(path.join(os.homedir(), 'Library/Caches/hemi-048-usage-'));
const evidence = { label, userData: ud, checks: [], requests: [], errors: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, value) => { assert(value, name); evidence.checks.push(name); console.log(`PASS ${name}`); };
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
const moveMouse = (x, y) => state.mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
const hoverUsage = async () => {
  await moveMouse(1, 70);
  await pause(350); // 等会话收口后的输入区有限动效结束，再取实际命中位置。
  const point = await exec('(()=>{const r=document.querySelector(".h48-usage-entry").getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()');
  await moveMouse(point.x, point.y);
};
const wait = async (fn, label) => { const deadline = Date.now() + 45000; while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(100); } throw new Error(`等待超时：${label}`); };
const selectDimension = async dimension => {
  await pause(250); // 等 200ms 入场与定位完成，再按真实屏幕位置点击控件。
  const point = await exec(`(()=>{const buttons=[...document.querySelectorAll('.h48-usage-switch button')];const r=buttons[${dimension === 'role' ? 0 : 1}].getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()`);
  await moveMouse(point.x, point.y);
  await state.mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await state.mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await wait(() => exec(`document.querySelector('.h48-usage-table')?.dataset.dimension === '${dimension}'`), `切换 ${dimension}`);
};
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const main = body.tools?.some(tool => tool.function?.name === 'task');
    const hasResults = body.messages.some(message => message.role === 'tool');
    const calls = main && !hasResults ? ['explorer', 'oracle'].map((role, index) => ({ index, id: `usage-role-${index}`, type: 'function', function: { name: 'task', arguments: JSON.stringify({ agent: role, description: `${role} 用量验证`, prompt: `只回复：${role} 已完成，不调用工具。` }) } })) : [];
    evidence.requests.push({ model: body.model, main: Boolean(main), toolCalls: calls.length });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = chunk => res.write(`data: ${JSON.stringify({ id: 'usage-test', object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`);
    send({ choices: [{ index: 0, delta: { role: 'assistant', ...(calls.length ? { tool_calls: calls } : { content: '角色用量验证已完成。' }) }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } });
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
    await writeFile(path.join(ud, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'mp-test/m-shared', roleModels: Object.fromEntries(['main', 'explorer', 'oracle', 'fixer', 'designer'].map(role => [role, 'mp-test/m-shared'])), providers: [{ id: 'mp-test', name: '本机验证', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, encryptedApiKey: safeStorage.encryptString('TEST_ONLY').toString('base64'), models: [{ id: 'm-shared', model: 'shared', supportsVision: true, thinkingLevel: 'off' }] }] }));
    await writeFile(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
    await registerAllIpcHandlers();
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: true });
    app.on('web-contents-created', (_event, contents) => contents.on('console-message', event => { if (event.level === 'error') evidence.errors.push(event.message); }));
    await createMainWindow();
    state.mainWindow.show();
    // Chromium 实际输入，不依赖 macOS 前台焦点；不能让并行工作窗口抢焦造成假失败。
    state.mainWindow.webContents.debugger.attach('1.3');
    await wait(() => exec('!!document.querySelector("textarea[aria-label=输入消息]")'), '真实输入框');
    evidence.rendererUrl = state.mainWindow.webContents.getURL();
    await exec('document.querySelector("textarea[aria-label=输入消息]").focus()');
    await state.mainWindow.webContents.insertText('请分别委派侦察和顾问，各回复一句，再告诉我已完成。');
    state.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    state.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    const cid = await wait(async () => { const result = await exec('window.hemiVoice.listConversations()'); return result.sessions?.[0]?.id; }, '新会话');
    await wait(async () => { const flow = await exec(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`); return flow?.phase === 'idle' && Object.values(flow.runs).some(run => run.outcome === 'completed'); }, '根目标与子工作收口');
    const ledger = await exec(`window.hemiVoice.getUsageLedger(${JSON.stringify(cid)})`);
    check('真实 IPC 账本含主助手、侦察、顾问', ['main', 'explorer', 'oracle'].every(role => ledger.records.some(record => record.role === role)));
    check('所有角色使用同一个准确模型', ledger.records.every(record => record.modelKey === 'mp-test/m-shared'));
    await wait(() => exec('!!document.querySelector(".h48-usage-entry")'), '底部预览');
    await hoverUsage();
    await wait(() => exec('!!document.querySelector(".h48-usage-table")'), '角色表格');
    const rows = await exec('[...document.querySelectorAll(".h48-usage-table tbody tr")].map(row=>[...row.cells].map(cell=>cell.textContent))');
    check('直接展示三个角色的数据行', ['主助手', '侦察', '顾问'].every(role => rows.some(row => row[0] === role)));
    check('角色调用总数等于真实 HTTP 请求数', rows.reduce((sum, row) => sum + Number(row[1].replaceAll(',', '')), 0) === evidence.requests.length);
    check('没有统计说明或折叠明细', await exec('!document.querySelector(".h48-usage-panel details") && !document.querySelector(".h48-usage-panel").innerText.includes("统计说明")'));
    for (const width of [1440, 768, 375]) {
      state.mainWindow.setMinimumSize(300, 400);
      state.mainWindow.setContentSize(width, 900);
      await hoverUsage();
      await wait(() => exec('!!document.querySelector(".h48-usage-table")'), '悬浮展开');
      await selectDimension('role');
      await pause(350);
      await writeFile(path.join(output, `roles-${width}.png`), (await state.mainWindow.webContents.capturePage()).toPNG());
      check(`${width} 角色表格无溢出`, await exec('(()=>{const e=document.querySelector(".h48-usage-table"),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth&&r.left>=0&&r.right<=innerWidth})()'));
      const totals = await exec('document.querySelector(".h48-usage-totals").textContent');
      await selectDimension('model');
      check(`${width} 共用模型合并且与请求数对账`, await exec(`[...document.querySelectorAll('.h48-usage-table tbody tr')].length === 1 && Number(document.querySelector('.h48-usage-table tbody td').textContent.replaceAll(',', '')) === ${evidence.requests.length}`));
      check(`${width} 切换后整体汇总不变`, totals === await exec('document.querySelector(".h48-usage-totals").textContent'));
      await pause(250);
      await writeFile(path.join(output, `models-${width}.png`), (await state.mainWindow.webContents.capturePage()).toPNG());
      check(`${width} 模型表格无溢出`, await exec('(()=>{const e=document.querySelector(".h48-usage-table"),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth&&r.left>=0&&r.right<=innerWidth})()'));
      await selectDimension('role');
    }
    check('悬浮面板无关闭叉号', await exec('!document.querySelector(".h48-usage-panel .h37-info-close")'));
    await selectDimension('model');
    await moveMouse(1, 70);
    await wait(() => exec('!document.querySelector(".h48-usage-panel")'), '退出动画完成');
    await hoverUsage();
    await wait(() => exec('!!document.querySelector(".h48-usage-table")'), '重新打开');
    check('关闭重开保持模型视图', await exec('document.querySelector(".h48-usage-table").dataset.dimension === "model"'));
    await selectDimension('role');
    const before = JSON.stringify(await exec('[...document.querySelectorAll(".h48-usage-table tbody tr")].map(row=>row.textContent)'));
    state.mainWindow.reload();
    await wait(() => exec('!!document.querySelector(".h48-usage-entry")'), '重载后从持久账本读取');
    await hoverUsage();
    await wait(() => exec('!!document.querySelector(".h48-usage-table")'), '重载后打开');
    check('重载后角色表格保持一致', before === JSON.stringify(await exec('[...document.querySelectorAll(".h48-usage-table tbody tr")].map(row=>row.textContent)')));
    await selectDimension('model');
    check('重载后模型统计仍与账本一致', await exec(`[...document.querySelectorAll('.h48-usage-table tbody tr')].length === 1 && Number(document.querySelector('.h48-usage-table tbody td').textContent.replaceAll(',', '')) === ${evidence.requests.length}`));
    check('重载不重新调用模型', evidence.requests.length === ledger.records.length);
    check('无 renderer error', evidence.errors.length === 0);
    evidence.rows = rows;
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    console.error(error.stack);
    try {
      await writeFile(path.join(output, 'failure.png'), (await state.mainWindow.webContents.capturePage()).toPNG());
      evidence.failureUi = await exec('(()=>{const e=document.querySelector(".h48-usage-entry"),r=e?.getBoundingClientRect();return {entry:e?.outerHTML,rect:r?.toJSON(),hit:r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML:undefined,focus:document.activeElement?.tagName}})()');
    } catch { /* 保留原始失败。 */ }
  }
  finally {
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(`HEMI_USAGE_PRODUCT_RESULT=${JSON.stringify({ passed: evidence.passed, rendererUrl: evidence.rendererUrl, checks: evidence.checks.length, error: evidence.error })}`);
    disposeTaskManager(); getAgentRuntime().disposeAll(); server.closeAllConnections(); server.close(); state.isQuitting = true;
    setTimeout(() => app.exit(evidence.passed ? 0 : 1), 300);
  }
});
