// goal-resume 归约：恢复回合的 run-preparing 守卫、目标投影（snapshot.goal）与增量下发。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlowSnapshot, applyFlowFact, applyFlowChange} from '../../../src/shared/conversation-flow.mjs';
import {createFlowWindowProjector} from '../src/core/flow-window.mjs';

const apply = (state, fact) => {
  const result = applyFlowFact(state, fact);
  assert.equal(result.applied, true, `${fact.type} 应被受理：${result.dropped ?? ''}`);
  return result.snapshot;
};

test('恢复回合 run-preparing：resumeOf 放行 continuationOf，恢复摘要进 goal 投影并标记不可恢复', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  state = apply(state, {type: 'run-preparing', runId: 'res-1', continuationOf: 'source-root', resumeOf: 'source-root',
    resumeGoal: {goalId: 'source-root', objective: '修好构建', phase: 'cancelled', round: 2, status: 'cancelled'},
    source: 'goal-resume', at: 1});
  assert.equal(state.phase, 'preparing');
  assert.equal(state.runs['res-1'].resumeOf, 'source-root');
  assert.deepEqual(state.goal, {goalId: 'source-root', objective: '修好构建', phase: 'cancelled', round: 2, status: 'cancelled', resumable: false});
});

test('恢复回合守卫：continuationOf 与 resumeOf 不一致即拒绝；同源在途恢复只受理一次', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  const mismatched = applyFlowFact(state, {type: 'run-preparing', runId: 'res-1', continuationOf: 'other-root', resumeOf: 'source-root', at: 1});
  assert.equal(mismatched.applied, false);
  assert.equal(mismatched.dropped, 'invalid-resume');
  state = apply(state, {type: 'run-preparing', runId: 'res-1', continuationOf: 'source-root', resumeOf: 'source-root', at: 1});
  const duplicate = applyFlowFact(state, {type: 'run-preparing', runId: 'res-2', continuationOf: 'source-root', resumeOf: 'source-root', at: 2});
  assert.equal(duplicate.applied, false);
  assert.ok(['slot-busy', 'stale-resume'].includes(duplicate.dropped), `重复恢复被拒：${duplicate.dropped}`);
  // 上一恢复已关闭（closedAt 落定）后允许再次恢复同一目标（例如恢复失败后重试）。
  state = apply(state, {type: 'run-closed', runId: 'res-1', outcome: 'failed', at: 3});
  const retried = applyFlowFact(state, {type: 'run-preparing', runId: 'res-2', continuationOf: 'source-root', resumeOf: 'source-root', at: 4});
  assert.equal(retried.applied, true);
});

test('普通回合的 awaiting_user 续接守卫保持不变；无 resumeOf 的 continuationOf 仍只认等待快照', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  const stale = applyFlowFact(state, {type: 'run-preparing', runId: 'run-1', continuationOf: 'waiting-root', at: 1});
  assert.equal(stale.applied, false);
  assert.equal(stale.dropped, 'stale-continuation');
  state = apply(state, {type: 'run-preparing', runId: 'wait-1', at: 1});
  state = apply(state, {type: 'run-closed', runId: 'wait-1', outcome: 'awaiting-user', waitingForUser: {question: '要哪个？', reason: '需要选择'}, at: 2});
  const continued = applyFlowFact(state, {type: 'run-preparing', runId: 'run-2', continuationOf: 'wait-1', at: 3});
  assert.equal(continued.applied, true);
});

test('goal-status 事实：更新目标投影；无变化不递增 revision', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  const unchanged = applyFlowFact(state, {type: 'goal-status', goal: null});
  assert.equal(unchanged.applied, false);
  const first = applyFlowFact(state, {type: 'goal-status', goal: {goalId: 'g1', objective: 'A', phase: 'cancelled', round: 1, status: 'cancelled', resumable: true}});
  assert.equal(first.applied, true);
  assert.equal(first.snapshot.goal.resumable, true);
  const repeat = applyFlowFact(first.snapshot, {type: 'goal-status', goal: {goalId: 'g1', objective: 'A', phase: 'cancelled', round: 1, status: 'cancelled', resumable: true}});
  assert.equal(repeat.applied, false, '相同投影不递增 revision');
  assert.equal(repeat.snapshot.revision, first.snapshot.revision);
});

test('goal 投影经 meta 补丁增量下发（flow-window 认得 goal 字段）', () => {
  let authoritative = createFlowSnapshot({conversationId: 'resume'});
  const project = createFlowWindowProjector(applyFlowChange, () => authoritative);
  let view = project({type: 'reset', snapshot: {detail: {id: 'resume', flow: authoritative}}}).snapshot.detail.flow;
  const goal = {goalId: 'g1', objective: 'A', phase: 'cancelled', round: 1, status: 'cancelled', resumable: true};
  const added = applyFlowFact(authoritative, {type: 'goal-status', goal});
  authoritative = added.snapshot;
  const patch = {kind: 'patch', conversationId: 'resume', generation: 1, baseRevision: authoritative.revision - 1, revision: authoritative.revision, changes: [{kind: 'meta', meta: {goal}}]};
  const frame = project({type: 'flow', id: 'resume', change: patch});
  assert.ok(frame.change.kind === 'patch' || frame.change.kind === 'snapshot');
  const applied = applyFlowChange(view, frame.change);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.snapshot.goal, goal);
});
