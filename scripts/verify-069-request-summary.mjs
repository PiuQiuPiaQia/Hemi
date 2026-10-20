// 069：仅替代外部 provider；真实 renderer/preload/IPC/主子 agent/read/交付/账本。
import { app, safeStorage } from 'electron';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { state } from '../src/main/state.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { BUDGET_SUMMARY_SYSTEM } from '../src/main/agent-runtime/budget-summary.mjs';

const root = await mkdtemp(path.join(os.homedir(), 'Library/Caches/hemi-069-'));
const ud = path.join(root, 'user-data'), file = path.join(root, 'progress.txt'), forbidden = path.join(root, 'forbidden.txt');
await mkdir(ud); await writeFile(file, `PROGRESS_${randomUUID()}`);
app.setName('hemi'); app.setPath('userData', ud);
const evidence = { userData: ud, provider: 'controlled-local-endpoint', semanticModelQuality: false, checks: [], requests: [] };
const check = (name, pass) => { evidence.checks.push({ name, pass: Boolean(pass) }); assert.ok(pass, name); console.log(`PASS ${name}`); };
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label) { const end = Date.now() + 60000; while (Date.now() < end) { const v = await fn(); if (v) return v; await pause(50); } throw new Error(`等待超时：${label}`); }
const cases = new Map();
const shq = value => `'${String(value).replaceAll("'", "'\\''")}'`;
let heldSummary = null;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), anthropic = req.url.includes('/messages');
    const all = JSON.stringify(body.messages), id = [...body.messages].reverse().map(m => JSON.stringify(m.content).match(/BUDGET_CASE:([a-z-]+)/)?.[1]).find(Boolean);
    const scenario = cases.get(id), summary = JSON.stringify(body.system ?? body.messages.filter(m => m.role === 'system')).includes(BUDGET_SUMMARY_SYSTEM);
    const tools = body.tools ?? [], main = tools.some(t => (t.name ?? t.function?.name) === 'task');
    evidence.requests.push({ case: id, summary, model: body.model, protocol: anthropic ? 'anthropic' : 'openai', toolCount: tools.length, toolChoice: body.tool_choice, historySummaryMarkers: [...new Set(all.match(/SUMMARY_[a-f0-9-]+/g) ?? [])] });
    let text = '预算验证', calls = [];
    if (summary) {
      check(`${id} 总结没有工具且明确禁用工具`, tools.length === 0 && (body.tool_choice === 'none' || body.tool_choice?.type === 'none'));
      check(`${id} 总结使用冻结主模型`, body.model === (id === 'anthropic' ? 'summary-anthropic' : 'summary-main'));
      check(`${id} 总结包含原始目标及执行事实`, all.includes('userRequest') && all.includes('toolFacts'));
      if (id === 'artifact') check('主总结收到已登记成果的真实入口', all.includes('registeredDeliveries') && all.includes('delivery.txt'));
      if (id === 'http-error') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'controlled summary failure' } })); return; }
      if (['stop-summary','promote-summary','queued-summary'].includes(id)) { heldSummary = { id, res, body }; await wait(() => scenario.release, '释放总结端点'); }
      if (id === 'rogue') calls = [{ name: 'write', args: { path: forbidden, content: 'must not execute' } }];
      else text = id === 'empty' ? '' : `SUMMARY_${scenario.marker}：已取得已有进展；剩余验收尚未完成，因为达到请求上限。下一步可继续。`;
    } else if (scenario && tools.length) {
      const hasResults = body.messages.some(m => m.role === 'tool' || Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
      const called = body.messages.flatMap(m => [...(m.tool_calls ?? []).map(t => t.function?.name), ...(Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.name) : [])]);
      if (id === 'normal' || id === 'next') text = id === 'next' ? `NEXT_${scenario.marker}` : `NORMAL_${scenario.marker}`;
      else if (id === 'auth-error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'controlled auth failure' } })); return; }
      else if (main && ['inflight','stop-inflight'].includes(id) && !hasResults) {
        calls = ['BUDGET_HELD','BUDGET_LOOP'].map(kind => ({ name: 'task', args: { agent: 'fixer', description: kind, prompt: `BUDGET_CASE:${id} ${kind} 验证在途任务。` } }));
      } else if (!main && ['inflight','stop-inflight'].includes(id) && all.includes('BUDGET_HELD')) {
        const started = path.join(root, `${id}-started`), release = path.join(root, `${id}-release`), done = path.join(root, `${id}-done`);
        calls = [{ name: 'bash', args: { command: `printf started > ${shq(started)}; while [ ! -f ${shq(release)} ]; do sleep 0.05; done; printf finished > ${shq(done)}`, timeout_ms: 60000 } }];
      } else if (!main && ['inflight','stop-inflight'].includes(id)) {
        const ref = all.match(/ctx-[a-f0-9]{64}/)?.[0]; assert.ok(ref, '真实子任务必须获得受控输入引用');
        calls = [{ name: 'context_read', args: { ref } }];
      } else if (main && ['child','parallel'].includes(id) && !hasResults) {
        calls = Array.from({ length: id === 'parallel' ? 3 : 1 }, (_, index) => ({ name: 'task', args: { agent: 'fixer', description: `预算子任务 ${index}`, prompt: `BUDGET_CASE:${id} 请持续读取本次进展文件 ${file}，报告实际结果。` } }));
      } else if (id === 'artifact' && !all.includes('PRODUCED_069')) calls = [{ name: 'write', args: { path: path.join(root, 'delivery.txt'), content: `PRODUCED_069_${scenario.marker}` } }];
      else if (id === 'artifact' && !called.includes('register_delivery')) calls = [{ name: 'register_delivery', args: { files: [{ path: path.join(root, 'delivery.txt'), description: '已产生的阶段文件' }] } }];
      else calls = [{ name: 'read', args: { path: file } }];
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    } else if (anthropic) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      if (calls.length) calls.forEach((call, index) => { event('content_block_start', { index, content_block: { type: 'tool_use', id: randomUUID(), name: call.name, input: {} } }); event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }); event('content_block_stop', { index }); });
      else { event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }); event('content_block_stop', { index: 0 }); }
      event('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } }); event('message_stop', {}); res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: text };
      for (const chunk of [{ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }]) res.write(`data: ${JSON.stringify({ id: 'budget-test', object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  } catch (error) { evidence.providerError = error.stack; if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function submit(id, cid = `conv-budget-${id}`) {
  const receipt = await exec(`window.hemiVoice.submitChatTurn(${JSON.stringify({ conversationId: cid, profileId: id === 'anthropic' ? 'summary-anthropic/main' : ['child','parallel','inflight','stop-inflight'].includes(id) ? 'auto' : 'summary-openai/main', workspaceId: 'default', inputSource: 'text', requestId: randomUUID(), turnId: Date.now(), messages: [{ role: 'user', content: `BUDGET_CASE:${id} 请完成本次任务；已有进展在 ${file}。` }] })})`);
  check(`${id} 真实聊天入口受理`, receipt.ok); return cid;
}
async function settled(cid, count = 1) {
  return wait(async () => { const flow = await exec(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`); return flow?.phase === 'idle' && Object.keys(flow.runs).length >= count && flow; }, cid);
}
async function verifyCase(id) {
  const scenario = { marker: randomUUID() }; cases.set(id, scenario);
  const cid = await submit(id);
  if (['inflight','stop-inflight'].includes(id)) {
    await wait(() => access(path.join(root, `${id}-started`)).then(() => true, () => false), '真实 shell 已开始');
    await wait(async () => Object.values((await getAgentRuntime().journal.snapshot()).roots).some(r => r.owner.conversationId === cid && r.requestLimitReached), '执行触顶');
    check(`${id} 在途工具完成前没有发起总结`, !evidence.requests.some(r => r.case === id && r.summary));
    if (id === 'stop-inflight') await exec(`window.hemiVoice.cancelTextModel({conversationId:${JSON.stringify(cid)}})`);
    else await writeFile(path.join(root, `${id}-release`), 'release');
  }
  if (['stop-summary','promote-summary','queued-summary'].includes(id)) {
    await wait(() => heldSummary?.id === id, '总结请求确实已开始');
    check(`${id} 总结期间主 agent 仍显示在忙`, getAgentRuntime().get(cid).isBusy());
    if (id === 'stop-summary') {
      await exec(`window.hemiVoice.cancelTextModel({conversationId:${JSON.stringify(cid)}})`);
    } else {
      cases.set('next', { marker: randomUUID() });
      const receipt = await exec(`window.hemiVoice.submitChatTurn(${JSON.stringify({ conversationId: cid, profileId: 'summary-openai/main', inputSource: 'text', requestId: randomUUID(), workspaceId: 'default', messages: [{ role: 'user', content: 'BUDGET_CASE:next 只回应本轮新任务。' }] })})`);
      check('优先目标已排队', receipt.ok);
      if (id === 'promote-summary') {
        const promotion = exec(`window.hemiVoice.flowCommand(${JSON.stringify(cid)},${JSON.stringify({ type: 'promoteInput', inputId: receipt.inputId })})`);
        await pause(100); scenario.release = true; check('总结响应结束后优先交接成功', (await promotion).ok);
      } else {
        await pause(100); const flow = await exec(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`);
        check('总结期间普通输入保持排队', flow.pending.some(item => item.inputId === receipt.inputId)); scenario.release = true;
      }
    }
  }
  const flow = await settled(cid, ['promote-summary','queued-summary'].includes(id) ? 2 : 1);
  if (id === 'stop-summary') { scenario.release = true; await pause(150); }
  await wait(async () => {
    const s = await getAgentRuntime().journal.snapshot(), r = Object.values(s.roots).find(item => item.owner.conversationId === cid && item.kind !== 'auxiliary');
    const rows = Object.values(s.requests).filter(item => (s.roots[item.owner.rootRunId]?.sourceRootRunId ?? item.owner.rootRunId) === r.owner.rootRunId);
    return rows.every(item => item.endedAt) && rows.length === evidence.requests.filter(item => item.case === id).length;
  }, `${id} 实际 HTTP 与账本全部落定`);
  const saved = JSON.parse(await readFile(path.join(ud, 'runtime-v2/conversations', `${cid}.json`), 'utf8'));
  const journal = await getAgentRuntime().journal.snapshot();
  const rootRecord = Object.values(journal.roots).find(r => r.owner.conversationId === cid && r.kind !== 'auxiliary');
  const requests = Object.values(journal.requests).filter(r => (journal.roots[r.owner.rootRunId]?.sourceRootRunId ?? r.owner.rootRunId) === rootRecord.owner.rootRunId);
  const summaries = requests.filter(r => r.purpose === 'budget-summary'), executions = requests.filter(r => r.purpose !== 'budget-summary');
  check(`${id} 账本与实际 HTTP 数一致`, requests.length === evidence.requests.filter(r => r.case === id).length);
  if (['normal','auth-error'].includes(id)) {
    check(`${id} 正常结束或鉴权失败不额外总结`, summaries.length === 0);
    check(`${id} 根目标终态正确`, rootRecord.status === (id === 'normal' ? 'completed' : 'failed'));
    return;
  }
  check(`${id} 完整使用 60 次执行额度`, executions.length === 60);
  check(`${id} 仅额外一次总结且身份为主 agent`, id === 'stop-inflight' ? summaries.length === 0 : summaries.length === 1 && summaries[0].role === 'main' && !summaries[0].owner.taskId);
  if (id === 'stop-summary') {
    check('主动停止收口且迟到总结未写入历史', rootRecord.status === 'cancelled' && !JSON.stringify(saved).includes(`SUMMARY_${scenario.marker}`));
  } else if (id === 'stop-inflight') {
    await writeFile(path.join(root, `${id}-release`), 'late-release'); await pause(150);
    check('在途停止后无迟到 shell 写入，也不发总结', rootRecord.status === 'cancelled' && !await access(path.join(root, `${id}-done`)).then(() => true, () => false));
  } else if (id === 'promote-summary' || id === 'queued-summary') {
    check('插队后旧目标不续跑，新目标成功', Object.values(flow.runs).at(-1).outcome === 'completed' && JSON.stringify(saved).includes('NEXT_'));
  } else {
    const fallback = ['http-error','rogue','empty'].includes(id);
    check(`${id} 有总结但目标没有被伪装完成`, rootRecord.status === (id === 'artifact' ? 'partial' : 'failed'));
    check(`${id} 总结或兜底正文进入历史与 SDK 上下文`, saved.turns.some(turn => turn.author === 'hemi' && turn.text.includes(fallback ? '已有成果和过程记录已保留' : `SUMMARY_${scenario.marker}`)) && JSON.stringify(saved.agentSession.entries).includes(fallback ? '已有成果和过程记录已保留' : `SUMMARY_${scenario.marker}`));
    check(`${id} 总结结果持久且符合实际路径`, rootRecord.budgetSummary.state === (fallback ? 'fallback' : 'complete'));
    if (id === 'inflight') check('触顶后已启动 shell 按原契约完成并保留实际结果', await readFile(path.join(root, 'inflight-done'), 'utf8') === 'finished' && Object.values(journal.observations).some(o => o.owner.rootRunId === rootRecord.owner.rootRunId && o.tool === 'bash' && o.outcome === 'ok'));
    if (['child','parallel'].includes(id)) check(`${id} 必要子任务都已收口`, Object.values(journal.tasks).filter(t => t.owner.rootRunId === rootRecord.owner.rootRunId).length === (id === 'parallel' ? 3 : 1));
    if (id === 'artifact') {
      const artifact = Object.values(flow.artifacts)[0]; check('阶段交付仍可通过产品读取', Boolean(artifact) && (await exec(`window.hemiVoice.readConversationDeliverable(${JSON.stringify(cid)},${JSON.stringify(artifact.artifactId)})`)).text?.includes(`PRODUCED_069_${scenario.marker}`));
    }
    if (id === 'main') {
      cases.set('next', { marker: randomUUID() }); await submit('next', cid); const next = await settled(cid, 2);
      check('用户新输入获得新额度且旧总结仍在上下文', Object.values(next.runs).at(-1).outcome === 'completed' && (await getAgentRuntime().usageRecordsFor(cid)).length > 61 && evidence.requests.some(req => req.case === 'next' && req.historySummaryMarkers.includes(`SUMMARY_${scenario.marker}`)));
    }
  }
}
async function verifyWorkflow() {
  const id = 'workflow', cid = 'conv-budget-workflow', scenario = { marker: randomUUID() }; cases.set(id, scenario);
  const document = {
    nodes: [
      { id: 'input', type: 'hemi-input', data: { title: '输入', parameters: [{ key: 'topic', label: '主题', type: 'string', required: false }] } },
      { id: 'execute', type: 'hemi-agent', data: { title: '执行', goal: `BUDGET_CASE:workflow 读取 ${file} 并完成本次工作。`, inputBindings: [{ kind: 'parameter', key: 'topic', type: 'string' }], outputSchema: { type: 'object', properties: { result: { type: 'string' } } } } },
      { id: 'deliver', type: 'hemi-deliver', data: { title: '交付', summary: '本次结果', artifacts: [{ label: '结果', binding: { kind: 'node-output', nodeId: 'execute', key: 'result', type: 'string' } }] } },
    ], edges: [{ sourceNodeID: 'input', targetNodeID: 'execute' }, { sourceNodeID: 'execute', targetNodeID: 'deliver' }],
  };
  const prepared = await exec(`(async()=>{const d=await window.hemiVoice.workflowSaveDraft('budget-workflow',${JSON.stringify(document)},'预算验证');await window.hemiVoice.workflowPublish('budget-workflow',d.draftRevision);return window.hemiVoice.workflowPrepare(${JSON.stringify({ workflowId: 'budget-workflow', conversationId: cid, entryMode: 'direct', executionModel: { mode: 'fixed', modelKey: 'summary-openai/main' }, workspaceId: 'default' })});})()`);
  const receipt = await exec(`window.hemiVoice.workflowStartPrepared(${JSON.stringify({ invocationId: prepared.invocationId, conversationId: cid, requestId: randomUUID(), expectedDraftRevision: prepared.draftRevision })})`);
  check('工作流真实产品入口受理', receipt.ok);
  const invocation = await wait(async () => { const value = await exec(`window.hemiVoice.workflowGetInvocation(${JSON.stringify(prepared.invocationId)})`); return ['failed','completed'].includes(value?.run?.status) && value; }, '工作流触顶收口');
  const journal = await getAgentRuntime().journal.snapshot(), workflowRoot = Object.values(journal.roots).find(r => r.owner.conversationId === cid && r.kind === 'workflow');
  const requests = Object.values(journal.requests).filter(r => r.owner.rootRunId === workflowRoot.owner.rootRunId);
  check('工作流同样使用 60 次执行加一次主总结', requests.filter(r => r.purpose !== 'budget-summary').length === 60 && requests.filter(r => r.purpose === 'budget-summary').length === 1 && evidence.requests.filter(r => r.case === id).length === 61);
  check('工作流总结作为未完成原因保留，没有假装交付成功', invocation.run.status === 'failed' && JSON.stringify(invocation.run).includes(`SUMMARY_${scenario.marker}`));
}
app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    const encryptedApiKey = safeStorage.encryptString('SYNTHETIC_069_KEY').toString('base64');
    await writeFile(path.join(ud, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'summary-openai/main', roleModels: { main: 'summary-openai/main', fixer: 'summary-openai/fixer', fallback: 'summary-openai/backup' }, providers: [
      { id: 'summary-openai', name: '预算验证', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, encryptedApiKey, models: [{ id: 'main', model: 'summary-main' }, { id: 'fixer', model: 'summary-fixer' }, { id: 'backup', model: 'summary-backup' }] },
      { id: 'summary-anthropic', name: '预算验证 Anthropic', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${server.address().port}`, encryptedApiKey, models: [{ id: 'main', model: 'summary-anthropic' }] },
    ] }));
    await writeFile(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
    await registerAllIpcHandlers(); await createMainWindow(); evidence.rendererUrl = state.mainWindow.webContents.getURL();
    await wait(() => exec('Boolean(window.hemiVoice?.submitChatTurn)'), 'preload');
    for (const id of (process.env.HEMI_069_CASES ?? 'main,child,parallel,anthropic,http-error,rogue,empty,artifact,normal,auth-error,inflight,stop-inflight,stop-summary,promote-summary,queued-summary,workflow').split(',')) await (id === 'workflow' ? verifyWorkflow() : verifyCase(id));
    check('异常总结的工具调用没有执行', !await access(forbidden).then(() => true, () => false));
    check('总结失败没有切备用', !evidence.requests.some(r => r.model === 'summary-backup'));
    check('外部端点没有断言错误', !evidence.providerError);
  } catch (error) { evidence.error = error.stack; console.error(error); }
  finally {
    evidence.passed = !evidence.error && evidence.checks.every(item => item.pass);
    const output = path.resolve('.visual/workflow/vision/069-request-summary-product.json'); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(evidence, null, 2));
    console.log(`HEMI_069_SUMMARY_RESULT=${JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, output, userData: ud, error: evidence.error })}`);
    disposeTaskManager(); getAgentRuntime().disposeAll(); server.closeAllConnections(); server.close(); state.isQuitting = true; setTimeout(() => app.exit(evidence.passed ? 0 : 1), 300);
  }
});
