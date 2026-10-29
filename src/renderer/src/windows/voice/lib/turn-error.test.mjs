import assert from 'node:assert/strict';
import test from 'node:test';
import { turnErrorCopy } from './turn-error.ts';

test('connection failures have concise copy and retain exact routing diagnostics', () => {
  const raw = '回合未完成：当前模型请求失败，本轮未切换模型（底层报错：Connection error.）';
  const copy = turnErrorCopy(raw);
  assert.equal(copy.title, '连接模型失败');
  assert.equal(copy.detail, raw);
  assert.match(copy.description, /发送“继续”/);
  assert.doesNotMatch(copy.description, /重试/);
  assert.doesNotMatch(copy.description, /HEMI_|底层/);
});

test('provider errors give appropriate recovery guidance without dropping details', () => {
  for (const [raw, title] of [
    ['504 {"title":"Gateway time-out"}', '模型暂时没有响应'],
    ['401 invalid api key', '模型访问未通过验证'],
    ['429 rate limit exceeded', '模型请求过于频繁'],
    ['insufficient quota', '模型额度不足'],
    ['maximum context length exceeded', '对话超出模型上下文限制'],
    ['HTTP 400 invalid request', '模型未接受这次请求'],
    ['未知故障', '这轮未能完成'],
    ['ENOSPC: no space left on device, write', '本机存储空间不足'],
    ['运行状态尚未保存：EACCES permission denied', '运行状态未能保存'],
  ]) {
    assert.equal(turnErrorCopy(raw).title, title);
    assert.equal(turnErrorCopy(raw).detail, raw);
  }
});
