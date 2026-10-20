// 038：本地 mock 验证 Pi 虚拟模型的接入边界；不调用外部模型或产品运行目录。
// 运行：node scripts/pi-sdk-routing-probe.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const sdkVersion = JSON.parse(await fs.readFile(path.resolve(path.dirname(sdkEntry), '../package.json'), 'utf8')).version;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-routing-probe-'));
const scenarios = new Map();
const sessions = [];
const findings = [];

function record(id, claim, check, detail) {
  try {
    check();
    findings.push({ id, claim, ok: true, detail });
    console.log(`PASS ${id} ${claim}`);
  } catch (error) {
    findings.push({ id, claim, ok: false, detail, error: error.message });
    console.log(`FAIL ${id} ${claim}: ${error.message}`);
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const [, name, candidate] = req.url.split('/');
    const scenario = scenarios.get(name);
    if (!scenario) { res.writeHead(404); res.end(); return; }
    const payload = JSON.parse(body);
    const expectedKey = `${name}-${candidate}-mock-key`;
    scenario.requests.push({ candidate, payload, correctKey: req.headers.authorization === `Bearer ${expectedKey}` });
    const step = scenario.steps.shift() ?? { text: 'PROBE_DONE' };
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: step.error ?? 'Service unavailable', type: step.code ?? 'server_error', code: step.code ?? 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'routing-probe', object: 'chat.completion.chunk', created: 1, model: `model-${candidate}`, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (step.partial) {
      emit({ role: 'assistant', content: 'PARTIAL_OUTPUT' });
      setTimeout(() => res.destroy(), 25);
      return;
    }
    if (step.tool) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'probe-call', type: 'function', function: { name: 'routing_echo', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', content: step.text ?? 'PROBE_DONE' });
      emit({}, 'stop');
    }
    if (!step.noUsage) res.write(`data: ${JSON.stringify({ id: 'routing-probe', object: 'chat.completion.chunk', created: 1, model: `model-${candidate}`, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function makeSession(name, steps) {
  const cwd = path.join(root, name);
  const agentDir = path.join(cwd, 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  const data = { requests: [], routes: [], messages: [], steps: [...steps], toolCalls: 0, active: 'primary', fallbackUsed: false };
  scenarios.set(name, data);
  // 小会话只为探针把保留预算降到 1；生产沿用既有压缩设置。
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 20, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 1 } });
  const extension = {
    name: `routing-${name}`,
    factory(pi) {
      for (const candidate of ['primary', 'fallback']) {
        pi.registerProvider(`${name}-${candidate}`, {
          api: 'openai-completions', baseUrl: `${baseUrl}/${name}/${candidate}/v1`, apiKey: `${name}-${candidate}-mock-key`,
          models: [{ id: `model-${candidate}`, name: candidate, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        });
      }
      pi.registerVirtualModel({
        provider: `routing-${name}`, id: 'auto', name: 'Probe Auto', thinkingLevels: ['off'],
        route(request, ctx) {
          data.routes.push({ reason: request.reason, state: request.state, failed: request.failed, messages: request.messages });
          if (request.signal?.aborted) throw new Error('HEMI_ROUTING_STOPPED: cancelled');
          if (request.reason !== 'direct' && request.state) {
            data.active = request.state.active;
            data.fallbackUsed = request.state.fallbackUsed;
          }
          if (request.reason === 'retry') {
            const failed = request.failed?.message;
            // 此处仅是探针策略；产品错误分类在实施时接结构化错误与完整测试。
            const empty = failed?.content?.every((part) => part.type === 'text' ? !part.text : false);
            const transient = /503|server_error|Service unavailable/.test(failed?.errorMessage ?? '');
            if (!failed || !empty || !transient || data.fallbackUsed) throw new Error('HEMI_ROUTING_STOPPED: unsafe-or-exhausted');
            data.active = 'fallback';
            data.fallbackUsed = true;
          }
          const oldState = request.state;
          const state = oldState?.active === data.active && oldState?.fallbackUsed === data.fallbackUsed
            ? oldState : { active: data.active, fallbackUsed: data.fallbackUsed };
          return { model: ctx.modelRegistry.find(`${name}-${data.active}`, `model-${data.active}`), thinkingLevel: 'off', state: request.reason === 'direct' ? undefined : state };
        },
      });
      pi.registerTool({ name: 'routing_echo', label: 'Probe Echo', description: 'Probe-only tool', parameters: { type: 'object', properties: {} }, execute: async () => { data.toolCalls += 1; return { content: [{ type: 'text', text: 'TOOL_DONE' }] }; } });
      pi.on('context_with_system', (event) => ({ messages: [...event.messages, { role: 'system', content: `MEMORY_${name}`, timestamp: 0 }] }));
    },
  };
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: 'off' });
  sessions.push(session);
  await session.setModel(session.modelRuntime.getModel(`routing-${name}`, 'auto'));
  await session.bindExtensions({ mode: 'rpc' });
  session.subscribe((event) => { if (event.type === 'message_end' && event.message?.role === 'assistant') data.messages.push(event.message); });
  return { session, data };
}

const watchdog = setTimeout(() => { console.error('Routing probe timed out'); process.exit(1); }, 45000);
try {
  const a = await makeSession('main', [{ tool: true }, { status: 503 }, { text: 'FALLBACK_DONE' }]);
  await a.session.prompt('Use the probe tool once, then reply.');
  record('R1-route-loop', 'user→continuation→retry 进入路由；备用延续已执行工具事实', () => {
    assert.deepEqual(a.data.routes.map((r) => r.reason), ['user', 'continuation', 'retry']);
    assert.deepEqual(a.data.requests.map((r) => r.candidate), ['primary', 'primary', 'fallback']);
    assert.equal(a.data.toolCalls, 1);
    const retry = a.data.routes.at(-1);
    assert.equal(retry.failed.message.stopReason, 'error');
    assert.match(retry.failed.message.errorMessage, /503/);
    assert.ok(!retry.messages.some((m) => m.role === 'assistant' && m.stopReason === 'error'));
    assert.ok(retry.messages.some((m) => m.role === 'toolResult'));
  });
  record('R2-auth-memory', '跨端点凭据隔离；正常与 retry 请求保留记忆、system 和工具声明', () => {
    assert.ok(a.data.requests.every((r) => r.correctKey));
    assert.ok(a.data.requests.every((r) => r.payload.messages.some((m) => ['system', 'developer'].includes(m.role) && String(m.content).includes('MEMORY_main'))));
    assert.ok(a.data.requests.every((r) => r.payload.tools.some((t) => t.function.name === 'routing_echo')));
  });
  await a.session.prompt('Continue with another reply.');
  const beforeCompact = a.data.requests.length;
  await a.session.compact();
  const summaries = a.data.requests.slice(beforeCompact);
  await a.session.prompt('Reply after compaction.');
  record('R3-state-direct', '备用状态跨新 user/压缩保留；真实 compaction direct 无 state', () => {
    assert.ok(a.data.routes.some((r) => r.reason === 'direct'));
    assert.ok(a.data.routes.filter((r) => r.reason === 'direct').every((r) => r.state === undefined));
    assert.ok(summaries.length > 0 && summaries.every((r) => r.candidate === 'fallback' && !(r.payload.tools?.length)));
    assert.ok(a.data.requests.slice(3).every((r) => r.candidate === 'fallback'));
    assert.equal(a.data.routes.at(-1).state.fallbackUsed, true);
    assert.equal(a.session.model.api, 'pi-virtual');
  }, { summaryRequests: summaries.length });

  const b = await makeSession('bothfail', [{ status: 503 }, { status: 503 }]);
  await b.session.prompt('Reply.');
  record('R4-budget', 'SDK maxRetries=1/provider=0 时主模型与备用各请求一次，失败 settled', () => {
    assert.deepEqual(b.data.requests.map((r) => r.candidate), ['primary', 'fallback']);
    assert.equal(b.data.messages.at(-1).stopReason, 'error');
  });

  const quota = await makeSession('quota', [{ status: 429, code: 'insufficient_quota', error: 'insufficient_quota' }]);
  await quota.session.prompt('Reply.');
  record('R5-quota', '配额耗尽 429 不进入 agent retry，不切备用', () => {
    assert.equal(quota.data.requests.length, 1);
    assert.deepEqual(quota.data.routes.map((r) => r.reason), ['user']);
  });

  const partial = await makeSession('partial', [{ partial: true }]);
  await partial.session.prompt('Reply.');
  record('R6-partial', 'SDK 会对部分输出错误发起 retry；route 可拒绝重放且无第二个 HTTP 请求', () => {
    assert.equal(partial.data.requests.length, 1);
    const retry = partial.data.routes.find((r) => r.reason === 'retry');
    assert.ok(retry);
    assert.ok(retry.failed.message.content.some((p) => p.type === 'text' && p.text.includes('PARTIAL_OUTPUT')));
    assert.equal(partial.data.messages.at(-1).stopReason, 'error');
  });

  const cancelled = await makeSession('cancelled', [{ status: 503 }]);
  let retryScheduled;
  const scheduled = new Promise((resolve) => { retryScheduled = resolve; });
  cancelled.session.subscribe((event) => { if (event.type === 'auto_retry_start') retryScheduled(); });
  const pending = cancelled.session.prompt('Reply.');
  await scheduled;
  await cancelled.session.abort();
  await pending;
  record('R7-cancel', '取消 SDK 重试等待后不调用备用', () => {
    assert.equal(cancelled.data.requests.length, 1);
    assert.deepEqual(cancelled.data.routes.map((r) => r.reason), ['user']);
  });

  const noUsage = await makeSession('nousage', [{ text: 'NO_USAGE', noUsage: true }]);
  const healthy = await makeSession('healthy', [{ text: 'HEALTHY' }]);
  await Promise.all([noUsage.session.prompt('Reply.'), healthy.session.prompt('Reply.')]);
  record('R8-usage', 'usage-only SSE 被 SDK 接收；服务未返回 usage 时仍给全零对象，不能据此当免费', () => {
    assert.equal(healthy.data.messages.at(-1).usage.totalTokens, 15);
    assert.equal(noUsage.data.messages.at(-1).usage.totalTokens, 0);
    assert.equal(noUsage.data.messages.at(-1).stopReason, 'stop');
  });
  record('R9-isolation', '并行会话状态不串扰，健康会话保持主模型', () => {
    assert.ok(healthy.data.requests.every((r) => r.candidate === 'primary' && r.correctKey));
    assert.ok(noUsage.data.requests.every((r) => r.candidate === 'primary' && r.correctKey));
    assert.equal(healthy.data.fallbackUsed, false);
    assert.equal(a.data.fallbackUsed, true);
  });
} finally {
  clearTimeout(watchdog);
  for (const session of sessions) session.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

const pass = findings.filter((f) => f.ok).length;
console.log(`HEMI_ROUTING_PROBE ${JSON.stringify({ sdk: sdkVersion, node: process.version, pass, total: findings.length, findings })}`);
process.exitCode = pass === findings.length ? 0 : 1;
