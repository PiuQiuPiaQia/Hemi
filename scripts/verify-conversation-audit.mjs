// 本地 mock 模型 + 真实 Electron IPC/Pi 回路；不使用用户密钥或历史会话。
import assert from 'node:assert/strict';
import { app, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../src/shared/ipc-channels.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { shutdownBrowserBridgeService } from '../src/main/services/browser-bridge-service.mjs';
import { getProfiles } from '../src/main/lib/profiles-holder.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-conversation-audit-'));
app.setPath('userData', dir);
const conversationId = 'conv-audit-durable';
const model = 'gpt-4o-mini';
let diagnosticsRead = false;
let greetingChecked = false;
let submissionSent = false;
let fallbackMode = false;
let fallbackChecked = false;
let calls = 0;
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls += 1;
    if (fallbackMode && body.model === model) {
      response.writeHead(503);
      response.end('temporary service unavailable');
      return;
    }
    const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    if (fallbackMode && body.model === 'gpt-4o') {
      const projected = JSON.parse(system.split('\n').find((line) => line.startsWith('{"current":')));
      assert.equal(projected.current.dialogue.requestedModel, 'gpt-4o');
      assert.equal(projected.current.execution.requestedModel, model);
      fallbackChecked = true;
    }
    const user = body.messages.findLast((message) => message.role === 'user')?.content ?? '';
    const tools = body.tools?.map((tool) => tool.function.name) ?? [];
    const toolResult = body.messages.findLast((message) => message.role === 'tool');
    let content = '核验完成。';
    let call = null;
    const toolCall = (name, args) => ({ index: 0, id: `call_${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    if (system.includes('你给一段对话起标题')) content = '诊断会话';
    else if (tools.includes('submit_task_result')) {
      if (!submissionSent) {
        submissionSent = true;
        call = toolCall('submit_task_result', {
          proposedVerdict: 'complete', summary: '本会话的诊断身份已核对。',
          checks: [{ target: '核对当前会话诊断身份', status: 'satisfied', evidence: `宿主上下文 conversationId=${conversationId}`, kind: 'goal' }],
          missing: [], sideEffects: [],
        });
      }
    } else if (String(user).includes('你好')) {
      assert.equal(tools.length, 0, '纯问候不得声明动手工具');
      greetingChecked = true;
      content = '你好呀。';
    } else if (tools.includes('execute_task') && String(user).includes('提交核验结果')) {
      call = toolCall('execute_task', { task: '核对当前会话诊断身份，提交核验结果' });
    } else if (tools.includes('get_runtime_diagnostics') && !toolResult) {
      // 恶意/错误的参数也不能改变宿主冻结的会话归属。
      call = toolCall('get_runtime_diagnostics', { conversationId: 'conv-other' });
    } else if (toolResult) {
      const diagnostic = JSON.parse(toolResult.content);
      assert.equal(diagnostic.current.conversationId, conversationId);
      const requestedModel = fallbackMode ? 'gpt-4o' : model;
      assert.equal(diagnostic.current.dialogue.requestedModel, requestedModel);
      assert.equal(diagnostic.current.instance, 'development');
      assert.equal(diagnostic.current.logPath, path.join(dir, 'hemi.log'));
      assert.doesNotMatch(toolResult.content, /mock-secret/);
      diagnosticsRead = true;
      content = `本轮请求型号为 ${requestedModel}。`;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
      id: `cmpl_${calls}`, object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    frame({ role: 'assistant' });
    frame(call ? { tool_calls: [call] } : { content });
    frame({}, call ? 'tool_calls' : 'stop');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});

const invoke = (channel, payload) => ipcMain._invokeHandlers.get(channel)({}, payload);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  let exitCode = 0;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.HEMI_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    process.env.HEMI_LLM_API_KEY = 'mock-secret';
    process.env.HEMI_LLM_MODEL = model;
    await registerAllIpcHandlers();
    const user = { id: 'user-query', text: '查一下本轮诊断', author: 'user', createdAt: Date.now() };
    await invoke(IPC.conversation.save, { id: conversationId, turns: [user] });
    const reply = await invoke(IPC.llm.chat, { turnId: 1, conversationId, inputSource: 'text', messages: [{ role: 'user', content: user.text }] });
    assert.equal(diagnosticsRead, true);
    assert.match(reply.text, /gpt-4o-mini/);
    // 没有渲染层保存回复；旧全表回写模拟重载，宿主回复仍必须存在。
    await invoke(IPC.conversation.save, { id: conversationId, turns: [user] });
    let session = await invoke(IPC.conversation.open, conversationId);
    assert.equal(session.turns.filter((turn) => turn.id === reply.responseId).length, 1);
    assert.equal(session.runtimeDiagnostics.length, 1);
    assert.equal((await invoke(IPC.task.getState)).tasks.length, 0);
    const greet = { id: 'user-greet', author: 'user', text: '你好啊', createdAt: Date.now() };
    await invoke(IPC.conversation.save, { id: conversationId, turns: [...session.turns, greet] });
    await invoke(IPC.llm.chat, { turnId: 2, conversationId, inputSource: 'text', messages: [{ role: 'user', content: greet.text }] });
    assert.equal(greetingChecked, true);
    assert.equal((await invoke(IPC.task.getState)).tasks.length, 0);
    session = await invoke(IPC.conversation.open, conversationId);
    const taskUser = { id: 'user-task', author: 'user', text: '核对当前会话诊断身份，提交核验结果', createdAt: Date.now() };
    await invoke(IPC.conversation.save, { id: conversationId, turns: [...session.turns, taskUser] });
    await invoke(IPC.llm.chat, { turnId: 3, conversationId, inputSource: 'text', workspaceId: 'default', messages: [{ role: 'user', content: taskUser.text }] });
    let task;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      task = (await invoke(IPC.task.getState)).tasks[0];
      if (task?.phase === 'terminal') break;
      if (task?.permission) await invoke(IPC.task.action, { action: 'decide', taskId: task.taskId, choice: task.permission.kind === 'grant' ? 'task' : 'once' });
      await wait(100);
    }
    assert.equal(task?.outcome, 'complete');
    assert.ok(task.endedAt >= task.startedAt);
    await invoke(IPC.conversation.save, { id: conversationId, turns: [user] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      session = await invoke(IPC.conversation.open, conversationId);
      assert.equal(session.turns.filter((turn) => turn.kind === 'task' && turn.taskId === task.taskId).length, 1);
      assert.equal(session.turns.filter((turn) => turn.kind !== 'task' && turn.taskId === task.taskId).length, 1);
      assert.ok(session.turns.some((turn) => turn.id === reply.responseId));
    }
    // 首选服务 503 后切备用：提示词、只读工具与留存记录必须同时更新型号。
    delete process.env.HEMI_LLM_BASE_URL;
    delete process.env.HEMI_LLM_API_KEY;
    delete process.env.HEMI_LLM_MODEL;
    const profiles = getProfiles();
    const provider = await profiles.saveProvider({
      id: 'mock-routing', name: '本地模拟', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'mock-secret',
      models: [{ id: 'chat', model }, { id: 'fallback', model: 'gpt-4o' }],
    });
    await profiles.saveAutoRouting({ chatModelKey: provider.modelKeys[0] });
    await profiles.saveAutoRouting({ executionModelKey: provider.modelKeys[0] });
    await profiles.saveAutoRouting({ fallbackModelKey: provider.modelKeys[1] });
    fallbackMode = true;
    const fallbackUser = { id: 'user-fallback', author: 'user', text: '核对本轮备用诊断', createdAt: Date.now() };
    await invoke(IPC.conversation.save, { id: conversationId, turns: [...session.turns, fallbackUser] });
    const fallbackReply = await invoke(IPC.llm.chat, { turnId: 4, conversationId, inputSource: 'text', profileId: 'auto', messages: [{ role: 'user', content: fallbackUser.text }] });
    assert.equal(fallbackChecked, true);
    assert.match(fallbackReply.text, /gpt-4o/);
    session = await invoke(IPC.conversation.open, conversationId);
    assert.equal(session.runtimeDiagnostics.at(-1).dialogue.requestedModel, 'gpt-4o');
    console.log(`HEMI_CONVERSATION_AUDIT_RESULT ${JSON.stringify({ ok: true, diagnosticsRead, greetingChecked, fallbackChecked, taskOutcome: task.outcome, restoredTurns: session.turns.length, calls })}`);
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    try { disposeTaskManager(); } catch { /* 启动失败时尚未建 manager */ }
    await shutdownBrowserBridgeService().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
app.whenReady().then(main);
