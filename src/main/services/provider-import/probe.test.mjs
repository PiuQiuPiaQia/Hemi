import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anthropicEndpoint,
  fetchOpenaiModels,
  openaiEndpoint,
  openaiModelsEndpoint,
  probeAnthropicMessages,
  probeOpenaiChat,
} from './probe.mjs';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function htmlResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => '<html>login</html>' };
}

test('端点拼接：openai 追 /chat/completions、anthropic 吸收 /v1 变体', () => {
  assert.equal(openaiEndpoint('https://vvcode.top/v1'), 'https://vvcode.top/v1/chat/completions');
  assert.equal(openaiEndpoint('https://vvcode.top/v1/'), 'https://vvcode.top/v1/chat/completions');
  assert.equal(openaiModelsEndpoint('https://vvcode.top/v1'), 'https://vvcode.top/v1/models');
  assert.equal(anthropicEndpoint('https://vvcode.top'), 'https://vvcode.top/v1/messages');
  assert.equal(anthropicEndpoint('https://vvcode.top/v1'), 'https://vvcode.top/v1/messages');
  assert.equal(anthropicEndpoint('https://vvcode.top/v1/messages'), 'https://vvcode.top/v1/messages');
});

test('openai 探活：合法成功过；200+HTML／空 choices／错误对象不放行', async () => {
  const ok = await probeOpenaiChat({
    baseUrl: 'https://s/v1', apiKey: 'sk-x', model: 'gpt',
    fetchImpl: async () => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'pong' } }], model: 'gpt' }),
  });
  assert.equal(ok.ok, true);

  const html = await probeOpenaiChat({ baseUrl: 'https://s/v1', apiKey: 'sk-x', model: 'gpt', fetchImpl: async () => htmlResponse() });
  assert.equal(html.ok, false);
  assert.equal(html.code, 'not-json');

  const empty = await probeOpenaiChat({
    baseUrl: 'https://s/v1', apiKey: 'sk-x', model: 'gpt',
    fetchImpl: async () => jsonResponse({ object: 'chat.completion', choices: [] }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'no-choices');

  const auth = await probeOpenaiChat({
    baseUrl: 'https://s/v1', apiKey: 'sk-x', model: 'gpt',
    fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401),
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 'auth');

  // 合法空正文（content 缺省）不算失败
  const emptyContent = await probeOpenaiChat({
    baseUrl: 'https://s/v1', apiKey: 'sk-x', model: 'gpt',
    fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: 'stop' }] }),
  });
  assert.equal(emptyContent.ok, true);
});

test('anthropic 探活：messages 结构过；HTML/role 异常/401 拒绝', async () => {
  const ok = await probeAnthropicMessages({
    baseUrl: 'https://s', apiKey: 'sk-x', model: 'claude',
    fetchImpl: async () => jsonResponse({ role: 'assistant', content: [{ type: 'text', text: 'pong' }], model: 'claude' }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.sample, 'pong');

  const html = await probeAnthropicMessages({ baseUrl: 'https://s', apiKey: 'sk-x', model: 'claude', fetchImpl: async () => htmlResponse() });
  assert.equal(html.ok, false);
  assert.equal(html.code, 'not-json');

  const noContent = await probeAnthropicMessages({
    baseUrl: 'https://s', apiKey: 'sk-x', model: 'claude',
    fetchImpl: async () => jsonResponse({ role: 'assistant' }),
  });
  assert.equal(noContent.ok, false);
  assert.equal(noContent.code, 'no-content');

  const auth = await probeAnthropicMessages({
    baseUrl: 'https://s', apiKey: 'sk-x', model: 'claude',
    fetchImpl: async () => jsonResponse({ type: 'error', error: { message: 'x' } }, 401),
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 'auth');
});

test('模型列表：data[].id 与 models[].name 两种形态；保留 endpointTypes；坏形态拒绝', async () => {
  const listed = await fetchOpenaiModels({
    baseUrl: 'https://s/v1', apiKey: 'sk-x',
    fetchImpl: async () => jsonResponse({ data: [
      { id: 'gpt-5.2', supported_endpoint_types: ['openai'] },
      { id: 'claude-opus-4.6', supported_endpoint_types: ['openai', 'anthropic'] },
    ] }),
  });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.models[1].endpointTypes, ['openai', 'anthropic']);

  const legacy = await fetchOpenaiModels({
    baseUrl: 'https://s/v1', apiKey: 'sk-x',
    fetchImpl: async () => jsonResponse({ models: [{ name: 'm1' }] }),
  });
  assert.deepEqual(legacy.models, [{ id: 'm1' }]);

  const bad = await fetchOpenaiModels({ baseUrl: 'https://s/v1', apiKey: 'sk-x', fetchImpl: async () => jsonResponse({ data: 'nope' }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'shape-mismatch');
});

test('fetch 抛错→network；请求头带对应协议认证', async () => {
  const seen = [];
  const fail = await probeOpenaiChat({
    baseUrl: 'https://s/v1', apiKey: 'sk-x', model: 'gpt',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      throw new Error('boom');
    },
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 'network');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-x');

  const seenAnthropic = [];
  await probeAnthropicMessages({
    baseUrl: 'https://s', apiKey: 'sk-a', model: 'c',
    fetchImpl: async (url, init) => {
      seenAnthropic.push({ url, init });
      throw new Error('boom');
    },
  }).catch(() => undefined);
  assert.equal(seenAnthropic[0].init.headers['x-api-key'], 'sk-a');
  assert.equal(seenAnthropic[0].url, 'https://s/v1/messages');
});
