// 产品入口验证：真实 renderer／配置 IPC／runtime／SDK；仅外部 provider 为本机端点。
// 不替换内部工厂、不注入正确运行态、不自动批准确认卡。只使用虚构测试凭据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import electronPath from 'electron';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-pi-chain-'));
const userData = path.join(root, 'userData');
const evidence = path.resolve(process.env.HEMI_PI_CHAIN_EVIDENCE ?? `.visual/workflow/vision/pi-model-chain-${Date.now()}`);
fs.mkdirSync(userData); fs.mkdirSync(evidence, { recursive: true });
// 引导完成配置是隔离测试资源；所有模型通过真实配置 IPC 创建，没有补写会话运行态。
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
const requests = [], checks = {}, servers = [];
let phase = 'BOOT', child, ws, call, evalJs, rendererUrl;
const injected = new Set();
const textOf = (message) => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const waitFor = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`超时：${label}`);
};
function stream(res, body, text, tool = null) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (data) => res.write(`data: ${JSON.stringify({ id: `pi-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, ...data })}\n\n`);
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    : { role: 'assistant', content: text };
  emit({ choices: [{ index: 0, delta, finish_reason: null }] });
  emit({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } });
  res.end('data: [DONE]\n\n');
}
async function endpoint(label) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw), flat = JSON.stringify(body.messages);
      const summary = /structured context checkpoint|concise checkpoint|context summarization assistant/.test(flat);
      const agent = Boolean(body.tools?.length);
      const credential = ['original', 'rotated', 'backup'].find((key) => req.headers.authorization === `Bearer audit-${key}`) ?? 'unexpected';
      const record = { phase, endpoint: label, path: req.url, credential, agent, summary, body };
      requests.push(record);
      const fault = label === 'A' && agent && !summary && (
        phase === 'SDK_503' && !injected.has(phase)
        || phase === 'SDK_OVERFLOW' && !injected.has(phase)
        || phase === 'SDK_OVERFLOW_THEN_503'
        || phase === 'SDK_OVERFLOW_FAIL'
        || phase === 'SDK_401'
      );
      if (fault) {
        injected.add(phase);
        const attempts = requests.filter((r) => r.phase === phase && r.endpoint === 'A' && r.agent && !r.summary).length;
        const status = phase === 'SDK_503' || phase === 'SDK_OVERFLOW_THEN_503' && attempts > 1 ? 503 : phase === 'SDK_401' ? 401 : 400;
        record.injectedStatus = status;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: status === 400 ? 'context_length_exceeded: maximum context length exceeded' : `${status} synthetic provider failure`, code: status === 400 ? 'context_length_exceeded' : 'synthetic_failure' } }));
        return;
      }
      let tool = null;
      if (['SDK_TOOL_ERROR', 'SDK_MAIN_TOOL_ERROR'].includes(phase) && agent && body.messages.at(-1)?.role !== 'tool') {
        tool = phase === 'SDK_TOOL_ERROR' && body.tools.some((item) => item.function.name === 'task')
          ? { name: 'task', args: { agent: 'explorer', description: '验证真实工具失败', prompt: `SDK_CHILD_ERROR：读取 /tmp/hemi-pi-missing-${path.basename(root)}.txt。失败后报告错误，不创建文件。` } }
          : { name: 'read', args: { path: `/tmp/hemi-pi-missing-${path.basename(root)}.txt` } };
      }
      stream(res, body, summary ? 'Checkpoint: previous synthetic work completed; continue the latest request.' : agent ? `ANSWER_${phase}` : '模型链路验证', tool);
    });
  });
  servers.push(server); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
}
async function start() {
  const portProbe = http.createServer(); await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port; await new Promise((r) => portProbe.close(r));
  const fd = fs.openSync(path.join(evidence, 'electron.log'), 'w');
  const env = { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_AGENT_COMPACTION_KEEP_RECENT: '100' };
  for (const key of Object.keys(env)) if (key.startsWith('HEMI_LLM_')) delete env[key];
  child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []))
    .find((item) => item.type === 'page' && !/mode=/.test(item.url)), '主窗口');
  rendererUrl = page.url;
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  let seq = 0; const pending = new Map();
  ws.onmessage = (event) => { const message = JSON.parse(event.data), item = pending.get(message.id); if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); } };
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  evalJs = async (expression) => { const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result?.value; };
  await waitFor(() => evalJs('Boolean(window.hemiVoice && document.querySelector("textarea.text-composer-input"))').catch(() => false), '输入框');
}
const invoke = (method, arg) => evalJs(`window.hemiVoice[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
async function reload() {
  await evalJs('window.__piChainOldDocument = true'); await call('Page.reload', { ignoreCache: true });
  await waitFor(() => evalJs('!window.__piChainOldDocument && Boolean(document.querySelector("textarea.text-composer-input"))').catch(() => false), '重新载入');
}
async function selectModel(label) {
  await evalJs('document.querySelector(".h24-model-chip").click()');
  await waitFor(() => evalJs(`(() => { const b=[...document.querySelectorAll('.h37-model-menu [role="menuitemradio"]')].find(e=>!e.disabled && e.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return Boolean(b); })()`), `选择模型 ${label}`);
  await waitFor(() => evalJs(`(() => { const b=document.querySelector('.h24-model-chip'); return b?.textContent.includes(${JSON.stringify(label)}) && ${label === '自动路由' ? "b.dataset.auto === 'true'" : "b.dataset.auto !== 'true'"}; })()`), '所选模型已显示');
}
async function selectLevel(level) {
  const label = { low: '低', medium: '中', high: '高' }[level];
  await evalJs(`document.querySelector('button[aria-label^="思考强度："]').click()`);
  await waitFor(() => evalJs(`(() => { const b=[...document.querySelectorAll('.h37-thinking-menu [role="menuitemradio"]')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return Boolean(b); })()`), `选择思考 ${level}`);
  await waitFor(() => evalJs(`document.querySelector('button[aria-label^="思考强度："]').getAttribute('aria-label').includes(${JSON.stringify(label)})`), '档位显示');
}
async function send(name, { error = false } = {}) {
  phase = name;
  const before = requests.length;
  await evalJs(`(() => { const ta=document.querySelector('textarea.text-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(name)}); ta.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => evalJs(`(() => { const b=document.querySelector('.text-composer-send:not(.is-stop)'); if(!b || b.disabled)return false;b.click();return true; })()`), '真实发送');
  await waitFor(() => requests.slice(before).some((r) => r.agent && !r.summary), 'provider 已收到请求');
  await waitFor(() => evalJs(`!document.querySelector('.text-composer-send.is-stop, .text-composer-stop') && ${error ? 'true' : `document.body.innerText.includes(${JSON.stringify(`ANSWER_${name}`)})`}`), '本轮收口');
  await waitFor(() => {
    const entries = archive()?.agentSession?.entries ?? [];
    const input = entries.findLastIndex((entry) => entry.message?.role === 'user' && textOf(entry.message).includes(name));
    return input >= 0 && entries.slice(input + 1).some((entry) => entry.message?.role === 'assistant'
      && (error ? entry.message.errorMessage : JSON.stringify(entry.message.content).includes(`ANSWER_${name}`)));
  }, 'SDK 归档完成');
  console.log(`[pi-chain] ${name} 收口`);
  return requests.slice(before).filter((r) => r.agent && !r.summary);
}
function archive() {
  const dir = path.join(userData, 'conversations');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter((f) => /^conv-.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f))))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
async function screenshot(name) {
  await invoke('showMainWindow'); await call('Page.bringToFront');
  fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from((await call('Page.captureScreenshot', { format: 'png', fromSurface: false })).data, 'base64'));
}
try {
  const a = await endpoint('A'), b = await endpoint('B'); await start();
  const provider = { id: 'primary', name: 'A 主模型', baseUrl: a, api: 'openai-completions', apiKey: 'audit-original', models: [{ id: 'm', model: 'audit-generic', thinkingLevel: 'default', supportsVision: true }] };
  await invoke('saveModelProfile', provider);
  await invoke('saveModelProfile', { ...provider, id: 'backup', name: 'B 同名备用', baseUrl: b, apiKey: 'audit-backup' });
  await invoke('setDefaultModelProfile', 'primary/m'); await invoke('setLastConversationModel', 'primary/m');
  await invoke('saveRoleModel', { main: 'primary/m' }); await invoke('saveRoleModel', { fallback: 'backup/m' });
  await reload(); await selectModel('audit-generic');
  // 最短产品闭环先验证高档，再扩展三档和故障恢复。
  for (const level of ['high', 'low', 'medium']) {
    await selectLevel(level); const calls = await send(`SDK_LEVEL_${level}`);
    assert.equal(calls[0].body.reasoning_effort, level);
    assert.equal(calls[0].path, '/v1/chat/completions'); assert.equal(calls[0].credential, 'original');
    assert.equal(archive().profileId, 'primary/m', '正式归档所选具体模型，不能误走自动路由');
    checks[`manual_${level}`] = true;
  }
  await screenshot('manual-three-levels');
  const title = await waitFor(() => requests.find((r) => !r.agent && !r.summary && JSON.stringify(r.body.messages).includes('SDK_LEVEL_high')), '实际自动标题请求');
  assert.equal(title.path, '/v1/chat/completions'); assert.equal(title.credential, 'original');
  assert.ok(!title.body.reasoning_effort); assert.ok(title.body.max_tokens <= 32768);
  checks.lightweightTitleUsesSharedEndpoint = true;
  await invoke('saveModelProfile', { ...provider, baseUrl: b, apiKey: 'audit-rotated' });
  const changed = (await send('SDK_CONFIG_CHANGED'))[0];
  assert.equal(changed.endpoint, 'B'); assert.equal(changed.credential, 'rotated');
  assert.match(JSON.stringify(changed.body.messages), /SDK_LEVEL_high/);
  checks.configurationChangesPreserveHistory = true;
  await invoke('saveModelProfile', { ...provider, baseUrl: b });
  const keyOnly = (await send('SDK_KEY_ONLY_CHANGED'))[0];
  assert.equal(keyOnly.endpoint, 'B'); assert.equal(keyOnly.credential, 'original');
  checks.keyOnlyChangeApplied = true;

  await invoke('saveModelProfile', { ...provider, apiKey: 'audit-rotated', models: [{ ...provider.models[0], thinkingFormat: 'qwen', model: 'deepseek-flash' }] });
  const format = (await send('SDK_EXPLICIT_FORMAT'))[0];
  assert.equal(format.body.enable_thinking, true); assert.ok(!format.body.thinking && !format.body.reasoning_effort);
  checks.explicitFormatOverridesCatalog = true;

  await invoke('saveModelProfile', { ...provider, apiKey: 'audit-rotated' });
  const mainError = await send('SDK_MAIN_TOOL_ERROR');
  assert.ok(mainError.some((r) => r.body.messages.some((m) => m.role === 'tool' && /无法读取（not-found）/.test(textOf(m)))));
  assert.equal(archive().agentSession.entries.findLast((entry) => entry.message?.role === 'toolResult').message.isError, true);
  const flow = await invoke('flowGetSnapshot', archive().id);
  assert.ok(flow.timeline.flatMap((item) => item.parts ?? [])
    .some((part) => part.kind === 'tool' && part.tool === 'read' && part.status === 'error'));
  fs.writeFileSync(path.join(evidence, 'tool-error-flow.json'), JSON.stringify(flow, null, 2));
  checks.failedMainToolMatchesSdkAndFlow = true;
  await selectModel('自动路由');
  const fallback = await send('SDK_503');
  assert.equal(fallback.filter((r) => r.endpoint === 'A').length, 1);
  assert.equal(fallback.filter((r) => r.endpoint === 'B').length, 1);
  assert.equal(fallback[0].injectedStatus, 503); assert.equal(fallback[1].credential, 'backup');
  assert.equal(fallback[0].body.model, fallback[1].body.model);
  checks.sameNameDifferentEndpointFallback = true;
  assert.equal((await send('SDK_PRIMARY_RESET'))[0].endpoint, 'A'); checks.newTurnReturnsToPrimary = true;

  assert.equal(fs.existsSync(`/tmp/hemi-pi-missing-${path.basename(root)}.txt`), false);
  const tools = await send('SDK_TOOL_ERROR');
  assert.ok(tools.some((r) => r.body.messages.some((m) => m.role === 'tool' && /无法读取（not-found）/.test(textOf(m)))));
  const tasks = await invoke('getTaskState');
  const failedChild = tasks.tasks.find((task) => task.recentToolCalls?.some((tool) => tool.tool === 'read' && tool.isError));
  assert.ok(failedChild, '子 agent 宿主快照标记真实 read 失败');
  checks.failedToolPropagatesToChildState = true;
  fs.writeFileSync(path.join(evidence, 'task-state.json'), JSON.stringify(tasks, null, 2));

  const overflow = await send('SDK_OVERFLOW');
  assert.ok(injected.has('SDK_OVERFLOW')); assert.ok(overflow.length >= 2);
  assert.ok(overflow.every((r) => r.endpoint === 'A'));
  assert.ok(requests.some((r) => r.phase === 'SDK_OVERFLOW' && r.summary));
  assert.ok(archive().agentSession.entries.some((e) => e.type === 'compaction'));
  checks.realSdkCompactionKeepsPrimary = true;
  const remainingBudget = await send('SDK_OVERFLOW_THEN_503');
  assert.deepEqual(remainingBudget.map((r) => [r.endpoint, r.injectedStatus ?? 200]), [['A', 400], ['A', 503], ['B', 200]]);
  assert.ok(requests.some((r) => r.phase === 'SDK_OVERFLOW_THEN_503' && r.summary));
  checks.overflowKeepsFallbackOpportunityInSameTurn = true;
  const failedOverflow = await send('SDK_OVERFLOW_FAIL', { error: true });
  assert.ok(failedOverflow.length >= 2); assert.ok(failedOverflow.every((r) => r.endpoint === 'A'));
  checks.failedCompactionRecoveryDoesNotSwitch = true;
  const authError = await send('SDK_401', { error: true });
  assert.equal(authError.length, 1); assert.equal(authError[0].endpoint, 'A'); assert.equal(authError[0].injectedStatus, 401);
  checks.authenticationErrorDoesNotSwitch = true;

  await screenshot('final-state');
  const summary = { ok: true, checks, rendererUrl, requests: requests.length, userData, scope: 'Real renderer selections, configuration IPC, chat IPC, production runtime, SDK, task/read and compaction. Only provider is local mock; no live model or credentials. Configuration forms themselves are not driven.' };
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`HEMI_VERIFY_PI_MODEL_CHAIN=${JSON.stringify(summary)}`);
} catch (error) {
  console.error(error); console.error(`证据 ${evidence}；隔离 userData ${userData}`); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  ws?.close();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); }
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
