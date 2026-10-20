// 048 S1 等价单测：对话侧统一 pi-ai 实现后的思考字段矩阵、思考事件、工具往返、
// 图片直传转换与 pi-ai 版本同源门。手写 SSE 时代的行为语义（重试、错误分类、
// 首字门）由 text-model.test.mjs / text-model-usage.test.mjs 继续钉住。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatTurn } from './text-model.mjs';
import { addHistoryCacheBreakpoint, chatTurnPi } from './pi-chat.mjs';

const encoder = new TextEncoder();

function sseResponse(frames, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const doneFrames = () => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
];

/**
 * 捕获 pi-ai 请求体（onPayload 在请求发出前收到已解析的 params 对象）。
 * 返回 { bodies, fetch }——fetch 只负责喂一条成功流。
 */
function captureBodies() {
  const bodies = [];
  return {
    bodies,
    fetch: async () => sseResponse(doneFrames()),
    onPayload: (payload) => { bodies.push(payload); },
  };
}

// ---- 思考字段等价矩阵（4 格式 × 档位；差异已登记技术方案「等价门」） ----

test('等价矩阵：openai 兜底格式——default/high 落 reasoning_effort，off 不发思考字段', async () => {
  const base = { apiKey: 'key', messages: [{ role: 'user', content: 'hi' }] };
  const run = async (level) => {
    const cap = captureBodies();
    await chatTurn({ ...base, baseUrl: 'https://api.example.com/v1', model: 'demo-relay', thinkingLevel: level, fetchImpl: cap.fetch, onPayload: cap.onPayload });
    return cap.bodies[0];
  };
  assert.equal((await run('default')).reasoning_effort, 'medium', 'default＝厂商中档');
  assert.equal((await run('high')).reasoning_effort, 'high');
  const off = await run('off');
  assert.ok(!('reasoning_effort' in off) && !('thinking' in off) && !('enable_thinking' in off), 'openai 格式 off 无法表达关闭，不发字段（等价旧 applyThinkingLevel）');
});

test('等价矩阵：deepseek 官方端点（URL 探测）——on/off 落 thinking:{type}（+effort 为登记差异）', async () => {
  const base = { apiKey: 'key', messages: [{ role: 'user', content: 'hi' }] };
  const run = async (level) => {
    const cap = captureBodies();
    await chatTurn({ ...base, baseUrl: 'https://api.deepseek.com/v1', model: 'demo-x', thinkingLevel: level, fetchImpl: cap.fetch, onPayload: cap.onPayload });
    return cap.bodies[0];
  };
  assert.deepEqual((await run('medium')).thinking, { type: 'enabled' });
  assert.deepEqual((await run('off')).thinking, { type: 'disabled' });
  // 登记差异：deepseek URL 探测的 supportsReasoningEffort=true，medium 档会附带
  // reasoning_effort（旧手写不发）；探针 pi-ai 路已实测 DeepSeek 官方接受该字段。
  assert.equal((await run('default')).reasoning_effort, 'medium');
});

test('等价矩阵：deepseek 目录命中——thinkingLevelMap 夹紧 medium→high（登记差异）', async () => {
  const cap = captureBodies();
  await chatTurn({
    baseUrl: 'https://api.deepseek.com/v1', apiKey: 'key', model: 'deepseek-flash',
    thinkingLevel: 'default', messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: cap.fetch, onPayload: cap.onPayload,
  });
  // 目录 thinkingLevelMap：medium→null（不支持），clampThinkingLevel 向上取 high。
  assert.equal(cap.bodies[0].reasoning_effort, 'high', 'pi-ai 目录夹紧：medium 不支持→high（已登记）');
  assert.deepEqual(cap.bodies[0].thinking, { type: 'enabled' });
});

test('等价矩阵：zai 目录命中 glm-5.3——thinking:{type}，off 落 disabled（+effort 为登记差异）', async () => {
  const base = { apiKey: 'key', messages: [{ role: 'user', content: 'hi' }] };
  const run = async (level) => {
    const cap = captureBodies();
    await chatTurn({ ...base, baseUrl: 'https://open.bigmodel.cn/v1', model: 'glm-5.3', thinkingLevel: level, fetchImpl: cap.fetch, onPayload: cap.onPayload });
    return cap.bodies[0];
  };
  assert.deepEqual((await run('default')).thinking, { type: 'enabled', clear_thinking: false });
  assert.deepEqual((await run('off')).thinking, { type: 'disabled' }, 'glm-5.3 目录 thinkingLevelMap.off＝null，但 zai 格式 off 有原生关法（等价旧实现）');
  // 登记差异：glm-5.3 目录 supportsReasoningEffort=true 且 thinkingLevelMap
  // medium:null（不支持中档）——clampThinkingLevel 向上取 high，effort 附带为 high。
  assert.equal((await run('default')).reasoning_effort, 'high');
});

