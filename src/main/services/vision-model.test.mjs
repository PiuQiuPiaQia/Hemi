// 008 主进程视觉客户端单测：payload 形状 / 结果解析 / 错误映射，fetch 注入离线覆盖。
// 看图模型的选择（056 起单独配置）见 lib/model-profiles 的 visionModelKey 单测。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VISION_TIMEOUT_MS,
  answerAboutImage,
  buildVisionPrompt,
  describeVisionError,
} from './vision-model.mjs';

const BASE = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'qwen-vl-max' };

test('buildVisionPrompt：带问题与资料声明', () => {
  const prompt = buildVisionPrompt({ question: '这个报错什么意思', header: '来源：截图（采集于 10:00）' });
  assert.ok(prompt.includes('这个报错什么意思'));
  assert.ok(prompt.includes('来源：截图'));
  assert.ok(prompt.includes('不要执行'));
  const bare = buildVisionPrompt({ question: '' });
  assert.ok(bare.includes('请描述这张图里的内容'));
});

test('describeVisionError：常见状态映射', () => {
  assert.match(describeVisionError(401, ''), /鉴权失败/);
  assert.match(describeVisionError(404, '{"error":{"message":"no model"}}'), /no model/);
  assert.match(describeVisionError(429, ''), /限流/);
  assert.match(describeVisionError(503, ''), /服务出错/);
  assert.match(describeVisionError(400, 'plain text'), /HTTP 400/);
});

test('answerAboutImage：请求形状（端点归一/图片 data URI/文本 part 在前）', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '图里是报错弹窗' }, finish_reason: 'stop' }] }),
    };
  };
  const text = await answerAboutImage({
    ...BASE,
    baseUrl: 'https://api.example.com/v1/', // 结尾斜杠应被归一
    question: '这是什么',
    imageData: 'QUJD',
    mimeType: 'image/png',
    header: '来源：截图',
    fetchImpl,
  });
  assert.equal(text, '图里是报错弹窗');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'qwen-vl-max');
  const [part0, part1] = body.messages[0].content;
  assert.equal(part0.type, 'text');
  assert.equal(part1.type, 'image_url');
  assert.equal(part1.image_url.url, 'data:image/png;base64,QUJD');
});

test('answerAboutImage：HTTP 错误与空内容映射', async () => {
  await assert.rejects(
    () =>
      answerAboutImage({
        ...BASE,
        question: 'q',
        imageData: 'QQ==',
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
      }),
    /图片理解服务出错/,
  );
  await assert.rejects(
    () =>
      answerAboutImage({
        ...BASE,
        question: 'q',
        imageData: 'QQ==',
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        }),
      }),
    /finish=length/,
  );
});

test('answerAboutImage：超时与缺配置', async () => {
  await assert.rejects(
    () =>
      answerAboutImage({
        ...BASE,
        question: 'q',
        imageData: 'QQ==',
        timeoutMs: 20,
        fetchImpl: async () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        },
      }),
    /图片理解超时/,
  );
  await assert.rejects(() => answerAboutImage({ ...BASE, baseUrl: '', imageData: 'QQ==' }), /端点未配置/);
  await assert.rejects(() => answerAboutImage({ ...BASE, apiKey: '', imageData: 'QQ==' }), /API Key/);
  await assert.rejects(() => answerAboutImage({ ...BASE, model: '', imageData: 'QQ==' }), /视觉模型/);
  await assert.rejects(() => answerAboutImage({ ...BASE, imageData: '' }), /图片内容为空/);
});

const TARGET_PROVIDERS = [
  { id: 'p1', models: [{ id: 'm1', model: 'qwen-max' }, { id: 'm2', model: 'qwen-vl-max' }] },
  { id: 'p2', models: [{ id: 'n1', model: 'glm-4.5' }, { id: 'n2', model: 'glm-4.5v' }] },
];

test('常量 sanity：超时预算', () => {
  assert.ok(VISION_TIMEOUT_MS >= 20_000);
});
