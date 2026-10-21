// SDK 接缝回归：生产会话工厂＋真实 Pi SDK＋本机 HTTP provider。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createHemiSession } from './hemi-session.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-model-test-'));
  const requests = [], sessions = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push({ path: req.url, body });
      const blocked = body.messages.some((message) => JSON.stringify(message.content).includes('BLOCK_TOOL')) && body.messages.at(-1)?.role !== 'tool';
      const parallel = body.messages.some(message => JSON.stringify(message.content).includes('PARALLEL_BROWSER')) && body.messages.at(-1)?.role !== 'tool';
      const delta = parallel ? { tool_calls: [0, 1].map(index => ({ index, id: `browser-${index}`, type: 'function', function: { name: 'browser_navigate', arguments: JSON.stringify({ url: `https://example.com/${index}`, newTab: true }) } })) }
        : blocked ? { tool_calls: [{ index: 0, id: 'blocked-call', type: 'function', function: { name: 'unclassified_probe', arguments: '{}' } }] } : { content: 'OK' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: blocked || parallel ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const model = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, apiKey: 'synthetic', model: 'generic-test' };
  t.after(() => { for (const session of sessions) session.dispose(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    requests,
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
