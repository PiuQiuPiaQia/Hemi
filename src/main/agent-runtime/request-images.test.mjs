import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestImageProjector, isRequestMediaTooLarge } from './request-images.mjs';
import { testPng } from '../../../scripts/lib/local-image-fixtures.mjs';

test('请求图片预算保留最近图像、文字和来源；原会话不变，省略不能冒充看图', async () => {
  const image = { type: 'image', mimeType: 'image/png', data: testPng().toString('base64') };
  const messages = Array.from({ length: 21 }, (_, i) => ({ role: 'toolResult', toolCallId: `read-${i}`,
    content: [{ type: 'text', text: `frame-${i}.png` }, image], details: { hemiObservationRef: `ctx-${i}` } }));
  const original = structuredClone(messages);
  const project = createRequestImageProjector();
  const { messages: projected, stats } = await project(messages);
  assert.equal(stats.omitted, 13);
  assert.equal(projected.flatMap(m => m.content).filter(b => b.type === 'image').length, 8);
  assert.match(projected[0].content[1].text, /ctx-0.*context_read/);
  assert.match(projected[0].content[1].text, /没有重新看/);
  assert.deepEqual(projected.map(m => m.content[0].text), original.map(m => m.content[0].text));
  assert.deepEqual(messages, original);
  const retry = await project(messages, { mode: 'retry' });
  assert.equal(retry.stats.omitted, 17);
  assert.deepEqual(retry.messages.slice(-4), original.slice(-4));
});

test('大图经真实 SDK worker 压缩编码；原图和坐标说明保留，取消与坏图显式失败', async () => {
  const data = testPng({ width: 640, height: 640, noisy: true }).toString('base64');
  assert.ok(data.length > 512 * 1024);
  const messages = [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data }] }];
  const project = createRequestImageProjector();
  for (const [mode, max] of [['normal', 512 * 1024], ['retry', 128 * 1024]]) {
    const { messages: projected, stats } = await project(messages, { mode });
    assert.equal(stats.resized, 1);
    const image = projected[0].content.find(b => b.type === 'image');
    assert.ok(image.data.length <= max);
    assert.ok(Buffer.from(image.data, 'base64').length > 0);
    assert.match(projected[0].content[0].text, /原图 640×640.*坐标/);
    assert.equal(messages[0].content[0].data, data);
  }
  await assert.rejects(project(messages, { signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(project([{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(600000) }] }]), /无法压缩/);
});

test('请求大小错误识别不把 token 上限或普通网络错误当成媒体超限', () => {
  assert.equal(isRequestMediaTooLarge({ status: 413 }), true);
  assert.equal(isRequestMediaTooLarge({ status: 400, message: 'media_too_large' }), true);
  assert.equal(isRequestMediaTooLarge({ message: '413 Request Entity Too Large' }), true);
  assert.equal(isRequestMediaTooLarge({ status: 504, message: 'Gateway timeout' }), false);
  assert.equal(isRequestMediaTooLarge({ status: 401, message: 'Unauthorized, diagnostic 413' }), false);
  assert.equal(isRequestMediaTooLarge({ message: 'context length exceeded' }), false);
});
