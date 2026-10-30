// SDK 接缝回归：生产会话工厂＋真实 Pi SDK＋本机 HTTP provider。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createHemiSession } from './hemi-session.mjs';
import { collectSkills } from '../skills/skill-catalog.mjs';

async function fixture(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-model-test-'));
  const requests = [], sessions = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw); requests.push({ path: req.url, body });
      const blocked = body.messages.some((message) => JSON.stringify(message.content).includes('BLOCK_TOOL')) && body.messages.at(-1)?.role !== 'tool';
      const parallel = body.messages.some(message => JSON.stringify(message.content).includes('PARALLEL_BROWSER')) && body.messages.at(-1)?.role !== 'tool';
      const delta = respond ? await respond(body, requests.length) : parallel ? { tool_calls: [0, 1].map(index => ({ index, id: `browser-${index}`, type: 'function', function: { name: 'browser_navigate', arguments: JSON.stringify({ url: `https://example.com/${index}`, newTab: true }) } })) }
        : blocked ? { tool_calls: [{ index: 0, id: 'blocked-call', type: 'function', function: { name: 'unclassified_probe', arguments: '{}' } }] } : { content: 'OK' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const model = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, apiKey: 'synthetic', model: 'generic-test' };
  t.after(() => { for (const session of sessions) session.dispose(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    requests, root, model,
    make(options = {}) {
      const session = createHemiSession({ cwd: root, agentDir: root, model, tools: [], features: {}, settings: { retry: { enabled: false } }, ...options });
      sessions.push(session); return session;
    },
  };
}

test('最终选模后应用产品三档；从旧条目恢复不能沿用旧档位', async (t) => {
  const { requests, make } = await fixture(t);
  let entries;
  for (const level of ['low', 'medium', 'high']) {
    const session = make({ thinking: { level }, entries });
    await session.prompt(`LEVEL_${level}`);
    const actual = requests.at(-1);
    assert.equal(actual.body.reasoning_effort, level);
    assert.equal(actual.path, '/v1/chat/completions');
    if (entries) assert.match(JSON.stringify(actual.body.messages), /LEVEL_low/);
    entries = (await session.exportEntries()).entries;
    session.dispose();
  }
});

test('格式覆盖通过生产会话进入 SDK 请求；不依赖注入 defaultThinkingLevel', async (t) => {
  const { requests, make } = await fixture(t);
  const session = make({ thinking: { level: 'high', format: 'qwen' } });
  await session.prompt('FORMAT');
  assert.equal(requests[0].body.enable_thinking, true);
  assert.ok(!('reasoning_effort' in requests[0].body));
});

test('Hemi 预处理后交给真实 Pi SDK：坏技能隔离，新会话仍可请求，有效技能的完整描述保持一致', async t => {
  const { root, requests, make } = await fixture(t);
  fs.mkdirSync(path.join(root, '.git'));
  for (const [name, description] of [['good', 'GOOD_SKILL_DESCRIPTION'], ['bad', 'Invalid: "nested"'], ['manual', 'MANUAL_SKILL_DESCRIPTION']]) {
    const dir = path.join(root, '.agents/skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${name === 'manual' ? 'disable-model-invocation: true\n' : ''}---\n${name} body`);
  }
  const catalog = collectSkills({ workspace: { dir: root } });
  t.after(catalog.release);
  assert.equal(catalog.diagnostics.length, 1);
  for (const input of ['FIRST_CONVERSATION', 'NEW_CONVERSATION']) {
    const session = make({ skills: catalog.items, tools: ['read'] });
    assert.equal((await session.prompt(input)).lastText, 'OK');
    const system = JSON.stringify(requests.at(-1).body.messages.filter(message => message.role === 'system'));
    assert.match(system, /GOOD_SKILL_DESCRIPTION/);
    assert.doesNotMatch(system, /MANUAL_SKILL_DESCRIPTION|<name>bad<\/name>/);
  }
});

test('自定义系统提示词下，浏览器托管规则实际进入模型请求；未声明浏览器工具时不误报能力', async t => {
  const { requests, make } = await fixture(t);
  const browser = make({ appendSystem: ['自定义 Hemi 身份'], features: { browser: true }, tools: ['browser_navigate', 'bash'], browserBridge: { async endSession() {} } });
  await browser.prompt('打开网页并读取');
  const enabled = requests.at(-1).body;
  const system = JSON.stringify(enabled.messages.filter(message => message.role === 'system'));
  assert.match(system, /自定义 Hemi 身份/);
  assert.match(system, /普通网页任务.*必须使用.*browser_\*/);
  assert.match(system, /taskTitle.*简短任务名/);
  assert.match(system, /不要通过 bash 另启 Chrome/);
  assert.match(system, /除非用户明确要求，不要激活或切换到浏览器前台/);
  assert.ok(enabled.tools.some(tool => tool.function.name === 'browser_navigate'));
  assert.equal(enabled.tools.find(tool => tool.function.name === 'browser_navigate').function.parameters.properties.taskTitle.type, 'string');
  const withoutBrowser = make({ appendSystem: ['自定义 Hemi 身份'], features: { browser: true }, tools: ['bash'], browserBridge: { async endSession() {} } });
  await withoutBrowser.prompt('只处理本地代码');
  assert.doesNotMatch(JSON.stringify(requests.at(-1).body.messages.filter(message => message.role === 'system')), /普通网页任务/);
});

test('门控确实拒绝执行：SDK 历史与宿主结束事件一致标失败', async (t) => {
  const { make } = await fixture(t);
  let executions = 0;
  const events = [];
  const session = make({
    tools: ['unclassified_probe'],
    extraExtensions: [{ name: 'test-tool', factory: (pi) => pi.registerTool({
      name: 'unclassified_probe', label: 'probe', description: 'synthetic', parameters: { type: 'object', properties: {} },
      async execute() { executions++; return { content: [{ type: 'text', text: 'unexpected' }] }; },
    }) }],
  });
  session.on('progress', (event) => events.push(event));
  await session.prompt('BLOCK_TOOL');
  assert.equal(executions, 0);
  assert.equal(events.filter((event) => event.kind === 'tool-start').length, 1);
  assert.equal(events.find((event) => event.kind === 'tool-end').isError, true);
  assert.equal((await session.exportEntries()).entries.find((entry) => entry.message?.role === 'toolResult').message.isError, true);
});

test('完整运行收口回收网页；清理未完成时下一轮不能重开页面', async (t) => {
  const { requests, make } = await fixture(t);
  let finishCleanup, cleanups = 0;
  const cleanupStarted = new Promise(resolve => {
    finishCleanup = { started: resolve, release: null };
  });
  const session = make({ browserBridge: { endSession: async () => {
    cleanups++;
    if (cleanups === 1) { finishCleanup.started(); await new Promise(resolve => { finishCleanup.release = resolve; }); }
  } } });
  let firstDone = false;
  const first = session.prompt('FIRST').then(result => { firstDone = true; return result; });
  await cleanupStarted;
  assert.equal(session.isBusy(), true, '回收属于本次运行收口');
  const next = session.prompt('SECOND');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.length, 1); assert.equal(firstDone, false);
  finishCleanup.release();
  assert.equal((await first).aborted, false);
  assert.equal((await next).aborted, false);
  assert.equal(cleanups, 2); assert.equal(requests.length, 2);
});

test('宿主管理目标时跨 SDK 回合保留页面；空闲取消也等待页面真正回收', async t => {
  const { make } = await fixture(t);
  let cleanups = 0, release;
  const started = Promise.withResolvers();
  const session = make({ browserLifecycle: 'goal', browserBridge: { async endSession() {
    cleanups++;
    if (cleanups > 1) return;
    started.resolve();
    await new Promise(resolve => { release = resolve; });
  } } });
  await session.prompt('等待用户确认');
  await session.prompt('用户已手动完成验证');
  assert.equal(cleanups, 0);
  let cancelled = false;
  const stopping = session.abort().then(() => { cancelled = true; });
  await started.promise;
  assert.equal(cancelled, false);
  release(); await stopping;
  assert.equal(cleanups, 1);
});

test('网页清理期间收到子 agent 通知：清理后真正触发事件回合，不滞留在空闲 followUp', async (t) => {
  const { requests, make } = await fixture(t);
  let releaseCleanup, started;
  const cleaning = new Promise(resolve => { started = resolve; });
  let cleanups = 0;
  const session = make({ browserBridge: { endSession: async () => {
    if (++cleanups === 1) { started(); await new Promise(resolve => { releaseCleanup = resolve; }); }
  } } });
  const first = session.prompt('BEFORE_NOTIFY');
  await cleaning;
  const eventSettled = new Promise(resolve => session.on('settled', resolve));
  const notified = session.notify('test-result', 'AFTER_CLEANUP_NOTIFY');
  releaseCleanup(); await first;
  assert.equal((await notified).queued, false);
  await eventSettled;
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].body), /AFTER_CLEANUP_NOTIFY/);
});

