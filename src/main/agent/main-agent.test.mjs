// 056 主 agent 集成单测：真实 Pi SDK 会话 × mock OpenAI / Anthropic 端点。
// 钉住 main-agent 层的接线：［本轮上下文］与图片随用户输入入史、旧请求前缀稳定、
// 第 4 缓存断点、同批多个 task 并发派单、后台结果经 notify 唤醒、条目导出可重建。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createMainAgent, buildAgentAppendSystem, addHistoryBreakpoint, entriesFromTurns } from './main-agent.mjs';
import { MAIN_CONTROL_TOOLS } from './agent-roles.mjs';

function startMock(responder) {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.setEncoding('utf8');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      const step = responder(body, requests.length) ?? { text: 'OK' };
      if (step && step.hang) return; // 挂死：不写响应、连接保持——复刻模型无响应
      if (step.status) {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'controlled upstream outage' } })); return;
      }
      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (data) => res.write(`data: ${JSON.stringify({ id: `m${requests.length}`, object: 'chat.completion.chunk', model: body.model, ...data })}\n\n`);
        const calls = step.toolCalls ?? [];
        const delta = calls.length
          ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }
          : { role: 'assistant', content: String(step.text) };
        chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      const events = [];
      const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      const calls = step.toolCalls ?? [];
      calls.forEach((call, index) => {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${requests.length}_${index}`, name: call.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args ?? {}) } });
        ev('content_block_stop', { index });
      });
      if (!calls.length) {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: String(step.text) } });
        ev('content_block_stop', { index: 0 });
      }
      ev('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } });
      ev('message_stop', {});
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.join(''));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

/** 末条非 system 消息（记忆投影会在尾部追加 system 段）。 */
function lastTurnMessage(body) {
  return [...body.messages].reverse().find((m) => m.role !== 'system');
}
const isToolResult = (message) => Array.isArray(message?.content) && message.content.some((b) => b.type === 'tool_result');
const textOf = (body) => JSON.stringify(body.messages);
const stripCache = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item));
const tinyPng = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4ryDwHxkzkC4AAKLAIuEUh8J9AAAAAElFTkSuQmCC' };

async function withAgent(responder, toolDeps, fn, { tools = null, orchestrator = false, api = 'anthropic-messages', sessionOptions = {} } = {}) {
  const mock = await startMock(responder);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h56-main-cwd-')));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h56-main-agent-'));
  const agent = createMainAgent({
    conversationId: 'conv-test',
    appendSystem: buildAgentAppendSystem({ routingSection: '［子 agent · 按需派活］', orchestrator }),
    toolDeps,
    sessionOptions: {
      cwd, agentDir, accessWorkspaceDir: cwd,
      ...(tools ? { tools } : {}),
      model: { baseUrl: mock.base, api, apiKey: 'k', supportsVision: true, model: api === 'anthropic-messages' ? 'claude-opus-5-5' : 'gpt-6.1-sol' },
      ...sessionOptions,
    },
  });
  try {
    await fn({ agent, mock, cwd, agentDir });
  } finally {
    agent.dispose();
    mock.server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

const baseDeps = (overrides = {}) => ({
  agents: ['explorer', 'fixer'],
  spawn: async () => ({ ok: true, background: false, result: { alias: 'explorer-1', agent: 'explorer', outcome: 'complete', report: 'R', toolCalls: 0, durationMs: 0, fileChanges: [] } }),
  status: () => [],
  waitFor: async () => null,
  message: async () => ({ ok: true }),
  cancel: async () => ({ ok: true }),
  workflowPreparation: async () => ({ preparations: [] }),
  conversationRead: async () => ({ text: '', nextOffset: null }),
  ...overrides,
});

for (const api of ['openai-completions', 'anthropic-messages']) {
  test(`${api}：后台失败随工具批次进入下一次请求，保留退出状态与完整工具顺序`,
    { timeout: 10000, skip: process.platform === 'win32' && 'POSIX shell fixture' }, async () => {
      await withAgent((_body, index) => index === 1
        ? { toolCalls: [{ name: 'bash', args: { command: 'sleep 0.1; printf BACKGROUND_API_FAILURE >&2; exit 7', run_in_background: true } }] }
        : index === 2 ? { toolCalls: [{ name: 'bash', args: { command: 'sleep 0.3; printf INDEPENDENT_DONE' } }] }
          : { text: 'DONE' }, baseDeps(), async ({ agent, mock }) => {
        const result = await agent.runTurn({ userText: 'Check background failure while working' });
        assert.equal(result.modelError, null); assert.equal(result.lastText, 'DONE');
        assert.equal(mock.requests.length, 3);
        const actual = textOf(mock.requests[2]);
        assert.match(actual, /后台命令完成 · 宿主观察/); assert.match(actual, /exit=7/);
        const entries = (await agent.exportEntries()).entries;
        assert.equal(entries.filter(entry => entry.customType === 'hemi_background_command_result').length, 1);
      }, { api, tools: ['bash'] });
    });
}

test('真实 Pi SDK 把准备卡更新作为主 agent 工具调用，不创建另一会话', async () => {
  let updates = 0;
  await withAgent((_body, count) => count === 1 ? { toolCalls: [{ name: 'workflow_preparation', args: { action: 'update', invocationId: 'inv-current', expectedDraftRevision: 2, set: { topic: '月报' } } }] } : { text: '已更新，等待点击开始' }, baseDeps({
    workflowPreparation: async (args, signal) => {
      signal?.throwIfAborted();
      assert.equal(args.invocationId, 'inv-current');
      assert.equal(args.expectedDraftRevision, 2);
      updates++;
      return { invocationId: args.invocationId, draftRevision: 3, ready: true, values: args.set };
    },
  }), async ({ agent, mock }) => {
    const result = await agent.runTurn({ userText: '这张卡的主题用月报', inputId: 'in-main-prep' });
    assert.equal(updates, 1);
    assert.match(result.lastText, /等待点击开始/);
    assert.equal(mock.requests.length, 2);
    assert.match(JSON.stringify(mock.requests[1]), /inv-current/);
    assert.match(JSON.stringify((await agent.exportEntries()).entries), /workflow_preparation/);
  });
});

test('［本轮上下文］随用户输入入史，续聊原样保留；身份与路由段进 system', async () => {
  await withAgent(() => ({ text: 'ANSWER' }), baseDeps(), async ({ agent, mock }) => {
    await agent.runTurn({ userText: '第一问', contextText: 'CTX_TURN_1' });
    await agent.runTurn({ userText: '第二问', contextText: 'CTX_TURN_2' });
    const [first, second] = mock.requests;
    const system = JSON.stringify(first.system);
    assert.match(system, /你是 Hemi/);
    assert.match(system, /子 agent · 按需派活/);
    assert.ok(textOf(first).includes('CTX_TURN_1'));
    assert.ok(textOf(second).includes('CTX_TURN_2'));
    assert.ok(textOf(second).includes('CTX_TURN_1'), '旧上下文必须保留，不能改写已发送前缀');
    assert.deepEqual(stripCache(second.messages[0]), stripCache(first.messages[0]));
    const exported = await agent.exportEntries();
    assert.match(JSON.stringify(exported.entries), /CTX_TURN_1/);
    assert.match(JSON.stringify(exported.entries), /CTX_TURN_2/);
    // 第 4 断点：第二回合补在本回合用户消息的前一条。
    const marks = second.messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content.filter((b) => b.cache_control).map(() => i) : []));
    assert.ok(marks.length >= 1);
  });
});

for (const api of ['openai-completions', 'anthropic-messages']) {
  for (const orchestrator of [false, true]) {
    test(`${api}：${orchestrator ? '路由' : '固定'}模式实际请求使用新交流与授权原则，续聊不改写 system`, async () => {
      await withAgent(() => ({ text: 'OK' }), baseDeps(), async ({ agent, mock }) => {
        await agent.runTurn({ userText: '你好' });
        await agent.runTurn({ userText: '请完整解释这个方案' });
        const systemOf = (body) => JSON.stringify(body.system ?? body.messages.filter(m => m.role === 'system' || m.role === 'developer'));
        const system = systemOf(mock.requests[0]);
        assert.match(system, /直接、自然、简洁/);
        assert.match(system, /完整交付/);
        assert.match(system, /不逐步播报/);
        assert.match(system, /桌面操作按应用授权/);
        assert.match(system, /不额外索要文件夹/);
        assert.doesNotMatch(system, /常驻 macOS|不要为凑格式压缩内容|有副作用的操作会经 Hemi 的权限门控向用户确认|每步操作前明确预期变化/);
        assert.equal(systemOf(mock.requests[1]), system);
        assert.equal(system.includes('自己不直接动手'), false);
        assert.match(system, /你能直接动手/);
      }, { api, orchestrator,  });
    });
  }
}

for (const api of ['openai-completions', 'anthropic-messages']) {
  test(`${api}：工具／续聊／事件／重建保留上下文与原图；编辑按旧身份回卷`, async () => {
    await withAgent((_body, n) => n === 1
      ? { toolCalls: [{ name: 'task', args: { agent: 'explorer', description: '查证', prompt: 'READ_ONLY_PROBE' } }] }
      : { text: `ANSWER_${n}` }, baseDeps(), async ({ agent, mock, cwd, agentDir }) => {
      const userIndex = (body, marker) => body.messages.findIndex(m => m.role === 'user' && JSON.stringify(m.content).includes(marker));
      const stablePrefix = (before, after, marker) => {
        const end = userIndex(before, marker) + 1;
        assert.ok(end > 0, `请求中实际存在 ${marker}`);
        assert.deepEqual(stripCache(after.messages.slice(0, end)), stripCache(before.messages.slice(0, end)));
        assert.deepEqual(stripCache(after.tools), stripCache(before.tools));
        if (before.system) assert.deepEqual(stripCache(after.system), stripCache(before.system));
      };
      await agent.runTurn({ userText: 'FIRST_USER', inputId: 'in-first', contextText: 'FROZEN_CTX_FIRST', imageBlocks: [tinyPng] });
      assert.equal(mock.requests.length, 2, '确实经过工具往返');
      stablePrefix(mock.requests[0], mock.requests[1], 'FIRST_USER');
      const firstUser = stripCache(mock.requests[0].messages[userIndex(mock.requests[0], 'FIRST_USER')]);
      assert.ok(firstUser.content.some(block => ['image', 'image_url'].includes(block.type)), '首请求包含真实图片块');
      await agent.runTurn({ userText: 'SECOND_USER', inputId: 'in-second', contextText: 'FROZEN_CTX_SECOND' });
      stablePrefix(mock.requests[1], mock.requests[2], 'FIRST_USER');
      const archiveFile = path.join(cwd, 'saved-agent.json');
      fs.writeFileSync(archiveFile, JSON.stringify(await agent.exportEntries()));
      agent.dispose();
      const makeRestored = (saved) => createMainAgent({
        conversationId: 'conv-test',
        appendSystem: buildAgentAppendSystem({ routingSection: '［子 agent · 按需派活］' }),
        toolDeps: baseDeps(), entries: [saved.header, ...saved.entries],
        sessionOptions: { cwd, agentDir, accessWorkspaceDir: cwd, model: { baseUrl: mock.base, api, apiKey: 'k', supportsVision: true, model: api === 'anthropic-messages' ? 'claude-opus-5-5' : 'gpt-6.1-sol' } },
      });
      let restored = makeRestored(JSON.parse(fs.readFileSync(archiveFile, 'utf8')));
      try {
        await restored.runTurn({ userText: 'THIRD_USER', inputId: 'in-third', contextText: 'FROZEN_CTX_THIRD' });
        stablePrefix(mock.requests[2], mock.requests[3], 'SECOND_USER');
        assert.deepEqual(stripCache(mock.requests[3].messages[userIndex(mock.requests[3], 'FIRST_USER')]), firstUser, '重建后保留同一份规范化原图和上下文');
        const settled = new Promise(resolve => restored.on('settled', resolve));
        await restored.notify('hemi_subagent_result', 'EVENT_ONLY_REPORT');
        await settled;
        const event = mock.requests.at(-1);
        stablePrefix(mock.requests[3], event, 'THIRD_USER');
        assert.equal(event.messages.filter(m => JSON.stringify(m.content).includes('FROZEN_CTX_THIRD')).length, 1, '事件不把旧上下文再挂到新消息');
        assert.doesNotMatch(JSON.stringify(lastTurnMessage(event)), /FROZEN_CTX/);
        const saved = await restored.exportEntries();
        const anchor = saved.entries.findIndex(e => e.type === 'custom' && e.customType === 'hemi.input' && e.data?.inputId === 'in-second');
        assert.ok(anchor >= 0);
        restored.dispose();
        restored = makeRestored({ ...saved, entries: saved.entries.slice(0, anchor) });
        await restored.runTurn({ userText: 'EDITED_USER', inputId: 'in-edited', contextText: 'FROZEN_CTX_EDITED' });
        const edited = mock.requests.at(-1);
        stablePrefix(mock.requests[0], edited, 'FIRST_USER');
        assert.doesNotMatch(textOf(edited), /SECOND_USER|THIRD_USER|FROZEN_CTX_SECOND|FROZEN_CTX_THIRD|EVENT_ONLY_REPORT/);
        assert.match(textOf(edited), /EDITED_USER/);
        if (api === 'anthropic-messages') {
          const current = userIndex(edited, 'EDITED_USER');
          assert.equal(edited.messages[current - 1].role, 'assistant');
          assert.ok(edited.messages[current - 1].content.some(b => b.cache_control), '第4断点仍标在旧回合的回答上');
        }
      } finally { restored.dispose(); }
    }, { api });
  });
}

test('同一条助手消息里的两个 task 并发派单，结果都回到主循环', async () => {
  const spans = [];
  const deps = baseDeps({
    spawn: async ({ agent: role, prompt }) => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 250));
      spans.push({ prompt, start, end: Date.now() });
      return { ok: true, background: false, result: { alias: `${role}-x`, agent: role, outcome: 'complete', report: `REPORT_${prompt}`, toolCalls: 1, durationMs: 250, fileChanges: [] } };
    },
  });
  const responder = (body) => (isToolResult(lastTurnMessage(body))
    ? { text: 'SUMMARY' }
    : { toolCalls: [
        { name: 'task', args: { agent: 'explorer', description: '甲', prompt: 'A' } },
        { name: 'task', args: { agent: 'explorer', description: '乙', prompt: 'B' } },
      ] });
  await withAgent(responder, deps, async ({ agent, mock }) => {
    const run = await agent.runTurn({ userText: '并行查两处' });
    assert.equal(run.lastText, 'SUMMARY');
    assert.equal(spans.length, 2);
    assert.ok(spans[1].start < spans[0].end && spans[0].start < spans[1].end, '两个 task 应并发');
    const final = mock.requests.at(-1);
    assert.ok(textOf(final).includes('REPORT_A') && textOf(final).includes('REPORT_B'));
  });
});

test('后台结果经 notify 唤醒空闲主 agent，产出经 settled 事件上抛', async () => {
  const responder = (body) => (textOf(body).includes('SUBAGENT_DONE') && !textOf(body).includes('ACK') ? { text: 'ACK 子任务完成' } : { text: 'HI' });
  await withAgent(responder, baseDeps(), async ({ agent }) => {
    await agent.runTurn({ userText: '先聊一句' });
    const settled = new Promise((resolve) => agent.on('settled', resolve));
    const sent = await agent.notify('hemi_subagent_result', 'SUBAGENT_DONE 报告：一切正常');
    assert.equal(sent.ok, true);
    const result = await settled;
    assert.match(result.lastText, /ACK/);
  });
});

test('编辑锚点随 inputId 落 SDK 历史，不进入 provider 消息；同文两轮仍有不同身份', async () => {
  await withAgent(() => ({ text: 'OK' }), baseDeps(), async ({ agent, mock }) => {
    await agent.runTurn({ userText: '相同问题', inputId: 'in-before-edit' });
    await agent.runTurn({ userText: '相同问题', inputId: 'in-edit-target' });
    const archive = await agent.exportEntries();
    const anchors = archive.entries.filter(e => e.type === 'custom' && e.customType === 'hemi.input');
    assert.deepEqual(anchors.map(e => e.data.inputId), ['in-before-edit', 'in-edit-target']);
    for (const anchor of anchors) {
      const index = archive.entries.indexOf(anchor);
      const nextMessage = archive.entries.slice(index + 1).find(e => e.type === 'message' && e.message.role !== 'system');
      assert.equal(nextMessage.message.role, 'user');
      assert.equal(nextMessage.message.content[0].text, '相同问题');
    }
    assert.doesNotMatch(JSON.stringify(mock.requests), /hemi\.input|in-before-edit|in-edit-target/);
  });
});

test('addHistoryBreakpoint：无断点端点不加；已有断点时补在本回合用户消息前一条', () => {
  const none = { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
  assert.equal(addHistoryBreakpoint(none), undefined);
  const payload = {
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'now' }] },
    ],
  };
  addHistoryBreakpoint(payload);
  assert.deepEqual(payload.messages[1].content[0].cache_control, { type: 'ephemeral' });
});

test('entriesFromTurns：跳过错误条/撤回条/任务卡，合成消息带完整 usage', () => {
  const entries = entriesFromTurns([
    { id: 'u1', author: 'user', text: '你好', createdAt: 1 },
    { id: 'e1', author: 'hemi', text: '出错了', kind: 'error', createdAt: 2 },
    { id: 't1', author: 'hemi', text: '任务卡', kind: 'task', createdAt: 3 },
    { id: 'h1', author: 'hemi', text: '你好呀', createdAt: 4 },
  ], { cwd: '/tmp' });
  assert.equal(entries[0].type, 'session');
  assert.equal(entries.length, 3);
  assert.equal(entries[2].message.usage.totalTokens, 0);
  assert.equal(entries[2].parentId, entries[1].id);
});

test('显式工具白名单严格裁剪；工具声明是实际执行能力的依据', async () => {
  const deps = baseDeps({ runtimeDiagnostics: () => ({ ok: true }) });
  await withAgent(() => ({ text: 'OK' }), deps, async ({ agent, mock }) => {
    await agent.runTurn({ userText: '打开 liblib.tv' });
    // SDK 自带的 __pi_* 内部占位不计（两种模式都有）。
    const names = (mock.requests[0].tools ?? []).map((tool) => tool.name).filter((name) => !name.startsWith('__pi_')).sort();
    assert.deepEqual(names, [...MAIN_CONTROL_TOOLS].sort());
    const system = JSON.stringify(mock.requests[0].system);
    assert.ok(!system.includes('自己不直接动手'));
  }, { tools: [...MAIN_CONTROL_TOOLS], orchestrator: true });
});

test('按需模式：主 agent 持动手工具（read/bash 在请求里）', async () => {
  await withAgent(() => ({ text: 'OK' }), baseDeps(), async ({ agent, mock }) => {
    await agent.runTurn({ userText: 'hi' });
    const names = (mock.requests[0].tools ?? []).map((tool) => tool.name);
    for (const name of ['read', 'bash', 'task']) assert.ok(names.includes(name), `缺 ${name}`);
  });
});

/** 主端点：第 1 个请求回 503，其后转给正常 mock。 */
async function flakyPrimary() {
  const ok = await startMock(() => ({ text: 'FROM_PRIMARY' }));
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'service unavailable' } }));
      return;
    }
    const proxied = http.request(`${ok.base}${req.url}`, { method: req.method, headers: req.headers }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 200, upstream.headers);
      upstream.pipe(res);
    });
    req.pipe(proxied);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls: () => calls,
    close: () => { server.close(); ok.server.close(); },
  };
}
test('056 备用只管一个回合：主模型 503 后本回合由备用接替，下一个用户回合回到主模型', async () => {
  const primary = await flakyPrimary();
  const fallback = await startMock(() => ({ text: 'FROM_FALLBACK' }));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h56-fb-cwd-')));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h56-fb-agent-'));
  const candidate = (base, model) => ({
    modelKey: `x/${model}`, name: model, model, baseUrl: base,
    api: 'anthropic-messages', apiKey: 'k', thinkingLevel: 'default',
  });
  const agent = createMainAgent({
    conversationId: 'conv-fb',
    appendSystem: buildAgentAppendSystem({ routingSection: '［子 agent · 按需派活］' }),
    toolDeps: baseDeps(),
    sessionOptions: {
      cwd, agentDir, accessWorkspaceDir: cwd,
      routing: { execution: candidate(primary.base, 'main-m'), fallback: candidate(fallback.base, 'fb-m') },
    },
  });
  try {
    const first = await agent.runTurn({ userText: '第一句', inputId: 'in-fallback-first', contextText: 'FROZEN_FALLBACK_CONTEXT' });
    assert.equal(first.lastText, 'FROM_FALLBACK', '本回合由备用接替');
    assert.equal(fallback.requests[0].messages.filter(m => JSON.stringify(m.content).includes('FROZEN_FALLBACK_CONTEXT')).length, 1, '切备用没有重复追加输入');
    const second = await agent.runTurn({ userText: '第二句', inputId: 'in-fallback-second', contextText: 'FROZEN_NEXT_CONTEXT' });
    assert.equal(second.lastText, 'FROM_PRIMARY', '新回合回到主模型');
    assert.equal(fallback.requests.length, 1, '备用只用了一次');
  } finally {
    agent.dispose();
    primary.close();
    fallback.server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('真实 SDK 主备均失败：预算耗尽仍返回候选耗尽原因，原 provider 错误保留在历史', async () => {
  const mock = await startMock(() => ({ status: 503 }));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-exhaust-')));
  const candidate = model => ({ modelKey: `test/${model}`, model, baseUrl: mock.base, api: 'openai-completions', apiKey: 'test' });
  const agent = createMainAgent({ conversationId: 'conv-exhaust', toolDeps: baseDeps(),
    sessionOptions: { cwd, agentDir: cwd, routing: { execution: candidate('primary'), fallback: candidate('backup') } } });
  try {
    const result = await agent.runTurn({ userText: '验证主备故障' });
    assert.deepEqual(mock.requests.map(r => r.model), ['primary', 'backup'], '两次实际故障请求后如实收口');
    assert.match(result.modelError, /HEMI_ROUTING_STOPPED: fallback-exhausted/);
    assert.match(result.modelError, /controlled upstream outage/);
    const entries = JSON.stringify((await agent.exportEntries()).entries);
    assert.match(entries, /controlled upstream outage/);
    assert.doesNotMatch(entries, /fallback-exhausted/, '仅适配器结果补原因，不改写 SDK provider 历史');
  } finally {
    agent.dispose(); mock.server.closeAllConnections(); mock.server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('手动重试同一句先请求主模型；恢复旧会话后也不能直接沿用备用，只有新故障才自动降级', async t => {
  let failure = 'both';
  const mock = await startMock(body => failure === 'both' || failure === 'primary' && body.model === 'primary'
    ? { status: 503 } : { text: `FROM_${body.model}` });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-manual-retry-')));
  const sessions = [];
  t.after(() => {
    for (const agent of sessions) agent.dispose();
    mock.server.closeAllConnections(); mock.server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const candidate = model => ({ modelKey: `test/${model}`, model, baseUrl: mock.base, api: 'openai-completions', apiKey: 'test' });
  const make = entries => {
    const agent = createMainAgent({ conversationId: 'conv-manual-retry', toolDeps: baseDeps(), entries,
      sessionOptions: { cwd, agentDir: cwd, routing: { execution: candidate('primary'), fallback: candidate('backup') } } });
    sessions.push(agent); return agent;
  };
  const input = { userText: '同一句失败输入', inputId: 'in-failed' };
  const agent = make();
  assert.match((await agent.runTurn(input)).modelError, /fallback-exhausted/);
  assert.deepEqual(mock.requests.map(r => r.model), ['primary', 'backup']);
  const archived = await agent.exportEntries();
  failure = null;
  assert.equal((await agent.runTurn({ ...input, inputId: 'in-retry-live' })).lastText, 'FROM_primary');
  assert.deepEqual(mock.requests.slice(2).map(r => r.model), ['primary'], '驻留会话重试先调用主模型');
  agent.dispose();

  const restored = make([archived.header, ...archived.entries]);
  assert.equal((await restored.runTurn({ ...input, inputId: 'in-retry-restored' })).lastText, 'FROM_primary');
  assert.deepEqual(mock.requests.slice(3).map(r => r.model), ['primary'], '恢复的备用状态不能覆盖手动重试的主模型');
  failure = 'primary';
  assert.equal((await restored.runTurn({ ...input, inputId: 'in-retry-outage' })).lastText, 'FROM_backup');
  assert.deepEqual(mock.requests.slice(4).map(r => r.model), ['primary', 'backup'], '本次主请求实际失败后才自动降级');
});

test('停止在途请求后续聊：保留已接收上下文，新输入不重复挂旧上下文', async () => {
  await withAgent((_body, n) => n === 1 ? { hang: true } : { text: 'NEW_ANSWER' }, baseDeps(), async ({ agent, mock }) => {
    const pending = agent.runTurn({ userText: 'OLD_REQUEST', inputId: 'in-old', contextText: 'OLD_FROZEN_CONTEXT' });
    for (let i = 0; i < 200 && !mock.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(mock.requests.length, 1, 'provider 请求确实已开始');
    await agent.abort();
    assert.equal((await pending).aborted, true);
    assert.equal((await agent.runTurn({ userText: 'NEW_REQUEST', inputId: 'in-new', contextText: 'NEW_FROZEN_CONTEXT' })).lastText, 'NEW_ANSWER');
    const request = mock.requests.at(-1);
    assert.match(textOf(request), /OLD_FROZEN_CONTEXT/);
    assert.equal(request.messages.filter(m => JSON.stringify(m.content).includes('OLD_FROZEN_CONTEXT')).length, 1);
    assert.doesNotMatch(JSON.stringify(lastTurnMessage(request)), /OLD_FROZEN_CONTEXT/);
    assert.match(JSON.stringify(lastTurnMessage(request)), /NEW_FROZEN_CONTEXT/);
  });
});

test('bug#17 看门狗：请求零事件静默超时按停止收口（挂死自愈，不再钉死 15 分钟）', async () => {
  await withAgent(() => ({ hang: true }), baseDeps(), async ({ agent, mock }) => {
    const started = Date.now();
    const run = await Promise.race([
      agent.runTurn({ userText: '挂死回合' }),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 5000)),
    ]);
    const elapsed = Date.now() - started;
    assert.ok(!run.__timeout, 'runTurn 必须在看门狗窗口内收口（不永久挂）');
    assert.ok(elapsed < 5000, `收口耗时 ${elapsed}ms 应在看门狗（400ms）+ 宽限内`);
    assert.ok(run.aborted || run.modelError, '收口按停止/异常如实上报');
    assert.equal(mock.requests.length, 1, '不自动重发挂死请求');
  }, { sessionOptions: { stallTimeoutMs: 400 } });
});

test('060：宿主停止事实追加不触发请求，随下一轮与导出条目保留，旧目标不再是待办', async () => {
  await withAgent(() => ({ text: 'OK' }), baseDeps(), async ({ agent, mock }) => {
    await agent.runTurn({ userText: '模拟目标 A' });
    const count = mock.requests.length;
    await agent.abort();
    await agent.recordGoalStop({ runId: 'run-A', reason: 'promote', inputs: ['模拟目标 A'] });
    assert.equal(mock.requests.length, count, '终态事实不开模型轮次');
    const archive = await agent.exportEntries();
    assert.match(JSON.stringify(archive.entries), /hemi_goal_stopped/);
    await agent.runTurn({ userText: '新的目标 B' });
    const body = JSON.stringify(mock.requests.at(-1));
    assert.match(body, /未完成部分已经取消，不是待办/);
    assert.match(body, /不主动复述本块、内部编号或标签/);
    assert.match(body, /用户明确询问诊断信息时可据实解释/, '约束普通回答的表达，不禁止诊断解释');
    assert.match(body, /新的目标 B/);
  });
});

test('060 优先交接等当前整批工具结束，不开旧目标下一轮；新目标仍可使用健康会话', async () => {
  let releaseFirst, releaseSecond;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const second = new Promise((resolve) => { releaseSecond = resolve; });
  let calls = 0;
  await withAgent((_body, n) => n === 1 ? { toolCalls: [
    { name: 'task', args: { agent: 'explorer', description: '阶段1', prompt: '阶段1' } },
    { name: 'task', args: { agent: 'explorer', description: '阶段2', prompt: '阶段2' } },
  ] } : { text: 'NEW_GOAL' }, baseDeps({ spawn: async () => {
    const gate = ++calls === 1 ? first : second;
    await gate;
    return { ok: true, result: { outcome: 'complete', report: '阶段已完成' } };
  } }), async ({ agent, mock }) => {
    const running = agent.runTurn({ userText: '旧目标' });
    for (let i = 0; i < 200 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    let handed = false;
    const handoff = agent.requestHandoff().then(() => { handed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handed, false, '不在工具批次中途终止');
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handed, false, '等整批工具，不能只等第一个');
    releaseSecond();
    await handoff;
    assert.equal((await running).aborted, true);
    assert.equal(mock.requests.length, 1, '旧目标不再发下一轮请求');
    assert.equal(agent.isDisposed(), false);
    assert.equal((await agent.runTurn({ userText: '新目标' })).lastText, 'NEW_GOAL');
    assert.equal(mock.requests.length, 2);
  });
});

test('060 不响应取消的工具触发释放，主 agent 明确暴露不可复用状态', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered = false;
  await withAgent(() => ({ toolCalls: [{ name: 'task', args: { agent: 'explorer', description: '慢阶段', prompt: '慢阶段' } }] }), baseDeps({ spawn: async () => {
    entered = true; await blocked; return { ok: true, result: { outcome: 'complete', report: '迟到结果' } };
  } }), async ({ agent }) => {
    const running = agent.runTurn({ userText: '不能响应取消的旧工具' });
    for (let i = 0; i < 200 && !entered; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(entered, true);
    await agent.abort();
    assert.equal(agent.isDisposed(), true);
    release();
    assert.equal((await running).aborted, true);
  }, { sessionOptions: { abortGraceMs: 30 } });
});
test('上下文容量：轮后有快照（usage 锚点总量＋before_provider_request 分类暂存）', async () => {
  await withAgent(() => ({ text: 'ANSWER' }), baseDeps(), async ({ agent }) => {
    // 首回合前：会话已建但从未发请求——无分类；usage 锚点也还没有，快照为 null。
    const before = agent.contextUsage();
    assert.equal(before, null);
    await agent.runTurn({ userText: '第一问', contextText: 'CTX_1' });
    const snapshot = agent.contextUsage();
    assert.ok(snapshot, '轮后应有快照');
    assert.ok(snapshot.tokens > 0, '总量按 usage 锚点为正');
    assert.ok(snapshot.contextWindow > 0);
    assert.equal(typeof snapshot.percent, 'number');
    assert.ok(snapshot.percent >= 0 && snapshot.percent <= 100, 'tiny mock usage 允许 0.0%');
    // 分类来自真实 before_provider_request 请求体（系统提示词/工具/对话消息/工具结果）。
    assert.deepEqual(snapshot.categories.map((category) => category.key), ['tools', 'conversation', 'toolResults', 'system']);
    for (const category of snapshot.categories) {
      assert.ok(category.tokens >= 0);
      assert.ok(category.percent >= 0 && category.percent <= 100);
    }
    const percentSum = snapshot.categories.reduce((acc, category) => acc + category.percent, 0);
    assert.ok(Math.abs(percentSum - 100) < 1, `分类比例应凑满 100（实际 ${percentSum}）`);
  });
});
