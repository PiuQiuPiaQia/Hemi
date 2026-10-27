import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTurnContextBlock,
  buildWorkspaceTurnBlock,
  chatTurn,
  normalizeBaseUrl,
  listRemoteModels,
  parseModelsResponse,
  pingTextModel,
  TURN_CONTEXT_HEADER,
} from './text-model.mjs';
import { AGENT_PRINCIPLES, buildAgentAppendSystem } from '../agent/main-agent.mjs';

const encoder = new TextEncoder();

/**
 * 用 Web ReadableStream 造一个 SSE 响应体（048 起 openai 方言走 pi-ai/OpenAI
 * SDK，fetchImpl 必须回真 Response；错误体走 text 兜底）。
 */
function sseResponse(frames, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  if (status >= 400) return new Response('error body', { status });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function contentFrame(text, { finishReason } = {}) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  })}\n\n`;
}

test('normalizeBaseUrl：容忍结尾斜杠与已完整的端点', () => {
  assert.equal(
    normalizeBaseUrl('https://api.example.com/v1/'),
    'https://api.example.com/v1/chat/completions',
  );
  assert.equal(
    normalizeBaseUrl('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1/chat/completions',
  );
  assert.equal(normalizeBaseUrl('  '), '');
});

test('chatTurn：流式收完整句，onDelta 逐段回调', async () => {
  const deltas = [];
  const seenBodies = [];
  const result = await chatTurn({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo',
    messages: [{ role: 'user', content: '你好' }],
    onDelta: (text) => deltas.push(text),
    fetchImpl: async (url, init) => {
      seenBodies.push({ url, body: JSON.parse(init.body) });
      return sseResponse([contentFrame('你'), contentFrame('好', { finishReason: 'stop' }), 'data: [DONE]\n\n']);
    },
  });

  assert.equal(result.content, '你好');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(deltas, ['你', '好']);
  assert.ok(seenBodies[0].url.endsWith('/v1/chat/completions'));
  assert.equal(seenBodies[0].body.stream, true);
  assert.equal(seenBodies[0].body.model, 'demo');
});

test('chatTurn：缺 [DONE] 且无 finish_reason 视为截断', async () => {
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key',
      model: 'demo',
      messages: [],
      fetchImpl: async () => sseResponse([contentFrame('半句')]),
    }),
    /截断/,
  );
});

test('chatTurn：HTTP 401 归一化为鉴权错误', async () => {
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad',
      model: 'demo',
      messages: [],
      fetchImpl: async () => sseResponse([], { status: 401 }),
    }),
    /鉴权失败/,
  );
});

test('chatTurn：无首字超时', async () => {
  // 仿 undici：abort 信号要让响应体 read() 以 AbortError 拒绝，而不是永远挂起。
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key',
      model: 'demo',
      messages: [],
      timeoutMs: 40,
      fetchImpl: (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    }),
    /首字超时/,
  );
});

test('chatTurn：思考帧掐首字门——思考超过门限后正文到达不判超时（048 现网缺陷回归）', async () => {
  const frame = (delta, finishReason) => encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] })}\n\n`);
  const result = await chatTurn({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo',
    messages: [],
    timeoutMs: 40,
    fetchImpl: (_url, init) => new Response(new ReadableStream({
      async start(controller) {
        // 仿 undici：首字门 abort 让 read() 以 AbortError 拒绝（未修复时即判超时）。
        init.signal.addEventListener(
          'abort',
          () => controller.error(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
        controller.enqueue(frame({ reasoning_content: '想' }));
        await new Promise((resolve) => setTimeout(resolve, 120)); // 思考远超 40ms 首字门
        controller.enqueue(frame({ content: '答案' }, 'stop'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(result.content, '答案');
});

test('chatTurn：外部取消与配置缺失', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key',
      model: 'demo',
      messages: [],
      signal: controller.signal,
      fetchImpl: async () => sseResponse([contentFrame('你')]),
    }),
    /取消/,
  );

  await assert.rejects(
    chatTurn({ baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'demo', messages: [] }),
    /未配置文本模型/,
  );
});

test('buildTurnContextBlock：逐回合块带宿主标题、空块跳过、全空不出标题', () => {
  assert.equal(buildTurnContextBlock({}), '');
  const block = buildTurnContextBlock({
    ambientBlock: '【环境】今天是2026年9月20日',
    workspaceBlock: '【工作区】本回合绑定项目「video」：/Volumes/Projects/Projects/video',
    runtimeBlock: '',
    taskEvidenceBlock: '［最近任务 · 结果依据］任务：查天气',
    routingBlock: '［任务清单 · 判断新指令归谁用］',
  });
  assert.ok(block.startsWith(TURN_CONTEXT_HEADER));
  const ambientAt = block.indexOf('【环境】');
  const workspaceAt = block.indexOf('【工作区】');
  const evidenceAt = block.indexOf('［最近任务');
  const routingAt = block.indexOf('［任务清单');
  assert.ok(ambientAt > 0 && ambientAt < workspaceAt && workspaceAt < evidenceAt && evidenceAt < routingAt);
  // 系统提示词按同一个名字指认它（改标题必须同步改提示词）。
  assert.ok(AGENT_PRINCIPLES.includes('［本轮上下文］'));
});

test('buildWorkspaceTurnBlock：项目/远端/默认空间逐回合重申绑定与目录，空入参不出块', () => {
  assert.equal(buildWorkspaceTurnBlock(null), '');
  assert.equal(buildWorkspaceTurnBlock(undefined), '');
  assert.equal(buildWorkspaceTurnBlock({}), '');
  const project = buildWorkspaceTurnBlock({ type: 'project', name: 'video', dir: '/Volumes/Projects/Projects/video' });
  assert.ok(project.includes('「video」'));
  assert.ok(project.includes('/Volumes/Projects/Projects/video'));
  assert.ok(project.includes('执行目录（cwd）'));
  assert.ok(project.includes('「这个目录」'));
  const remote = buildWorkspaceTurnBlock({ type: 'project', name: 'srv', host: 'web-1', dir: '/srv/app' });
  assert.ok(remote.includes('远端项目'));
  assert.ok(remote.includes('web-1'));
  assert.ok(remote.includes('/srv/app'));
  const defaults = buildWorkspaceTurnBlock({
    type: 'default', name: '默认空间',
    dir: '/Users/demo/Library/Application Support/hemi/workspace/default',
  });
  assert.ok(defaults.includes('未绑定项目'));
  assert.ok(defaults.includes('workspace/default'));
  assert.ok(defaults.includes('先确认位置'));
});

test('主 agent 稳定系统段：原则在前、空段跳过、逐回合变化的块不进 system（缓存口径）', () => {
  const base = buildAgentAppendSystem({});
  assert.equal(base.length, 1);
  assert.ok(base[0].includes('你是 Hemi'));
  const full = buildAgentAppendSystem({
    routingSection: '［子 agent · 按需派活］',
    workspaceBlock: '［工作区］Hemi',
  });
  assert.deepEqual(full.slice(1), ['［子 agent · 按需派活］', '［工作区］Hemi']);
  for (const volatile of ['今天是', 'requestId', '［最近任务', '本回合绑定项目', '未绑定项目']) {
    assert.ok(!full.join('\n').includes(volatile), `system 不得含逐回合变化的块：${volatile}`);
  }
  // 渠道规则在口，不在主 agent；能自己看的歧义先看（056 起因：读不到项目 skill）。
  assert.ok(!AGENT_PRINCIPLES.includes('只回一句话'));
  assert.match(AGENT_PRINCIPLES, /\.claude\/skills/);
  assert.equal(JSON.stringify(buildAgentAppendSystem({ routingSection: 'x' })), JSON.stringify(buildAgentAppendSystem({ routingSection: 'x' })));
});

test('pingTextModel：200 返回服务端模型名（别名现形），请求为非流式最小探活', async () => {
  const seen = [];
  const result = await pingTextModel({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'key',
    model: 'deepseek-v4-flash',
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content: '' } }] }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedModel, 'deepseek-flash');
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(seen[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seen[0].body.stream, false);
  assert.equal(seen[0].body.messages[0].content, 'ping');
  // 推理模型把 max_tokens 花在思考上、正文为空——探活照样算通。
  assert.equal(result.sample, '');
});

test('首启工具连接测试：两种协议均要求返回匹配的工具与参数，不执行工具', async () => {
  for (const api of ['openai-completions', 'anthropic-messages']) {
    let request;
    const anthropic = api === 'anthropic-messages';
    const options = { api, baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test', requireTools: true };
    const fetchImpl = async (_url, init) => {
      request = JSON.parse(init.body);
      return { ok: true, json: async () => anthropic
        ? { content: [{ type: 'tool_use', name: 'hemi_connection_check', input: { ok: true } }] }
        : { choices: [{ message: { tool_calls: [{ function: { name: 'hemi_connection_check', arguments: '{"ok":true}' } }] } }] } };
    };
    assert.equal((await pingTextModel({ ...options, fetchImpl })).ok, true);
    assert.equal(request.tools.length, 1);
    assert.equal(anthropic ? request.tools[0].input_schema.required[0] : request.tools[0].function.parameters.required[0], 'ok');
    for (const response of [{}, { choices: [{ message: { content: 'ok' } }] }, { content: [{ type: 'text', text: 'ok' }] },
      { choices: [{ message: { tool_calls: [{ function: { name: 'hemi_connection_check', arguments: '{"ok":false}' } }] } }] },
      { content: [{ type: 'tool_use', name: 'wrong_tool', input: { ok: true } }] }]) {
      await assert.rejects(pingTextModel({ ...options, fetchImpl: async () => ({ ok: true, json: async () => response }) }), /有效的工具调用/);
    }
  }
});

test('pingTextModel：401/404/网络错归一化，缺配置直接拒绝', async () => {
  await assert.rejects(
    pingTextModel({
      baseUrl: 'https://x/v1', apiKey: 'bad', model: 'm',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }),
    }),
    /鉴权失败/,
  );
  await assert.rejects(
    pingTextModel({
      baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    }),
    /型号不存在/,
  );
  await assert.rejects(
    pingTextModel({
      baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    /连不上/,
  );
  await assert.rejects(pingTextModel({ baseUrl: '', apiKey: 'k', model: 'm' }), /端点未配置/);
  await assert.rejects(pingTextModel({ baseUrl: 'https://x/v1', apiKey: '', model: 'm' }), /API Key/);
  await assert.rejects(pingTextModel({ baseUrl: 'https://x/v1', apiKey: 'k', model: '' }), /型号/);
});

test('pingTextModel：anthropic-messages 方言打 /v1/messages，x-api-key 鉴权，剥 /v1 防双拼（051）', async () => {
  const seen = [];
  const result = await pingTextModel({
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1/',
    apiKey: 'sk-ant-key',
    model: 'claude-sonnet-4-5',
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'claude-sonnet-4-5-20261001',
          content: [{ type: 'text', text: 'pong' }],
        }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-key');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[0].body.max_tokens, 16);
  assert.equal(seen[0].body.stream, false);
  assert.equal(result.resolvedModel, 'claude-sonnet-4-5-20261001');
  assert.equal(result.sample, 'pong');
  // 不带 /v1 的根地址直接拼（宿主端点两种习惯都收）。
  await pingTextModel({
    api: 'anthropic-messages',
    baseUrl: 'https://gateway.example.com',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async (url) => {
      seen.push({ url });
      return { ok: true, status: 200, json: async () => ({ content: [] }) };
    },
  });
  assert.equal(seen.at(-1).url, 'https://gateway.example.com/v1/messages');
  await pingTextModel({
    api: 'anthropic-messages', baseUrl: 'https://gateway.example.com/v1/messages/', apiKey: 'k', model: 'm',
    fetchImpl: async (url) => {
      seen.push({ url });
      return { ok: true, status: 200, json: async () => ({ content: [] }) };
    },
  });
  assert.equal(seen.at(-1).url, 'https://gateway.example.com/v1/messages', '完整接口地址与 SDK 路径共用归一');
});

test('pingTextModel：anthropic 方言错误与正文为空（思考吃满 max_tokens 也算探活通）', async () => {
  // 服务端错误体 {type:'error',error:{message}} → describeHttpError 同样归一。
  await assert.rejects(
    pingTextModel({
      api: 'anthropic-messages',
      baseUrl: 'https://x',
      apiKey: 'bad',
      model: 'm',
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ type: 'error', error: { message: 'invalid x-api-key' } }),
      }),
    }),
    /鉴权失败/,
  );
  // 正文块缺失（推理模型把 max_tokens 花在思考上）：ok 照旧，sample 为空串。
  const result = await pingTextModel({
    api: 'anthropic-messages',
    baseUrl: 'https://x',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: 'm', content: [{ type: 'thinking', thinking: '…' }] }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.sample, '');
});