test('同批两个浏览器调用能执行并收口，不在执行前互相等待交互租约', { timeout: 3000 }, async t => {
  const { make } = await fixture(t);
  const navigated = [];
  let cleaned = false;
  const session = make({ tools: ['browser_navigate'], features: { browser: true }, browserBridge: {
    async ensureReady() {},
    async request(op, params) { navigated.push(params.url); return { url: params.url, title: 'Test' }; },
    async endSession() { cleaned = true; },
  } });
  const result = await session.prompt('PARALLEL_BROWSER');
  assert.deepEqual(navigated.sort(), ['https://example.com/0', 'https://example.com/1']);
  assert.equal(cleaned, true); assert.equal(result.aborted, false);
});

test('交互资源排队有等待事实，等待期间不误触静默停止；释放后继续真实 SDK 工具轮', { timeout: 10000 }, async t => {
  const { getInteractiveResourceCoordinator } = await import('../workflows/interactive-resource-coordinator.mjs');
  const coordinator = getInteractiveResourceCoordinator();
  const held = await coordinator.acquire('interactive:local', 'held-by-other-task');
  t.after(() => held.release());
  const { make } = await fixture(t);
  let waiting, navigations = 0;
  const queued = new Promise(resolve => { waiting = resolve; });
  const session = make({ tools: ['browser_navigate'], features: { browser: true }, stallTimeoutMs: 1000, browserBridge: {
    async ensureReady() {}, async request() { navigations++; return { url: 'https://example.com' }; }, async endSession() {},
  } });
  session.on('activity', activity => { if (activity.phase === 'waiting-resource') waiting(activity); });
  const running = session.prompt('PARALLEL_BROWSER');
  assert.equal((await queued).resources[0].resource.scope, 'desktop');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(session.isBusy(), true);
  assert.equal(navigations, 0);
  held.release();
  assert.equal((await running).aborted, false);
  assert.equal(navigations, 2);
});

