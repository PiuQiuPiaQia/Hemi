// 060：真实 Electron／Pi SDK／本地 provider，验证已释放驻留实例按历史重建。
import { app } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getProfiles } from '../src/main/lib/profiles-holder.mjs';
import { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } from '../src/main/agent-runtime/model-policy.mjs';
import { createAgentRuntime } from '../src/main/agent-runtime/index.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi060-agent-recovery-'));
app.setName('hemi');
app.setPath('userData', path.join(root, 'userData'));
const requests = [];
let runtime, server;
app.whenReady().then(async () => {
try {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const events = [];
      const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `ANSWER_${requests.length}` } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
      ev('message_stop', {});
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.join(''));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let archived = null;
  runtime = createAgentRuntime({
    loadArchiveAgent: () => archived, loadArchiveTurns: () => [],
    saveArchiveAgent: (_id, payload) => { archived = payload; return true; },
    getSkillService: () => null, getWorkspaceService: () => null,
    onEventTurn: () => {}, onTaskState: () => {},
  });
  await getProfiles().saveProvider({id:'mock',name:'recovery',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',models:[{id:'main',model:'claude-opus-5-5',api:'anthropic-messages',supportsVision:true}]});
  const policySnapshot=await freezeModelPolicy({store:getProfiles(),modelKey:'mock/main'});
  const modelPlan=await hydrateModelPlan(resolveModelPlan(policySnapshot),getProfiles());
  const context = { runId:'recovery-1', generation:0, policySnapshot, modelPlan, conversationId: 'conv-recovery', inputSource: 'text', workspace: null, routed: false,
    config: { modelKey: 'mock/main', baseUrl: `http://127.0.0.1:${server.address().port}`, api: 'anthropic-messages', apiKey: 'test', model: 'claude-opus-5-5', supportsVision: true } };
  const old = await runtime.obtain(context);
  assert.equal((await runtime.runRootTurn(context.conversationId, { userText: 'OLD_GOAL_SYNTHETIC' })).lastText, 'ANSWER_1');
  await runtime.completeConversation(context.conversationId,'completed',null,context.runId);
  context.runId='recovery-2';
  old.dispose(); // 超时释放走同一 dispose 生命周期；SDK 单测另覆盖真实 abort 超时。
  assert.equal(old.isDisposed(), true);
  const fresh = await runtime.obtain(context);
  assert.notEqual(fresh, old, '不能复用已释放会话');
  assert.equal((await runtime.runRootTurn(context.conversationId, { userText: 'NEW_GOAL_SYNTHETIC' })).lastText, 'ANSWER_2');
  await runtime.completeConversation(context.conversationId,'completed',null,context.runId);
  assert.match(JSON.stringify(requests[1]), /OLD_GOAL_SYNTHETIC/);
  assert.equal(requests.length, 2);
  assert.equal(await runtime.obtain(context), fresh, '健康驻留实例继续复用');
  const beforeCut = archived;
  const exportEntries = fresh.exportEntries;
  let releaseExport;
  const held = new Promise(resolve => { releaseExport = resolve; });
  fresh.exportEntries = async () => { const payload = await exportEntries(); await held; return payload; };
  const latePersist = runtime.persist(context.conversationId);
  runtime.invalidate(context.conversationId);
  releaseExport();
  assert.equal(await latePersist, false, '回卷之前发起的旧导出不得写回新档案');
  assert.equal(archived, beforeCut, '已失效实例没有覆盖回卷档案');
  const lruContext = { ...context, conversationId: 'conv-lru-0' };
  const lru = await runtime.obtain(lruContext);
  const exportLru = lru.exportEntries;
  let releaseLru;
  const lruHeld = new Promise(resolve => { releaseLru = resolve; });
  lru.exportEntries = async () => { const payload = await exportLru(); await lruHeld; return payload; };
  for (let index = 1; index <= 8; index += 1) await runtime.obtain({ ...context, conversationId: `conv-lru-${index}` });
  assert.equal(runtime.get(lruContext.conversationId), null, '确实触发了 LRU 驱逐');
  runtime.invalidate(lruContext.conversationId); // 不驻留时回卷也必须作废尚未完成的导出。
  releaseLru();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archived, beforeCut, 'LRU 的旧导出不能复活回卷前的 SDK 历史');
  console.log(`HEMI_VERIFY_060_AGENT_RECOVERY=${JSON.stringify({ ok: true, requests: requests.length, historyPreserved: true, disposedEntryRebuilt: true, healthyEntryReused: true, latePersistRejected: true, lruLateExportRejected: true })}`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  runtime?.disposeAll(); server?.closeAllConnections(); server?.close();
  fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode ?? 0);
}

});