test('parseModelsResponse：OpenAI 兼容形与 Ollama 原生形都收，去重排序去空', () => {
  assert.deepEqual(
    parseModelsResponse({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: '  ' }, null, { object: 'model' }] }),
    ['a', 'b'],
  );
  assert.deepEqual(parseModelsResponse({ models: [{ name: 'qwen2.5:14b' }] }), ['qwen2.5:14b']);
  // 字段优先级 id > name > model：同一行有 id 时 name 不参赛。
  assert.deepEqual(parseModelsResponse({ data: [{ id: 'x', name: 'ignored-name' }, { name: 'y' }] }), ['x', 'y']);
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse({ foo: 1 }), []);
});

test('listRemoteModels：GET {base}/models，带/不带 Authorization，结果去重排序', async () => {
  const seen = [];
  const result = await listRemoteModels({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'key',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'm2' }, { id: 'm1' }] }),
      };
    },
  });
  assert.equal(seen[0].url, 'https://api.example.com/v1/models');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer key');
  assert.deepEqual(result.models, ['m1', 'm2']);

  // 本地端点免 Key：不构造 Authorization 头。
  const bare = await listRemoteModels({
    baseUrl: 'http://127.0.0.1:11434/v1',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'q' }] }) };
    },
  });
  assert.equal(bare.models.length, 1);
  assert.equal(seen.at(-1).init.headers, undefined);
});

