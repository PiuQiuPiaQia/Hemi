import assert from 'node:assert/strict';
import test from 'node:test';
import { insertByCreatedAt, replyCreatedAt } from './transcript-order.ts';

test('派生任务的回合：受理语时间早于任务受理时刻；纯对话回合用回执时刻', () => {
  assert.equal(replyCreatedAt(5_000, null), 5_000);
  assert.equal(replyCreatedAt(5_000, 3_200), 3_199);
  // 回执比受理还早（不该发生）时不往后拨。
  assert.equal(replyCreatedAt(3_000, 3_200), 3_000);
});

test('受理语晚到：插回自己派生的任务卡之前；更早条目与同刻条目不越过', () => {
  const list = [
    { id: 'user', createdAt: 1_000 },
    { id: 'other', createdAt: 3_199 },
    { id: 'task-card', createdAt: 3_200 },
    { id: 'stage', createdAt: 4_000 },
  ];
  const ack = { id: 'ack', createdAt: replyCreatedAt(5_000, 3_200) };
  assert.deepEqual(insertByCreatedAt(list, ack).map((item) => item.id), ['user', 'other', 'ack', 'task-card', 'stage']);
  // 纯对话回复照常落在末尾。
  assert.deepEqual(insertByCreatedAt(list, { id: 'reply', createdAt: 5_000 }).map((item) => item.id).at(-1), 'reply');
  // 不改原数组（setState 用）。
  assert.equal(list.length, 4);
});
