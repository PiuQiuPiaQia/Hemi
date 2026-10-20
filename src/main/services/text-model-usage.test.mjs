// 038：chatTurn 的 usage 透传、结构化错误字段与重试预算参数化（离线单测）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatTurn } from './text-model.mjs';

/** 假 SSE 服务：按脚本返回（含 usage-only 帧）。 */
function sseResponse(frames, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (text, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
const usageFrame = (tokens) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: tokens } })}\n\n`;

test('chatTurn：服务返回 usage 帧时随结果透传；缺失为 null（不写零）', async () => {
  const withUsage = await chatTurn({
    baseUrl: 'https://x.example/v1',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => sseResponse([chunk('好', 'stop'), usageFrame(15), 'data: [DONE]\n\n']),
  });
  assert.deepEqual(withUsage.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });

  const noUsage = await chatTurn({
    baseUrl: 'https://x.example/v1',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => sseResponse([chunk('好', 'stop'), 'data: [DONE]\n\n']),
  });
  assert.equal(noUsage.usage, null);
});

test('chatTurn：结构化错误字段——http 错误带 kind/status/serviceCode', async () => {
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { message: 'quota', code: 'insufficient_quota' } }),
        { status: 429 },
      ),
    }),
    (error) => {
      assert.match(error.message, /限流/);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 429);
      assert.equal(error.serviceCode, 'insufficient_quota');
      return true;
    },
  );
});

test('chatTurn：连不上带 kind=network；首字超时带 kind=timeout', async () => {
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    (error) => error.kind === 'network' && /连不上/.test(error.message),
  );
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        // 永不回应的端点：等待外部 abort。
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    }),
    (error) => error.kind === 'timeout' && /首字超时/.test(error.message),
  );
});

test('chatTurn：maxPreStreamRetries=0 时不重试网络错（自动路由的重试预算归备用包装）', async () => {
  let attempts = 0;
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxPreStreamRetries: 0,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      },
    }),
    /连不上/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxPreStreamRetries: 2,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      },
    }),
    /连不上/,
  );
  assert.equal(attempts, 3);
});

test('chatTurn：流中断错误带 outputStarted=true（备用切换的安全边界）', async () => {
  const encoder = new TextEncoder();
  let outputStarted = false;
  await assert.rejects(
    chatTurn({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: () => { outputStarted = true; },
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk('部分输出')));
          // 流先交付分片、再断开（同步 error 会丢弃已排队的分片）。
          setTimeout(() => controller.error(new Error('connection reset')), 10);
        },
      }), { status: 200 }),
    }),
    (error) => {
      assert.equal(error.kind, 'stream');
      assert.equal(error.outputStarted, true);
      assert.ok(outputStarted);
      return true;
    },
  );
});