test('listRemoteModels：401 归一化文案、空列表与网络错就地报错', async () => {
  await assert.rejects(
    listRemoteModels({
      baseUrl: 'https://x/v1', apiKey: 'bad',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }),
    }),
    /鉴权失败/,
  );
  await assert.rejects(
    listRemoteModels({
      baseUrl: 'https://x/v1', apiKey: 'k',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    }),
    /没有返回任何模型/,
  );
  await assert.rejects(
    listRemoteModels({
      baseUrl: 'https://x/v1', apiKey: 'k',
      fetchImpl: async () => { throw new Error('boom'); },
    }),
    /连不上/,
  );
});

test('pingTextModel：超时报超时而不是误报网络错', async () => {
  await assert.rejects(
    pingTextModel({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
    }),
    /超时/,
  );
});

test('chatTurn 首 token 前瞬时故障重试：5xx 一次后恢复；网络错耗尽后如实抛（2026-09-23 加固）', async () => {
  const base = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'demo',
    messages: [{ role: 'user', content: '你好' }],
  };
  const okFrames = () => sseResponse([contentFrame('好', { finishReason: 'stop' }), 'data: [DONE]\n\n']);

  // 500 → 200：重试一次恢复（退避 1s）
  let calls = 0;
  const r1 = await chatTurn({
    ...base,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response('oops', { status: 500 }) : okFrames();
    },
  });
  assert.equal(calls, 2);
  assert.equal(r1.content, '好');

  // 网络错 ×3：耗尽后抛「连不上」
  let netCalls = 0;
  await assert.rejects(
    () => chatTurn({
      ...base,
      fetchImpl: async () => {
        netCalls += 1;
        throw new Error('ECONNRESET');
      },
    }),
    /连不上文本模型服务/,
  );
  assert.equal(netCalls, 3); // 首调 + 2 次重试

  // 401 不重试（配置类错误立刻显性）
  let authCalls = 0;
  await assert.rejects(
    () => chatTurn({
      ...base,
      fetchImpl: async () => {
        authCalls += 1;
        return new Response('bad key', { status: 401 });
      },
    }),
    /API Key/,
  );
  assert.equal(authCalls, 1);
});

