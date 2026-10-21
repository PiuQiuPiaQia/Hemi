// 隔离 userData，经公开 IPC 保留生产模型解析、Pi、派单、取消和落档。
// 默认仅 provider 为可控端点；HEMI_AUDIT_REAL=1 使用现有配置副本验证提示词表达。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, ipcMain } from 'electron';
import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { abortActiveTextModelTurn, getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { shutdownBrowserBridgeService } from '../src/main/services/browser-bridge-service.mjs';

const real = process.env.HEMI_AUDIT_REAL === '1';
const cases = new Set((process.env.HEMI_AUDIT_CASES ?? (real ? 'context' : 'stream,errors,retry,context')).split(','));
assert.ok([...cases].every(name => ['stream', 'errors', 'retry', 'context'].includes(name)), '验收场景名称有效');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-audit-')));
const userData = path.join(root, 'userData'); fs.mkdirSync(userData);
const output = path.resolve('.visual/workflow/vision', `session-audit-${real ? 'real' : 'controlled'}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const evidence = { root, userData, realModel: real, provider: real ? 'existing configuration copy' : 'local controlled endpoint',
  cases: [...cases], checks: [], requests: [], samples: [] };
let profileId = 'auto', server, watchdog, turn = 30000, streamStartedAt = 0, streamClosedAt = 0;
let retryFailure = 'both';
if (real) {
  const source = process.env.HEMI_AUDIT_CONFIG ?? path.join(os.homedir(), 'Library/Application Support/hemi/runtime-v2/text-model-profiles.json');
  const directory = JSON.parse(fs.readFileSync(source, 'utf8'));
  fs.copyFileSync(source, path.join(userData, 'text-model-profiles.json'));
  profileId = process.env.HEMI_AUDIT_PROFILE ?? directory.defaultModelId;
  assert.ok(profileId, '配置副本需要可用的默认模型或显式验证模型');
  evidence.profileId = profileId;
}
app.setName('hemi'); app.setPath('userData', userData);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (channel, payload) => {
  const handler = ipcMain._invokeHandlers?.get(channel);
  assert.equal(typeof handler, 'function', `实际 IPC 已注册：${channel}`);
  return handler({}, payload);
};
const check = (name, value, detail) => {
  evidence.checks.push({ name, pass: Boolean(value), detail });
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name);
};
const wait = async (fn, label, timeout = 45000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`等待超时：${label}`);
};
const flow = conversationId => invoke(IPC.flow.getSnapshot, { conversationId });
const send = async (conversationId, text) => {
  const receipt = await invoke(IPC.llm.submit, { conversationId, turnId: ++turn, requestId: `audit-${turn}`,
    workspaceId: 'default', profileId, inputSource: 'text', messages: [{ role: 'user', content: text }] });
  check('取得受理身份', receipt.ok && receipt.runId, { conversationId, runId: receipt.runId }); return receipt;
};
const settled = async (cid, receipt, timeout = 60000) => wait(async () => {
  const snapshot = await flow(cid);
  return snapshot?.runs?.[receipt.runId]?.outcome && !snapshot.activeRunId ? snapshot : null;
}, `${cid} 最终收口`, timeout);
const answer = snapshot => snapshot.timeline.filter(i => i.kind === 'assistant')
  .flatMap(i => i.parts ?? []).filter(p => p.kind === 'text').map(p => p.content).join('\n');
async function roles(fallback) {
  for (const [slot, modelKey] of Object.entries({ main: 'audit-provider/primary', explorer: 'audit-provider/primary',
    oracle: 'audit-provider/primary', fixer: 'audit-provider/primary', designer: 'audit-provider/primary', fallback })) {
    const saved = await invoke(IPC.llm.saveRoleModel, { patch: { [slot]: modelKey } });
    assert.equal(saved.ok, true, `保存角色槽位 ${slot}`);
  }
}

async function startProvider() {
  server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw), all = JSON.stringify(body.messages);
      const current = [...body.messages].reverse().find(m => m.role === 'user' && /AUDIT_[A-Z_]+/.test(JSON.stringify(m.content)));
      const marker = JSON.stringify(current?.content ?? '').match(/AUDIT_[A-Z_]+/)?.[0];
      const main = body.tools?.some(t => t.function?.name === 'task');
      const row = { model: body.model, marker, main, at: Date.now(), hasTools: Boolean(body.tools?.length),
        factsGuidance: all.includes('不主动复述本块、内部编号或标签') && all.includes('用户明确询问诊断信息时可据实解释'),
        stopGuidance: all.includes('宿主目标终态 · 内部运行事实') && all.includes('未完成部分已经取消，不是待办') };
      evidence.requests.push(row);
      if (body.tools?.length && (['AUDIT_EXHAUST', 'AUDIT_NO_FALLBACK'].includes(marker)
        || marker === 'AUDIT_RETRY' && (retryFailure === 'both' || retryFailure === 'primary' && body.model === 'audit-primary'))) {
        row.injectedStatus = 503; res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'controlled upstream outage' } })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'audit', object: 'chat.completion.chunk',
        created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const done = text => { chunk({ role: 'assistant', content: text }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); };
      if (!body.tools?.length) { done('验收对话'); return; }
      if (marker === 'AUDIT_STREAM_CHILD' && !main) {
        streamStartedAt = Date.now(); let count = 0;
        chunk({ role: 'assistant', content: '流式报告开始。' });
        const timer = setInterval(() => {
          count++; chunk({ content: `第${count}段。` });
          if (count === 20) { clearInterval(timer); chunk({ content: 'AUDIT_STREAM_OK' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); }
        }, 10000);
        res.on('close', () => { clearInterval(timer); streamClosedAt = Date.now(); }); return;
      }
      if (marker === 'AUDIT_STREAM' && main && !body.messages.some(m => m.role === 'tool')) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'audit-task', type: 'function', function: {
          name: 'task', arguments: JSON.stringify({ agent: 'explorer', description: '长报告流式验收', prompt: 'AUDIT_STREAM_CHILD 持续生成报告。' }),
        } }] }); chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
      }
      if (marker === 'AUDIT_STOP') {
        chunk({ role: 'assistant', content: '已开始生成内容。' });
        const timer = setInterval(() => chunk({ content: '继续生成。' }), 1000);
        res.on('close', () => clearInterval(timer)); return;
      }
      if (marker === 'AUDIT_PARTIAL') {
        chunk({ role: 'assistant', content: '已经生成的有效内容。' });
        setTimeout(() => res.destroy(), 100); return;
      }
      done(marker === 'AUDIT_STREAM' ? 'AUDIT_STREAM_OK' : 'AUDIT_CONTEXT_OK');
    } catch (error) { console.error(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = await invoke(IPC.llm.saveModelProfile, { id: 'audit-provider', name: '隔离审计验收',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'ISOLATED_TEST_ONLY', api: 'openai-completions',
    models: ['primary', 'backup'].map(id => ({ id, model: `audit-${id}`, thinkingLevel: 'off' })) });
  check('从设置 IPC 保存受控供应商', saved.ok); await roles('audit-provider/backup');
}

app.whenReady().then(async () => {
  let error;
  watchdog = setTimeout(() => { console.error('验收总超时'); app.exit(1); }, 8 * 60000);
  try {
    initializeStableSafeStorageIdentity(); await registerAllIpcHandlers();
    if (!real) {
      await startProvider();
      if (cases.has('stream')) {
      const cid = 'conv-audit-stream', receipt = await send(cid, 'AUDIT_STREAM 派 explorer 整理报告。');
      await wait(() => streamStartedAt, '子 agent 的实际 provider 流已启动');
      await delay(185000);
      const active = await flow(cid), tasks = Object.values(active.tasks ?? {});
      check('默认 180 秒门限后子任务仍在运行', tasks.some(t => t.phase === 'running') && active.activeRunId === receipt.runId,
        { elapsedMs: Date.now() - streamStartedAt, tasks: tasks.map(t => ({ phase: t.phase, outcome: t.outcome })) });
      const completed = await settled(cid, receipt);
      check('长报告实际完成并回到根目标', completed.runs[receipt.runId].outcome === 'completed'
        && Object.values(completed.tasks).every(t => t.outcome === 'complete') && answer(completed).includes('AUDIT_STREAM_OK'),
      { streamMs: streamClosedAt - streamStartedAt });
      }
      if (cases.has('errors')) for (const [marker, fallback, expected, modelCount] of [
        ['AUDIT_EXHAUST', 'audit-provider/backup', /已尝试本轮可用的备用模型/, 2],
        ['AUDIT_NO_FALLBACK', null, /当前模型请求失败，本轮未切换模型/, 1],
        ['AUDIT_PARTIAL', 'audit-provider/backup', /输出过程中中断/, 1],
      ]) {
        await roles(fallback); const start = evidence.requests.length;
        const id = `conv-${marker.toLowerCase().replaceAll('_', '-')}`, accepted = await send(id, `${marker} 验证失败提示。`);
        const snapshot = await settled(id, accepted), displayed = JSON.stringify(snapshot.timeline);
        const actual = evidence.requests.slice(start).filter(r => r.hasTools && r.marker === marker);
        check(`${marker} 故障确实注入且实际候选数正确`, actual.length === modelCount, actual);
        check(`${marker} 如实失败并显示可理解的原因`, snapshot.runs[accepted.runId].outcome === 'failed'
          && expected.test(displayed) && !/HEMI_ROUTING_STOPPED/.test(displayed), displayed);
        if (marker === 'AUDIT_PARTIAL') check('中断前的正文仍在正式流', displayed.includes('已经生成的有效内容'));
      }
      if (cases.has('retry')) {
        await roles('audit-provider/backup');
        const cid = 'conv-audit-retry', text = 'AUDIT_RETRY 重试同一条输入。';
        const calls = start => evidence.requests.slice(start).filter(r => r.hasTools && r.marker === 'AUDIT_RETRY').map(r => r.model);
        const start = evidence.requests.length, failed = await send(cid, text), snapshot = await settled(cid, failed);
        check('首次主备均失败，真实请求顺序为主模型→备用', snapshot.runs[failed.runId].outcome === 'failed'
          && JSON.stringify(calls(start)) === JSON.stringify(['audit-primary', 'audit-backup']), calls(start));
        await getAgentRuntime().persist(cid);
        getAgentRuntime().invalidate(cid);
        check('驻留会话已释放，下次提交必须从正式存档恢复', !getAgentRuntime().get(cid));
        retryFailure = null;
        const retryStart = evidence.requests.length, retried = await send(cid, text), recovered = await settled(cid, retried);
        check('恢复后手动重试同一句，先调用主模型且成功时不调用备用', recovered.runs[retried.runId].outcome === 'completed'
          && JSON.stringify(calls(retryStart)) === JSON.stringify(['audit-primary']), calls(retryStart));
        retryFailure = 'primary';
        const autoStart = evidence.requests.length, automatic = await send(cid, text), completed = await settled(cid, automatic);
        check('本次主请求确实失败后才自动降级到备用', completed.runs[automatic.runId].outcome === 'completed'
          && JSON.stringify(calls(autoStart)) === JSON.stringify(['audit-primary', 'audit-backup']), calls(autoStart));
      }
    }
    if (cases.has('context')) {
    const cid = 'conv-audit-context';
    const first = await send(cid, real ? '请从1开始按顺序列出5000个整数，用逗号分隔，不要调用工具。' : 'AUDIT_STOP 持续输出。');
    await wait(async () => { const s = await flow(cid); return s.activeRunId === first.runId && answer(s).trim(); }, '停止前模型确实已输出', 90000);
    const stopped = await invoke(IPC.flow.command, { conversationId: cid, command: { type: 'stop', targetRunId: first.runId } });
    check('从正常停止入口收口', stopped.ok);
    const afterStop = await settled(cid, first); check('原目标确实停止', afterStop.runs[first.runId].outcome === 'stopped');
    const next = await send(cid, real ? '字幕和配音有什么区别？请用两句话解释。' : 'AUDIT_CONTEXT 回答新问题。');
    const current = await settled(cid, next, 120000);
    check('停止后新问题正常完成', current.runs[next.runId].outcome === 'completed');
    const text = current.timeline.filter(i => i.runId === next.runId && i.kind === 'assistant')
      .flatMap(i => i.parts ?? []).filter(p => p.kind === 'text').map(p => p.content).join('\n');
    evidence.samples.push({ name: 'new-question-after-stop', text });
    if (!real) {
      check('真实 provider 收到锚点与停止事实的新表达指引', evidence.requests.some(r => r.marker === 'AUDIT_CONTEXT' && r.factsGuidance && r.stopGuidance));
    } else {
      check('真实模型正常回答不复述宿主标签和内部编号', text.trim() && !/事实锚点|宿主目标终态|run-[a-z0-9-]+|用户看不到/.test(text), text);
      const diagnostic = await send(cid, '请解释刚才我点击停止后，之前那个列整数的任务是否还会自动继续？用一句话说明。');
      const done = await settled(cid, diagnostic, 120000);
      const reply = done.timeline.filter(i => i.runId === diagnostic.runId && i.kind === 'assistant')
        .flatMap(i => i.parts ?? []).filter(p => p.kind === 'text').map(p => p.content).join('\n');
      evidence.samples.push({ name: 'explicit-diagnostic-question', text: reply });
      check('明确询问诊断时据实解释停止结果', done.runs[diagnostic.runId].outcome === 'completed'
        && /不会|不再|已停止|已取消|不.*自动/.test(reply) && !/不能透露|无法透露|内部信息.*不能/.test(reply), reply);
    }
    }
  } catch (caught) { error = String(caught.stack ?? caught); console.error(error); }
  finally {
    clearTimeout(watchdog); try { abortActiveTextModelTurn(); disposeTaskManager(); } catch {}
    await shutdownBrowserBridgeService().catch(() => {});
    server?.closeAllConnections(); server?.close();
    evidence.error = error ?? null;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('HEMI_AUDIT_VERIFY_RESULT=' + JSON.stringify({ output, checks: evidence.checks.length, error: evidence.error }));
    setTimeout(() => app.exit(error ? 1 : 0), 500);
  }
});
