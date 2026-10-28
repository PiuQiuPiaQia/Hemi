import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationStatus, withConversationUnread } from './conversation-status.mjs';

test('后台等待和资源排队显示等待，执行恢复后回到运行；离线档案不冒充等待', () => {
  const flow = { phase: 'running', activeRunId: 'r', tasks: {}, runs: {} };
  for (const phase of ['waiting-background', 'waiting-resource']) {
    const waiting = { ...flow, runs: { r: { activity: { phase } } } };
    assert.equal(conversationStatus(waiting, { live: true }), 'waiting');
    assert.equal(conversationStatus(waiting), null);
    assert.equal(conversationStatus({ ...waiting, phase: 'stopping' }, { live: true }), 'running');
  }
  assert.equal(conversationStatus({ ...flow, runs: { r: { activity: { phase: 'running' } } } }, { live: true }), 'running');
});

test('列表只显示真实主运行和后台任务；确认及停止屏障仍属于运行', () => {
  const flow = { phase: 'running', tasks: {}, pending: [], runs: {} };
  const status = patch => conversationStatus({ ...flow, ...patch }, { live: true });
  assert.equal(status({}), 'running');
  assert.equal(status({ phase: 'preparing' }), 'running');
  assert.equal(status({ phase: 'stopping', tasks: { child: { phase: 'executing', permission: {} } } }), 'running');
  assert.equal(status({ tasks: { child: { phase: 'executing', permission: {} } } }), 'running');
  assert.equal(status({ phase: 'idle', tasks: { child: { phase: 'executing' } } }), 'running');
  assert.equal(status({ phase: 'idle', tasks: { child: { phase: 'terminal', permission: {} } } }), null);
  assert.equal(status({ phase: 'idle', pending: [{ state: 'pending' }] }), null);
  assert.equal(status({ phase: 'idle', pending: [{ state: 'needs-review' }] }), null);
});

test('收口、失败、停止、中断都不显示终态图标', () => {
  for (const outcome of ['completed', 'failed', 'blocked', 'stopped', 'interrupted']) {
    assert.equal(conversationStatus({ phase: 'idle', runs: { newest: { startedAt: 20, outcome } } }, { live: true }), null);
  }
  assert.equal(conversationStatus(null), null);
  assert.equal(conversationStatus({}), null);
  assert.equal(conversationStatus({ tasks: { bad: null }, runs: { bad: null }, pending: 'bad' }, { live: true }), null);
});

test('重启读取档案不把旧运行和后台任务显示为仍在执行', () => {
  assert.equal(conversationStatus({ phase: 'running' }), null);
  assert.equal(conversationStatus({ phase: 'idle', tasks: { child: { phase: 'executing' } }, runs: { main: { outcome: 'completed' } } }), null);
});

test('仅新的成功／失败结果产生持久未读，旧档和重复保存不误报', () => {
  for (const source of ['user', 'queue', 'event']) {
    for (const outcome of ['completed', 'failed', 'blocked']) {
      const run = { runId: 'r1', source, outcome, closedAt: 10 };
      const flow = { runs: { r1: run } };
      const next = withConversationUnread({ flow: { runs: {} } }, flow, 100);
      assert.equal(next.unreadAt, 100);
      assert.equal(withConversationUnread(next, flow, 200).unreadAt, 100, '重复保存不再通知');
    }
  }
  for (const run of [
    { source: 'user', outcome: 'stopped', closedAt: 10 },
    { source: 'user', outcome: 'interrupted', closedAt: 10 },
    { source: 'preparation', outcome: 'completed', closedAt: 10 },
    { outcome: 'completed', closedAt: 10 },
    { source: 'user', outcome: 'completed', closedAt: null },
  ]) assert.equal(withConversationUnread({}, { runs: { r1: { runId: 'r1', ...run } } }).unreadAt, undefined);
  const flow = { runs: { r2: { runId: 'r2', source: 'user', outcome: 'completed', closedAt: 10 } } };
  assert.equal(withConversationUnread({ unreadAt: null, lastReadAt: 100 }, flow, 100).unreadAt, 101, '同毫秒新结果不复用旧清读身份');
});


test('等待用户需要新结果提醒，重读旧快照不会重复提醒',()=>{
 const flow={phase:'idle',awaitingUser:{runId:'r'},runs:{r:{runId:'r',source:'user',outcome:'awaiting-user',closedAt:10}},tasks:{}};
 assert.equal(conversationStatus(flow,{live:true}),'waiting');
 const record=withConversationUnread({flow:{runs:{}}},flow,20);assert.equal(record.unreadAt,20);
 assert.equal(withConversationUnread(record,flow,30).unreadAt,20);
});
