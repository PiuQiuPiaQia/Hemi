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

test('新独立回合受理即清旧恢复投影：普通 run-preparing 把 resumable 目标清空', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  state = apply(state, {type: 'goal-status', goal: {goalId: 'old-chain', objective: '旧目标', phase: 'cancelled', round: 2, status: 'cancelled', resumable: true}});
  assert.equal(state.goal.resumable, true);
  // 普通新回合（无 resumeOf/continuationOf）：受理瞬间清掉旧「继续任务」条。
  state = apply(state, {type: 'run-preparing', runId: 'run-9', rootRunId: 'run-9', source: 'user', at: 10});
  assert.equal(state.phase, 'preparing');
  assert.equal(state.goal, null);
  // 运行中与收口后都不再恢复旧投影。
  state = apply(state, {type: 'run-started', runId: 'run-9', at: 11});
  assert.equal(state.goal, null);
  state = apply(state, {type: 'run-closed', runId: 'run-9', outcome: 'completed', at: 12});
  assert.equal(state.goal, null);
});

test('同链回合不清投影：后台接续与 awaiting_user 续答保持既有目标', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  const chainGoal = {goalId: 'g1', objective: '进行中目标', phase: 'active', round: 1, status: 'running', resumable: false};
  state = apply(state, {type: 'goal-status', goal: chainGoal});
  // 复用原 root 的后台接续回合（rootRunId≠runId）不视为新独立链，不清投影。
  state = apply(state, {type: 'run-preparing', runId: 'bg-1', rootRunId: 'g1', source: 'event', at: 10});
  assert.deepEqual(state.goal, chainGoal, '后台接续沿用原 root，不清投影');
  state = apply(state, {type: 'run-closed', runId: 'bg-1', outcome: 'awaiting-background', at: 11});
  // awaiting_user 等待回合本身是新受理（清投影），续答回合 continuationOf 同链不清。
  state = apply(state, {type: 'run-preparing', runId: 'wait-1', rootRunId: 'wait-1', source: 'user', at: 12});
  assert.equal(state.goal, null);
  state = apply(state, {type: 'run-closed', runId: 'wait-1', outcome: 'awaiting-user', waitingForUser: {question: '要哪个？', reason: '需要选择'}, at: 13});
  state = apply(state, {type: 'goal-status', goal: chainGoal});
  state = apply(state, {type: 'run-preparing', runId: 'cont-1', rootRunId: 'cont-1', continuationOf: 'wait-1', source: 'user', at: 14});
  assert.deepEqual(state.goal, chainGoal, '同链续答不清投影');
});

test('运行中不受理迟到的 goal-status：run-preparing 清掉的恢复条不能被异步重投影复活', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  const stale = {goalId: 'old-chain', objective: '旧目标', phase: 'cancelled', round: 2, status: 'cancelled', resumable: true};
  state = apply(state, {type: 'goal-status', goal: stale});
  state = apply(state, {type: 'run-preparing', runId: 'run-9', rootRunId: 'run-9', source: 'user', at: 10});
  assert.equal(state.goal, null);
  // 上一回合收口后异步读账本再追加的迟到投影：preparing/running 中一律丢弃。
  state = apply(state, {type: 'run-started', runId: 'run-9', at: 11});
  const late = applyFlowFact(state, {type: 'goal-status', goal: stale});
  assert.equal(late.applied, false);
  assert.equal(late.dropped, 'goal-status-busy');
  assert.equal(late.snapshot.goal, null);
  // 收口回 idle 后，同一投影事实才被受理（宿主重投影纠正最终状态）。
  state = apply(state, {type: 'run-closed', runId: 'run-9', outcome: 'completed', at: 12});
  state = apply(state, {type: 'goal-status', goal: stale});
  assert.equal(state.goal, stale);
});

test('迟到 goal-status 在运行中被丢弃但不改变 revision；无效事实仍按原口径拒绝', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  state = apply(state, {type: 'run-preparing', runId: 'run-9', rootRunId: 'run-9', source: 'user', at: 10});
  const revisionBefore = state.revision;
  const busy = applyFlowFact(state, {type: 'goal-status', goal: {goalId: 'x', objective: '迟到', phase: 'cancelled', round: 1, status: 'cancelled', resumable: true}});
  assert.equal(busy.applied, false);
  assert.equal(busy.dropped, 'goal-status-busy');
  assert.equal(busy.snapshot.revision, revisionBefore);
  const invalid = applyFlowFact(state, {type: 'goal-status'});
  assert.equal(invalid.dropped, 'invalid-goal-status');
});

test('跨代 goal-status 被归约层丢弃，不复活旧目标投影', () => {
  const state = createFlowSnapshot({conversationId: 'resume'});
  const stale = applyFlowFact(state, {
    type: 'goal-status', generation: state.generation + 1,
    goal: {goalId: 'old-generation', objective: '旧目标', phase: 'cancelled', round: 1, status: 'cancelled', resumable: true},
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.dropped, 'stale-generation');
  assert.equal(stale.snapshot.revision, state.revision);
  assert.equal(stale.snapshot.goal, null);
});

test('事件唤醒回合不构成新链受理：不清目标投影（子代理结果播报等）', () => {
  let state = createFlowSnapshot({conversationId: 'resume'});
  const chip = {goalId: 'g1', objective: '停止的目标', phase: 'cancelled', round: 2, status: 'cancelled', resumable: true};
  state = apply(state, {type: 'goal-status', goal: chip});
  state = apply(state, {type: 'run-preparing', runId: 'event-run-1', source: 'event', at: 10});
  assert.deepEqual(state.goal, chip, '事件播报不清恢复条');
  state = apply(state, {type: 'run-started', runId: 'event-run-1', at: 11});
  state = apply(state, {type: 'run-closed', runId: 'event-run-1', outcome: 'completed', at: 12});
  assert.deepEqual(state.goal, chip, '收口后仍等待宿主重投影，不因事件回合丢条');
});
