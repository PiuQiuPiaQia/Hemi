import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnResults } from './turn-results.mjs';

test('060：快速执行早于受理 ACK，结果仍可领取；重复请求共享一个结果', async () => {
  const results = createTurnResults();
  results.settle('A', { result: '完成' });
  assert.deepEqual(await results.wait('A'), { result: '完成' });
  const first = results.wait('B'), duplicate = results.wait('B');
  assert.equal(first, duplicate);
  results.settle('B', { error: new Error('真实失败') });
  results.settle('B', { result: '迟到的假成功' });
  assert.equal((await first).error.message, '真实失败');
});

test('060：无结果等待者的队列运行失败可保存，完成缓存有界', async () => {
  const results = createTurnResults({ limit: 2 });
  results.settle('A', { error: new Error('队列失败') });
  results.settle('B', { aborted: true });
  results.settle('C', { result: 'C' });
  assert.equal(results.has('A'), false);
  assert.deepEqual(await results.wait('B'), { aborted: true });
});
