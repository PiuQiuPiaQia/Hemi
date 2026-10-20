import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationTurns } from './conversation-turns.mjs';

test('不同会话同编号并行；停止必须命中会话与请求，旧回调不能释放新请求', async () => {
  const turns = createConversationTurns();
  const a = turns.begin({ conversationId: 'a', turnId: 1, requestId: 'a1' });
  const b = turns.begin({ conversationId: 'b', turnId: 1, requestId: 'b1' });
  assert.equal(a.controller.signal.aborted, false);
  assert.equal(turns.cancel({ conversationId: 'a', turnId: 1, requestId: 'b1' }), false);
  assert.equal(turns.cancel({ conversationId: 'a', turnId: 1, requestId: 'a1' }), true);
  assert.equal(b.controller.signal.aborted, false);
  const a2 = turns.begin({ conversationId: 'a', turnId: 2 });
  turns.settle(a, { error: new Error('迟到') });
  assert.equal(turns.current(a2), true);
  assert.equal(turns.update(a, { kind: 'text', text: '迟到' }), false);
  turns.abortAll();
});

test('同会话受理即让位（含准备阶段）；已取消的准备请求不再启动模型', async () => {
  const turns = createConversationTurns();
  const old = turns.begin({ conversationId: 'a', turnId: 1 });
  const next = turns.begin({ conversationId: 'a', turnId: 2 });
  assert.equal(old.controller.signal.aborted, true);
  await assert.rejects(turns.run(() => assert.fail('不能执行'), { token: old }), /已取消/);
  assert.equal(turns.current(next), true);
  turns.abortAll();
});

test('回炉只等所属会话；另一会话的回炉不阻塞，释放后不抢新用户回合', async () => {
  const turns = createConversationTurns();
  const a = turns.begin({ conversationId: 'a', turnId: 1 });
  let ran = false;
  const waiting = turns.run(() => { ran = true; }, { conversationId: 'a', preempt: false });
  await turns.run(() => {}, { conversationId: 'b', preempt: false });
  assert.equal(ran, false);
  turns.settle(a, { result: { text: '完成' } });
  const next = turns.begin({ conversationId: 'a', turnId: 2 });
  await Promise.resolve();
  assert.equal(ran, false);
  turns.settle(next, { result: { text: '用户回合优先' } });
  await waiting;
  assert.equal(ran, true);
});

test('重接恢复正文/思考快照；完成结果可在导航竞态后读取；读取不能改宿主状态', () => {
  const seen = [];
  let time = 1;
  const turns = createConversationTurns({ onState: (s) => seen.push(s), now: () => time++ });
  const a = turns.begin({ conversationId: 'a', turnId: 1 });
  turns.update(a, { kind: 'thinking_start' });
  turns.update(a, { kind: 'thinking', text: '核对依据' });
  turns.update(a, { kind: 'text', text: '正文' });
  const snapshot = turns.getState('a');
  assert.equal(snapshot.thinking.text, '核对依据');
  assert.ok(snapshot.thinking.endedAt);
  snapshot.text = '篡改';
  assert.equal(turns.getState('a').text, '正文');
  turns.update(a, { kind: 'thinking_start' });
  turns.update(a, { kind: 'thinking', text: '第二轮' });
  assert.equal(turns.getState('a').thinking.text, '核对依据\n\n第二轮');
  turns.update(a, { kind: 'restart' });
  assert.equal(turns.getState('a').thinking, null);
  assert.equal(turns.getState('a').text, '');
  turns.settle(a, { result: { responseId: 'reply-a', text: '完整正文' } });
  assert.equal(turns.getState('a').result.responseId, 'reply-a');
  assert.equal(turns.isActive('a'), false);
  assert.deepEqual(seen.map((s) => s.status), ['running', 'complete']);
});

test('退出取消在途回合，并拒绝被唤醒的待回炉请求', async () => {
  const turns = createConversationTurns();
  const a = turns.begin({ conversationId: 'a', turnId: 1 });
  const waiting = turns.run(() => assert.fail('退出后不能启动模型'), { conversationId: 'a', preempt: false });
  turns.abortAll();
  await assert.rejects(waiting, /已取消/);
  assert.equal(a.controller.signal.aborted, true);
  assert.equal(turns.isActive('a'), false);
  assert.equal(turns.getState('a').status, 'cancelled');
  assert.throws(() => turns.begin({ conversationId: 'a', turnId: 2 }), /已取消/);
});