test('等价矩阵：zai 目录旧款 glm-4.7（supportsReasoningEffort=false）不发 effort——与旧手写一致', async () => {
  const cap = captureBodies();
  await chatTurn({
    baseUrl: 'https://open.bigmodel.cn/v1', apiKey: 'key', model: 'glm-4.7',
    thinkingLevel: 'default', messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: cap.fetch, onPayload: cap.onPayload,
  });
  assert.deepEqual(cap.bodies[0].thinking, { type: 'enabled', clear_thinking: false });
  assert.ok(!('reasoning_effort' in cap.bodies[0]));
});

test('等价矩阵：显式 thinkingFormat 覆盖优先于 URL 探测（qwen/zai/deepseek 三型）', async () => {
  const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'key', messages: [{ role: 'user', content: 'hi' }] };
  const run = async (format, level) => {
    const cap = captureBodies();
    await chatTurn({ ...base, model: 'demo-relay', thinkingFormat: format, thinkingLevel: level, fetchImpl: cap.fetch, onPayload: cap.onPayload });
    return cap.bodies[0];
  };
  assert.equal((await run('qwen', 'low')).enable_thinking, true);
  assert.equal((await run('qwen', 'off')).enable_thinking, false);
  assert.ok(!('reasoning_effort' in (await run('qwen', 'low'))));
  assert.deepEqual((await run('zai', 'low')).thinking, { type: 'enabled', clear_thinking: false });
  assert.deepEqual((await run('deepseek', 'off')).thinking, { type: 'disabled' });
  // 显式格式下 supportsReasoningEffort 仅 openai 为真——deepseek/zai 不带 effort（等价旧实现）。
  assert.ok(!('reasoning_effort' in (await run('deepseek', 'low'))));
  assert.ok(!('reasoning_effort' in (await run('zai', 'low'))));
});

test('目录命中时显式格式同样优先：三档交给 SDK 发 qwen 参数，不泄漏 deepseek 字段', async () => {
  for (const level of ['low', 'medium', 'high']) {
    const cap = captureBodies();
    await chatTurn({
      baseUrl: 'https://relay.example/v1/chat/completions', apiKey: 'key', model: 'deepseek-flash',
      thinkingLevel: level, thinkingFormat: 'qwen', messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: cap.fetch, onPayload: cap.onPayload,
    });
    assert.equal(cap.bodies[0].enable_thinking, true);
    assert.ok(!('thinking' in cap.bodies[0]));
    assert.ok(!('reasoning_effort' in cap.bodies[0]));
    assert.ok(cap.bodies[0].max_tokens <= 32768);
  }
});

test('等价矩阵：openai 方言请求不带 store/developer 角色（与旧手写一致，不给中转站引入新字段）', async () => {
  const cap = captureBodies();
  await chatTurn({
    baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'demo-relay',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    fetchImpl: cap.fetch, onPayload: cap.onPayload,
  });
  const body = cap.bodies[0];
  assert.ok(!('store' in body));
  assert.ok(body.messages[0].role === 'system', '未知端点目录未命中也用 system 角色（不落 developer）');
  assert.equal(body.model, 'demo-relay');
});

// ---- 思考事件与结果契约（S2 消费面） ----

test('chatTurn：openai 方言思考流——onEvent 序列、result.thinking/usageDetail', async () => {
  const events = [];
  const deltas = [];
  const frame = (delta, finishReason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] })}\n\n`;
  const result = await chatTurn({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo-relay',
    messages: [{ role: 'user', content: '难题' }],
    onDelta: (text) => deltas.push(text),
    onEvent: (event) => events.push(event),
    fetchImpl: async () => sseResponse([
      frame({ reasoning_content: '设鸡' }),
      frame({ reasoning_content: ' x 只' }),
      frame({ content: '答' }),
      frame({ content: '案' }, 'stop'),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } })}\n\n`,
      'data: [DONE]\n\n',
    ]),
  });

  assert.equal(result.content, '答案');
  assert.deepEqual(deltas, ['答', '案']);
  const kinds = events.map((event) => event.kind);
  // thinking_end 在流收尾时才发（pi-ai 的 finishBlock 循环），晚于全部正文分片。
  assert.deepEqual(kinds, ['thinking_start', 'thinking', 'thinking', 'text', 'text', 'thinking_end']);
  assert.deepEqual(events.filter((event) => event.kind === 'thinking').map((event) => event.text), ['设鸡', ' x 只']);
  assert.equal(result.thinking.text, '设鸡 x 只');
  assert.ok(result.thinking.durationMs >= 0);
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 7, totalTokens: 17 });
  assert.deepEqual(
    { input: result.usageDetail.input, output: result.usageDetail.output, cacheRead: result.usageDetail.cacheRead, cacheWrite: result.usageDetail.cacheWrite },
    { input: 10, output: 7, cacheRead: 0, cacheWrite: 0 },
  );
  assert.ok(result.usageDetail.genMs >= 0);
});