// —— 032：探活错误分类矩阵（本地 mock OpenAI 兼容端点，不依赖外部服务）——

import http from 'node:http';
import { classifyModelError } from './text-model.mjs';

/** 起一个 mock 端点：mode 决定行为；返回 { baseUrl, close }。 */
async function mockEndpoint(mode) {
  const server = http.createServer((req, res) => {
    if (mode === 'hang') return; // 收请求不回 → 客户端超时
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (mode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'mock-resolved-model',
          choices: [{ message: { content: 'pong' } }],
        }));
        return;
      }
      if (mode === '401') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      if (mode === '404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }
      res.writeHead(500);
      res.end('boom');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 断言一次 ping 的分类：resolve → ok；reject → classifyModelError。 */
async function pingKind(promise) {
  try {
    const result = await promise;
    return { ok: true, resolvedModel: result.resolvedModel };
  } catch (error) {
    return { ok: false, kind: classifyModelError(error.message), message: error.message };
  }
}

test('032 探活分类矩阵：成功／鉴权／模型不可用／服务端错误／超时／断网（本地 mock 端点）', async () => {
  const ok = await mockEndpoint('ok');
  const unauth = await mockEndpoint('401');
  const notFound = await mockEndpoint('404');
  const serverErr = await mockEndpoint('500');
  const hanging = await mockEndpoint('hang');
  try {
    // 成功：回执带服务端解析出的模型名（别名现形）。
    const success = await pingKind(pingTextModel({ baseUrl: ok.baseUrl, apiKey: 'k', model: 'mock-model' }));
    assert.deepEqual(success, { ok: true, resolvedModel: 'mock-resolved-model' });

    // 401/403 → 鉴权失败（提示换 Key）。
    const auth = await pingKind(pingTextModel({ baseUrl: unauth.baseUrl, apiKey: 'bad', model: 'm' }));
    assert.equal(auth.ok, false);
    assert.equal(auth.kind, 'auth');

    // 404 → 端点或型号不存在（模型不可用类）。
    const model = await pingKind(pingTextModel({ baseUrl: notFound.baseUrl, apiKey: 'k', model: 'gone-model' }));
    assert.equal(model.ok, false);
    assert.equal(model.kind, 'model');

    // 5xx → 网络类（原文案如实说服务端出错）。
    const server = await pingKind(pingTextModel({ baseUrl: serverErr.baseUrl, apiKey: 'k', model: 'm' }));
    assert.equal(server.ok, false);
    assert.equal(server.kind, 'network');
    assert.match(server.message, /服务出错/);

    // 超时：挂起端点 + 300ms 上限。
    const timeout = await pingKind(pingTextModel({
      baseUrl: hanging.baseUrl, apiKey: 'k', model: 'm', timeoutMs: 300,
    }));
    assert.equal(timeout.ok, false);
    assert.equal(timeout.kind, 'timeout');

    // 断网：端口收掉后再探。
    const deadPort = hanging.port;
    await hanging.close();
    const dead = await pingKind(pingTextModel({
      baseUrl: `http://127.0.0.1:${deadPort}/v1`, apiKey: 'k', model: 'm', timeoutMs: 2000,
    }));
    assert.equal(dead.ok, false);
    assert.equal(dead.kind, 'network');
  } finally {
    await ok.close();
    await unauth.close();
    await notFound.close();
    await serverErr.close();
  }
});

test('032 探活分类：缺项（端点/Key/型号未配置）归 missing，不误报网络', async () => {
  assert.equal(classifyModelError('文本模型端点未配置。'), 'missing');
  assert.equal(classifyModelError('未配置 API Key，请先填写并保存。'), 'missing');
  assert.equal(classifyModelError('未配置型号，请先填写。'), 'missing');
  // 直接调用 pingTextModel 的缺项路径（不发请求）。
  const noKey = await pingKind(pingTextModel({ baseUrl: 'https://x/v1', apiKey: '', model: 'm' }));
  assert.equal(noKey.ok, false);
  assert.equal(noKey.kind, 'missing');
});

// ---- 046：Anthropic Messages 方言（api='anthropic-messages' 整条委托 pi-ai） ----

/** Anthropic SSE 原始帧（pi-ai 的 iterateAnthropicEvents 直接消费字节流）。 */
function anthropicSseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicReplyFrames(text, { inputTokens = 12, outputTokens = 34 } = {}) {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: inputTokens, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

test('chatTurn：anthropic-messages 方言走 /v1/messages，adaptive 型号思考落 effort（default→medium）', async () => {
  const seen = [];
  const deltas = [];
  const result = await chatTurn({
    baseUrl: 'https://cf.relay.example/v1',
    apiKey: 'key',
    model: 'claude-opus-5-5',
    api: 'anthropic-messages',
    thinkingLevel: 'default',
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }],
    onDelta: (text) => deltas.push(text),
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return anthropicSseResponse(anthropicReplyFrames('你好'));
    },
  });

  assert.equal(result.content, '你好');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(deltas, ['你好']);
  assert.equal(new URL(seen[0].url).pathname, '/v1/messages', '端点尾段 /v1 剥掉后由 SDK 拼 /v1/messages');
  assert.equal(seen[0].body.system?.[0]?.text, '你是助手', 'system 提示词进 Anthropic system 块');
  // 目录 compat（forceAdaptiveThinking）：thinking adaptive 形状，effort 放在标准顶层，兼容网关不接收原生消息控制。
  assert.equal(seen[0].body.thinking.type, 'adaptive');
  assert.equal(seen[0].body.output_config.effort, 'medium');
  assert.ok(seen[0].body.messages.every(message => !message.clear_at && !message.output_config));
  // usage 映射（totalTokens＝input＋output）。
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46 });
});