const localCommands = { timeout: 10000, skip: process.platform === 'win32' && 'POSIX shell fixture' };
const bashCall = (id, command, extra = {}) => ({
  index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, ...extra }) },
});
const backgroundEntries = entries => entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'hemi_background_command_result');

test('后台失败在当前工具批次结束后进入下一次真实 SDK 请求，不等整轮结束且只投递一次', localCommands, async t => {
  const { make, requests } = await fixture(t, (_body, index) => {
    if (index === 1) return { tool_calls: [bashCall('background-fail', 'sleep 0.1; printf BACKGROUND_FAILURE >&2; exit 7', { run_in_background: true })] };
    if (index === 2) return { tool_calls: [bashCall('independent-work', 'sleep 0.3; printf INDEPENDENT_DONE')] };
    return { content: 'DONE' };
  });
  const session = make({ tools: ['bash'] });
  const result = await session.prompt('Run background command, then independent work');
  assert.equal(result.modelError, null);
  assert.equal(result.aborted, false);
  assert.match(JSON.stringify(requests[2].body.messages), /BACKGROUND_FAILURE/);
  assert.match(JSON.stringify(requests[2].body.messages), /exit=7/);
  assert.match(JSON.stringify(requests[2].body.messages), /后台命令完成 · 宿主观察/);
  assert.equal(requests.length, 3, '结果随正常工具循环送达，不额外启动通知回合');
  const entries = (await session.exportEntries()).entries;
  const notices = backgroundEntries(entries);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].details.eventIds.length, 1);
  const noticeIndex = entries.indexOf(notices[0]);
  assert.equal(entries[noticeIndex - 1].message?.role, 'toolResult', '通知不能插在工具调用与结果之间');
  await session.prompt('Next user goal');
  assert.equal(backgroundEntries((await session.exportEntries()).entries).length, 1, '旧结果不在新目标重复投递');
});