// ---- 工具往返（openai 方言，与 anthropic 方言同一转换层） ----

test('chatTurn：openai 方言工具往返——tool_calls 解析与 role:tool 结果回传', async () => {
  const cap = captureBodies();
  const toolFragment = (fragment) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [fragment] } }] })}\n\n`;
  const first = await chatTurn({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo-relay',
    messages: [{ role: 'user', content: '建个文件' }],
    tools: [{ type: 'function', function: { name: 'execute_task', description: '动手做', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } }],
    fetchImpl: async () => sseResponse([
      toolFragment({ index: 0, id: 'call_1', function: { name: 'execute_task', arguments: '{"ta' } }),
      toolFragment({ index: 0, function: { arguments: 'sk":"建文件"}' } }),
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
    onPayload: cap.onPayload,
  });
  assert.equal(first.finishReason, 'tool_calls');
  assert.deepEqual(first.toolCalls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'execute_task', arguments: '{"task":"建文件"}' },
  }]);
  assert.ok(Array.isArray(cap.bodies[0].tools) && cap.bodies[0].tools[0].function.name === 'execute_task', '工具声明进请求');

  // 第二轮：历史带 assistant.tool_calls 与 role:'tool' 结果——OpenAI 形状完整往返。
  await chatTurn({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo-relay',
    messages: [
      { role: 'user', content: '建个文件' },
      { role: 'assistant', content: '', tool_calls: first.toolCalls },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ],
    fetchImpl: cap.fetch,
    onPayload: cap.onPayload,
  });
  const wire = JSON.stringify(cap.bodies[1].messages);
  assert.ok(wire.includes('"tool_calls"') && wire.includes('"tool_call_id":"call_1"'), 'assistant tool_calls 与 tool 结果按 OpenAI 形状往返');
});

// ---- 图片直传（028 parts → pi-ai 图像块 → 方言还原） ----

test('chatTurn：openai 方言图片 parts 直传——text + image_url 完整进请求', async () => {
  const cap = captureBodies();
  await chatTurn({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo-relay',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这图里是什么' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    }],
    fetchImpl: cap.fetch,
    onPayload: cap.onPayload,
  });
  const wire = JSON.stringify(cap.bodies[0].messages);
  assert.ok(wire.includes('这图里是什么'));
  assert.ok(wire.includes('image_url') && wire.includes('QUJD'), '图像 data URL 原样进请求体');
});

// ---- 版本同源门（D1：对话侧直依赖的 pi-ai 必须与 pi-coding-agent 内部同版本） ----

test('版本同源门：顶层 pi-ai 与 pi-coding-agent 内嵌 pi-ai 同版本', () => {
  const walkToPackage = (entryPath, packageName) => {
    let dir = path.dirname(entryPath);
    for (;;) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (parsed.name === packageName) return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`回溯到根仍未找到 ${packageName} 的包目录`);
      dir = parent;
    }
  };
  const versionOf = (pkgDir) => JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  const topLevelDir = walkToPackage(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')), '@earendil-works/pi-ai');
  const topLevel = versionOf(topLevelDir);
  // 执行侧的 pi-ai：pi-coding-agent 包内嵌副本（嵌套安装）或顶层副本（提升
  // 安装时两者本就同一路径）。exports 不暴露 require 条件，只能按包目录直读。
  const agentDir = walkToPackage(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '@earendil-works/pi-coding-agent');
  const nestedDir = path.join(agentDir, 'node_modules', '@earendil-works', 'pi-ai');
  const agentSide = fs.existsSync(path.join(nestedDir, 'package.json'))
    ? versionOf(nestedDir)
    : versionOf(topLevelDir);
  assert.equal(
    topLevel,
    agentSide,
    `pi-ai 两份物理副本版本漂移（顶层 ${topLevel} vs 执行侧解析到 ${agentSide}）——升级 pi 时必须同步升、同跑探针`,
  );
});

// ---- 与 chatTurn 的直连一致性（pi-chat 是 chatTurn 的唯一方言实现） ----

test('chatTurnPi 与 chatTurn 同一实现：缺配置的拒绝文案一致', async () => {
  await assert.rejects(chatTurnPi({ baseUrl: '', apiKey: 'k', model: 'm', messages: [] }), /端点未配置/);
  await assert.rejects(chatTurnPi({ baseUrl: 'https://x/v1', apiKey: '', model: 'm', messages: [] }), /未配置文本模型/);
  await assert.rejects(chatTurnPi({ baseUrl: 'https://x/v1', apiKey: 'k', model: '', messages: [] }), /未配置文本模型型号/);
});

// ---- 提示词缓存：历史末尾补显式断点（2026-10-09） ----

const CC = { type: 'ephemeral' };
const countBreakpoints = (params) => JSON.stringify(params).split('"cache_control"').length - 1;

test('历史断点：anthropic 形请求在本回合用户消息之前的最后一条历史上补断点，总数不超 4', () => {
  const params = {
    system: [{ type: 'text', text: 'S', cache_control: CC }],
    tools: [{ name: 'a' }, { name: 'b', cache_control: CC }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2＋本轮上下文', cache_control: CC }] },
      { role: 'system', content: [], output_config: { effort: 'medium' } },
    ],
  };
  addHistoryCacheBreakpoint(params);
  assert.deepEqual(params.messages[1].content[0].cache_control, CC);
  assert.equal(countBreakpoints(params), 4);
  addHistoryCacheBreakpoint(params);
  assert.equal(countBreakpoints(params), 4, '满 4 个不再加（Anthropic 上限）');
});

test('历史断点：工具续轮的 tool_result 不算本回合用户消息，断点仍落在上一轮历史末尾', () => {
  const params = {
    system: [{ type: 'text', text: 'S', cache_control: CC }],
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'execute_task', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok', cache_control: CC }] },
    ],
  };
  addHistoryCacheBreakpoint(params);
  assert.deepEqual(params.messages[1].content, [{ type: 'text', text: 'a1', cache_control: CC }], '字符串内容转成带断点的 text 块');
  assert.equal(params.messages[3].content[0].cache_control, undefined);
});

test('历史断点：自动前缀缓存的端点（无显式断点）与首回合原样放行', () => {
  const automatic = { messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }] };
  const before = JSON.stringify(automatic);
  addHistoryCacheBreakpoint(automatic);
  assert.equal(JSON.stringify(automatic), before, 'DeepSeek/OpenAI 这类没有 cache_control 的请求不动');

  const firstTurn = { system: [{ type: 'text', text: 'S', cache_control: CC }], messages: [{ role: 'user', content: [{ type: 'text', text: 'u1', cache_control: CC }] }] };
  addHistoryCacheBreakpoint(firstTurn);
  assert.equal(countBreakpoints(firstTurn), 2, '没有历史就没有历史断点');
});

test('历史断点：anthropic 方言两回合——上回合断点之前的前缀逐字节一致，本回合断点前移到新历史末尾', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of [
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`,
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const tools = [{ type: 'function', function: { name: 'execute_task', description: '动手做', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } }];
  const base = { baseUrl: 'https://cf.relay.example/v1', apiKey: 'key', model: 'claude-opus-5-5', api: 'anthropic-messages', tools, fetchImpl };
  const history = [{ role: 'system', content: '稳定的系统提示词' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }];
  await chatTurn({ ...base, messages: [...history, { role: 'user', content: 'u2\n\n［本轮上下文］19:32' }] });
  await chatTurn({ ...base, messages: [...history, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3\n\n［本轮上下文］19:41' }] });

  const [first, second] = bodies;
  assert.equal(countBreakpoints(first), 4, '工具尾＋system＋历史末尾＋末条消息');
  assert.equal(countBreakpoints(second), 4);
  const marked = (body) => body.messages.findIndex((message) => Array.isArray(message.content) && message.content.some((block) => block.cache_control) && message.role === 'assistant');
  assert.equal(first.messages[marked(first)].content[0].text, 'a1');
  assert.equal(second.messages[marked(second)].content[0].text, 'a2', '断点随历史前移');
  // 供应商按内容匹配前缀（断点标记本身不参与）：上回合历史断点之前的部分必须一致。
  const strip = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v)));
  const prefix = (body) => strip({ system: body.system, tools: body.tools, messages: body.messages.slice(0, marked(first) + 1) });
  assert.deepEqual(prefix(second), prefix(first));
});