test('chatTurn：anthropic 方言思考档映射——off 在 adaptive 型号落 low，旧型号落 disabled', async () => {
  const bodies = [];
  const makeFetch = () => async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return anthropicSseResponse(anthropicReplyFrames('好'));
  };
  const base = {
    baseUrl: 'https://cf.relay.example/v1',
    apiKey: 'key',
    api: 'anthropic-messages',
    messages: [{ role: 'user', content: 'hi' }],
  };
  await chatTurn({ ...base, model: 'claude-opus-5-5', thinkingLevel: 'off', fetchImpl: makeFetch() });
  assert.equal(bodies[0].output_config.effort, 'low', 'adaptive 型号关不掉思考，落 low 表达尽量少想');
  await chatTurn({ ...base, model: 'claude-opus-4-5', thinkingLevel: 'off', fetchImpl: makeFetch() });
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' }, '旧型号有原生关法');
});

test('chatTurn：anthropic 方言 HTTP 400 归一化为结构化错误（status 透传）', async () => {
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://cf.relay.example/v1',
      apiKey: 'key',
      model: 'claude-opus-5-5',
      api: 'anthropic-messages',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thinking shape' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => error.kind === 'http' && error.status === 400 && /HTTP 400/.test(error.message),
  );
});

test('chatTurn：anthropic 方言目录未收录型号落 budget 思考形状（保守兼容）', async () => {
  const bodies = [];
  const result = await chatTurn({
    baseUrl: 'https://cf.relay.example/v1',
    apiKey: 'key',
    model: 'my-relay-claude',
    api: 'anthropic-messages',
    thinkingLevel: 'default',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return anthropicSseResponse(anthropicReplyFrames('好'));
    },
  });
  assert.equal(result.content, '好');
  assert.equal(bodies[0].thinking.type, 'enabled', '无 compat 的未知型号走旧版 budget 形状');
});

