// node scripts/verify-059-preparation-restart.mjs
// 两个 Electron 进程，经真实 IPC 创建/恢复准备卡；仅 provider HTTP 端点可控。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stage = process.env.HEMI059_PREPARATION_STAGE;
if (!stage) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi059-preparation-restart-')));
  const evidence = path.resolve(process.env.HEMI059_EVIDENCE ?? '.visual/workflow/vision/059-main-preparation/restart');
  fs.mkdirSync(evidence, { recursive: true });
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ tools: (body.tools ?? []).map(tool => tool.function?.name), text: JSON.stringify(body.messages) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'restart-prep', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      chunk({ role: 'assistant', content: '主 agent 继续正常聊天' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const require = createRequire(import.meta.url);
  const launch = phase => new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], {
      cwd: process.cwd(), env: { ...process.env, HEMI_SMOKE_TEST: '1', HEMI059_PREPARATION_STAGE: phase, HEMI059_PREPARATION_TEMP: temp, HEMI059_PREPARATION_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('exit', code => { fs.writeFileSync(path.join(evidence, `${phase}.log`), output); code === 0 ? resolve() : reject(new Error(output)); });
  });
  let fatal;
  try {
    await launch('create');
    assert.equal(requests.length, 0, '创建准备卡零模型请求');
    await launch('restore');
    assert.equal(requests.filter(request => request.tools.includes('workflow_preparation')).length, 1, '恢复后普通输入直接进入主 agent');
    assert.ok(requests.every(request => !request.text.includes('［工作流补参')));
    console.log('HEMI059_PREPARATION_RESTART_PASS');
  } catch (error) { fatal = error.stack; console.error(fatal); }
  finally {
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: !fatal, fatal, requests: requests.map(({ text, ...request }) => request) }, null, 2));
    server.closeAllConnections(); server.close(); fs.rmSync(temp, { recursive: true, force: true });
    process.exitCode = fatal ? 1 : 0;
  }
} else {
  const { app, safeStorage } = await import('electron');
  const temp = process.env.HEMI059_PREPARATION_TEMP, cid = 'conv-preparation-restart';
  app.setName('hemi'); app.setPath('userData', path.join(temp, 'ud'));
  const sourceRoot = path.resolve(process.env.HEMI059_SOURCE_ROOT ?? 'src');
  const source = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  void app.whenReady().then(async () => {
  let runtime;
  try {
    if (stage === 'create') {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'restore/model', providers: [{ id: 'restore', name: '恢复验证', baseUrl: process.env.HEMI059_PREPARATION_ENDPOINT, encryptedApiKey: safeStorage.encryptString('isolated-test').toString('base64'), models: [{ id: 'model', model: 'restore-model' }] }] }));
      fs.writeFileSync(path.join(app.getPath('userData'), 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now(), updatedAt: Date.now() }));
    }
    await (await source('main/ipc/index.mjs')).registerAllIpcHandlers();
    await (await source('main/windows/main-window.mjs')).createMainWindow();
    const win = (await source('main/state.mjs')).state.mainWindow;
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js('Boolean(window.hemiVoice)')); i++) await sleep(50);
    runtime = (await source('main/ipc/llm.ipc.mjs')).getAgentRuntime();
    if (stage === 'create') {
      const document = { nodes: [
        { id: 'in', type: 'hemi-input', data: { parameters: [{ key: 'topic', type: 'string', required: true }] } },
        { id: 'a', type: 'hemi-agent', data: { goal: '不应在恢复时执行', outputSchema: { type: 'object', properties: { result: { type: 'string' } } } } },
        { id: 'end', type: 'hemi-deliver', data: { summary: '不应执行' } },
      ], edges: [{ sourceNodeID: 'in', targetNodeID: 'a' }, { sourceNodeID: 'a', targetNodeID: 'end' }] };
      const prepared = await js(`(async()=>{const d=await window.hemiVoice.workflowSaveDraft('restore-preparation',${JSON.stringify(document)},'跨进程准备卡');await window.hemiVoice.workflowPublish('restore-preparation',d.draftRevision);return window.hemiVoice.workflowPrepare({workflowId:'restore-preparation',conversationId:${JSON.stringify(cid)},entryMode:'chat'})})()`);
      assert.equal(prepared.ready, false);
      fs.writeFileSync(path.join(temp, 'prepared.json'), JSON.stringify(prepared));
    } else {
      const prepared = JSON.parse(fs.readFileSync(path.join(temp, 'prepared.json'), 'utf8'));
      const card = await js(`window.hemiVoice.workflowGetInvocation(${JSON.stringify(prepared.invocationId)})`);
      assert.equal(card.draftRevision, prepared.draftRevision);
      assert.equal(card.startReceipt, null);
      const before = Object.keys((await runtime.journal.snapshot()).requests).length;
      await sleep(350);
      assert.equal(Object.keys((await runtime.journal.snapshot()).requests).length, before, '恢复不发模型请求');
      const receipt = await js(`window.hemiVoice.submitChatTurn(${JSON.stringify({ conversationId: cid, profileId: 'restore/model', workspaceId: 'default', inputSource: 'text', requestId: 'ordinary-after-restart', messages: [{ role: 'user', content: '先聊别的，回复你好' }] })})`);
      let flow;
      for (let i = 0; i < 200; i++) { flow = await js(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`); if (flow.runs[receipt.runId]?.closedAt) break; await sleep(50); }
      assert.equal(flow.runs[receipt.runId]?.outcome, 'completed');
      assert.ok(flow.timeline.some(item => item.kind === 'assistant' && item.runId === receipt.runId && item.parts?.some(part => part.kind === 'text')));
      const after = await js(`window.hemiVoice.workflowGetInvocation(${JSON.stringify(prepared.invocationId)})`);
      assert.equal(after.draftRevision, card.draftRevision);
      assert.deepEqual(after.preparation.values, {});
      assert.equal(after.startReceipt, null);
    }
    await runtime.disposeAll(); app.exit(0);
  } catch (error) { console.error(error.stack); await runtime?.disposeAll(); app.exit(1); }
  });
}