test('同批多个后台命令的成功与失败汇总一次，已消费结果不再次唤醒', localCommands, async t => {
  const { make, requests } = await fixture(t, (_body, index) => {
    if (index === 1) return { tool_calls: [
      bashCall('background-ok', 'sleep 0.1; printf BACKGROUND_OK', { run_in_background: true }),
      { ...bashCall('background-error', 'sleep 0.1; printf BACKGROUND_ERROR >&2; exit 9', { run_in_background: true }), index: 1 },
    ] };
    if (index === 2) return { tool_calls: [bashCall('independent-work', 'sleep 0.3; printf INDEPENDENT_DONE')] };
    return { content: 'DONE' };
  });
  const session = make({ tools: ['bash'] });
  assert.equal((await session.prompt('Run two independent background commands')).modelError, null);
  const messages = JSON.stringify(requests[2].body.messages);
  assert.match(messages, /BACKGROUND_OK/); assert.match(messages, /BACKGROUND_ERROR/); assert.match(messages, /exit=9/);
  assert.equal(requests.length, 3);
  const notices = backgroundEntries((await session.exportEntries()).entries);
  assert.equal(notices.length, 1); assert.equal(new Set(notices[0].details.eventIds).size, 2);
});

test('模型先停止时仍由宿主等待后台完成，结果入史后续跑且不丢失', localCommands, async t => {
  const { make, requests } = await fixture(t, (_body, index) => index === 1
    ? { tool_calls: [bashCall('background-late', 'sleep 0.3; printf LATE_BACKGROUND >&2; exit 3', { run_in_background: true })] }
    : { content: index === 2 ? 'Waiting for background' : 'DONE' });
  const session = make({ tools: ['bash'] });
  assert.equal((await session.prompt('Wait for the background result')).modelError, null);
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[2].body.messages), /LATE_BACKGROUND/);
  assert.equal(backgroundEntries((await session.exportEntries()).entries).length, 1);
});

test('取消后台目标后清理进程与待通知结果，不唤醒或污染下一轮', localCommands, async t => {
  const { make, requests } = await fixture(t, (_body, index) => index === 1
    ? { tool_calls: [bashCall('background-cancel', 'sleep 30; printf CANCELLED_BACKGROUND', { run_in_background: true })] }
    : { content: 'DONE' });
  const session = make({ tools: ['bash'] });
  let started;
  const backgroundStarted = new Promise(resolve => { started = resolve; });
  session.on('activity', activity => { if (activity.jobs.length) started(); });
  const running = session.prompt('Start a cancellable command');
  await backgroundStarted;
  await session.abort();
  assert.equal((await running).aborted, true);
  assert.equal(backgroundEntries((await session.exportEntries()).entries).length, 0);
  const beforeNext = requests.length;
  assert.equal((await session.prompt('New goal after cancellation')).aborted, false);
  assert.equal(requests.length, beforeNext + 1);
  assert.equal(backgroundEntries((await session.exportEntries()).entries).length, 0);
});