test('chatTurn：anthropic 方言工具往返——声明 tools、tool_use 解析、tool 结果回传', async () => {
  const bodies = [];
  const makeFetch = () => async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return anthropicSseResponse([
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc_1', name: 'execute_task' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"task":"建文件"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } })}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  };

  // 第 1 轮：带工具声明，模型回 tool_use。
  const first = await chatTurn({
    baseUrl: 'https://cf.relay.example/v1', apiKey: 'key', model: 'claude-opus-5-5', api: 'anthropic-messages',
    messages: [{ role: 'user', content: '建个文件' }],
    tools: [{ type: 'function', function: { name: 'execute_task', description: '动手做', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } }],
    fetchImpl: makeFetch(),
  });
  assert.equal(first.toolCalls.length, 1);
  assert.deepEqual(first.toolCalls[0], { id: 'tc_1', type: 'function', function: { name: 'execute_task', arguments: '{"task":"建文件"}' } });
  assert.ok(Array.isArray(bodies[0].tools) && bodies[0].tools[0].name === 'execute_task', '工具声明进请求');

  // 第 2 轮：历史带上 assistant.tool_calls 与 role:'tool' 结果， anthropic 形状往返。
  await chatTurn({
    baseUrl: 'https://cf.relay.example/v1', apiKey: 'key', model: 'claude-opus-5-5', api: 'anthropic-messages',
    messages: [
      { role: 'user', content: '建个文件' },
      { role: 'assistant', content: '', tool_calls: first.toolCalls },
      { role: 'tool', tool_call_id: 'tc_1', content: '{"ok":true}' },
    ],
    tools: [{ type: 'function', function: { name: 'execute_task', description: '动手做', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } }],
    fetchImpl: makeFetch(),
  });
  const wire = JSON.stringify(bodies[1].messages);
  assert.ok(wire.includes('"tool_use"') && wire.includes('"tool_result"'), 'tool_use／tool_result 原生形状往返');
  assert.ok(wire.includes('tc_1'), 'toolCallId 配对不断');
});

test('chatTurn：anthropic 方言首字门禁超时归类为 timeout（SDK abort 以 error 事件收场不串类）', async () => {
  // 永不吐事件的流：abort 时以 AbortError 拒绝（模拟真 fetch 的断连行为）。
  const stalled = (signal) => new Response(new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://cf.relay.example/v1', apiKey: 'key', model: 'claude-opus-5-5', api: 'anthropic-messages',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 60,
      fetchImpl: async (_url, init) => stalled(init?.signal),
    }),
    (error) => error.kind === 'timeout' && /首字超时/.test(error.message),
  );
});

test('chatTurn：anthropic 方言多轮历史（assistant 裸字符串）转块数组后正常到达网络', async () => {
  let reached = false;
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://cf.relay.example', apiKey: 'key', model: 'claude-sonnet-5-5', api: 'anthropic-messages',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀。' },
        { role: 'user', content: '1' },
      ],
      timeoutMs: 3000,
      fetchImpl: async () => { reached = true; throw new Error('NO-NET'); },
    }),
    /NO-NET|连不上|连接|Connection/,
  );
  assert.equal(reached, true, '多轮历史必须通过转换层到达 fetch');
});

test('chatTurn：anthropic 方言 assistant 打头的历史（合成消息带完整契约字段）不崩上下文估算', async () => {
  // pi-ai 的 max_tokens 收缩路径会读历史 assistant 的 stopReason/usage——
  // 缺字段在 assistant 打头的真机历史上崩 undefined.totalTokens（dev 实测）。
  let reached = false;
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://cf.relay.example', apiKey: 'key', model: 'claude-sonnet-5-5', api: 'anthropic-messages',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '我是 Hemi。' },
        { role: 'user', content: '你是谁' },
        { role: 'assistant', content: '我是 Hemi，桌面语音助手。' },
        { role: 'user', content: '你不是hemi' },
      ],
      timeoutMs: 3000,
      fetchImpl: async () => { reached = true; throw new Error('NO-NET'); },
    }),
    /NO-NET|连不上|连接|Connection/,
  );
  assert.equal(reached, true, 'assistant 打头的历史必须完整通过转换与估算');
});