test('生产运行时：后台错误在原生落盘后进入请求，同一根预算记账且重启不重跑命令', localCommands, async t => {
  const { createAgentRuntime } = await import('../agent-runtime/core.mjs');
  const { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } = await import('../agent-runtime/model-policy.mjs');
  const { requests, root, model } = await fixture(t, (body, index) => {
    if (JSON.stringify(body.messages).includes('［Hemi 目标完成校验］')) return { content: JSON.stringify({status:'complete',reason:'本轮要求已执行并读回实际后台结果',evidence:['后台失败 exit=7 已投递且后续独立命令完成'],remaining:[],nextAction:''}) };
    if (index === 1) return { tool_calls: [bashCall('production-background',
      'printf one >> executions.txt; sleep 0.1; printf PRODUCTION_BACKGROUND_FAILURE >&2; exit 7', { run_in_background: true })] };
    if (index === 2) return { tool_calls: [bashCall('production-independent', 'sleep 0.3; printf INDEPENDENT_DONE')] };
    return { content: 'DONE' };
  });
  const config = { ...model, modelKey: 'test/background', providerId: 'test', supportsVision: false };
  const store = { list: async () => ({ defaultModelId: config.modelKey }), resolveStrict: async () => ({ ok: true, config }) };
  const policySnapshot = await freezeModelPolicy({ store, modelKey: config.modelKey, budgets: { maxRequestsPerRun: 3 } });
  const modelPlan = await hydrateModelPlan(resolveModelPlan(policySnapshot), store);
  let archived = null;
  const options = { userDataDir: path.join(root, 'data'), getProfiles: () => store,
    resolveCapabilities: async () => ({ features: {}, extensionConfig: {} }), getAccessService: () => null,
    loadArchiveAgent: () => archived, loadArchiveTurns: () => [],
    saveArchiveAgent: (_id, payload) => { archived = payload; return true; },
  };
  const context = { conversationId: 'conv-background', runId: 'run-background', generation: 0, inputSource: 'text',
    workspace: { id: 'background-workspace', type: 'project', dir: root }, policySnapshot, modelPlan, config };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.obtain(context);
    const result = await runtime.runRootTurn(context.conversationId, { userText: 'Verify production background completion' });
    assert.equal(result.lastText, 'DONE'); assert.equal(result.goalComplete, true); assert.equal(result.modelError, null);
    assert.equal(requests.length, 4, '三次执行请求和一次独立完成校验，通知不另占执行请求');
    assert.match(JSON.stringify(requests[2].body.messages), /exit=7/);
    const state = await runtime.journal.snapshot();
    const rows = Object.values(state.requests);
    assert.equal(rows.length, 4);
    assert.equal(rows.filter(row => row.purpose === 'goal-verification').length, 1);
    assert.ok(rows.every(row => row.owner.rootRunId === context.runId));
    assert.equal(state.roots[context.runId].requestLimitReached, undefined);
    const failed = Object.values(state.processes).find(process => process.toolCallId === 'production-background');
    assert.equal(failed.status, 'failed'); assert.equal(failed.code, 7); assert.equal(failed.cleanupConfirmed, true);
    const metadataDir = path.join(root, 'data/runtime-v2/sessions');
    const metadata = JSON.parse(fs.readFileSync(path.join(metadataDir, 'metadata/main-conv-background.json'), 'utf8'));
    const entries = fs.readFileSync(path.join(metadataDir, 'pi', metadata.native.file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const notices = backgroundEntries(entries);
    assert.equal(notices.length, 1); assert.match(notices[0].content, /PRODUCTION_BACKGROUND_FAILURE/);
    assert.ok(notices[0].content.includes('完整输出快照：ctx-'), '生产通知保留可复核的完整输出引用');
    await runtime.completeConversation(context.conversationId, 'completed', null, context.runId);
    await runtime.close();
    runtime = createAgentRuntime(options);
    const resumed = await runtime.obtain({ ...context, runId: 'run-background-resumed', cancelled: false });
    const next = await runtime.runRootTurn(context.conversationId, { userText: 'Continue after restart' });
    assert.equal(next.lastText, 'DONE'); assert.equal(next.goalComplete, true); assert.equal(requests.length, 6);
    assert.equal(backgroundEntries((await resumed.exportEntries()).entries).length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'executions.txt'), 'utf8'), 'one');
    await runtime.completeConversation(context.conversationId, 'completed', null, 'run-background-resumed');
  } finally { await runtime.close(); }
});
