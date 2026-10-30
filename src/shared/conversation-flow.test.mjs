// 057 conversation-flow 纯归约单测（S1）：身份、原位更新、旧回执过滤、补丁协议。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFlowFact,
  applyFlowChange,
  coalesceFlowChanges,
  createFlowSnapshot,
  FLOW_SCHEMA_VERSION,
  PENDING_CAPACITY,
} from './conversation-flow.mjs';

const makeInput = (inputId, text = `消息${inputId}`, extra = {}) => ({
  inputId, editRevision: 0, text, inputSource: 'text', attachmentIds: [], references: null, createdAt: 1, ...extra,
});

test('会话后台列表跨回合保留和更新，不占前台；完成、回卷及旧代次正确处理',()=>{
  let state=createFlowSnapshot({conversationId:'jobs'}),replica=structuredClone(state);
  const apply=fact=>{
    const previous=state,result=applyFlowFact(state,fact);assert.equal(result.applied,true);
    state=result.snapshot;
    replica=applyFlowChange(replica,{kind:'patch',conversationId:'jobs',generation:state.generation,baseRevision:previous.revision,revision:state.revision,changes:[result.patch]}).snapshot;
    assert.deepEqual(replica,state);
  };
  apply({type:'run-preparing',runId:'first'});apply({type:'run-started',runId:'first'});apply({type:'input-delivered',runId:'first',input:makeInput('original')});
  const job={id:'command',runId:'first',generation:1,command:'pnpm dev',status:'running',output:'Ready',startedAt:1,endedAt:null,code:null};
  apply({type:'background-jobs',jobs:[job]});
  apply({type:'run-closed',runId:'first',outcome:'awaiting-background'});
  assert.equal(state.phase,'idle');assert.equal(state.activeRunId,null);assert.equal(state.backgroundJobs.length,1);
  apply({type:'background-jobs',jobs:[{...job,output:'New log'}]});assert.equal(state.phase,'idle');
  assert.equal(applyFlowFact(state,{type:'background-jobs',generation:0,jobs:[]}).applied,false);
  assert.equal(applyFlowFact(state,{type:'background-jobs',jobs:[{...job,generation:2}]}).applied,false);
  assert.equal(applyFlowFact(state,{type:'background-jobs',jobs:[job,job]}).applied,false);
  apply({type:'run-preparing',runId:'next'});apply({type:'run-started',runId:'next'});
  assert.equal(state.backgroundJobs[0].runId,'first');
  apply({type:'run-closed',runId:'next',outcome:'completed'});
  apply({type:'background-jobs',jobs:[]});assert.equal(state.phase,'idle');
  apply({type:'background-jobs',jobs:[job]});apply({type:'generation-bumped',cutAfterInputId:'original'});assert.deepEqual(state.backgroundJobs,[]);
});

test('后台等待属于原运行且保留待发送队列；收口后旧 activity 不能复活状态', () => {
  const setup = prepared();
  const activity = { phase: 'waiting-background', since: 20, jobs: [{ id: 'j', command: 'wait-ci' }], resources: [] };
  const waiting = setup.apply({ type: 'run-activity', runId: 'run-1', generation: 1, activity });
  assert.equal(waiting.applied, true);
  assert.equal(waiting.snapshot.phase, 'running');
  assert.equal(waiting.snapshot.activeRunId, 'run-1');
  assert.deepEqual(waiting.snapshot.runs['run-1'].activity, activity);
  assert.equal(setup.apply({ type: 'run-activity', runId: 'run-1', generation: 0, activity }).applied, false);
  const closed = setup.apply({ type: 'run-closed', runId: 'run-1', at: 30 });
  assert.equal(closed.snapshot.runs['run-1'].activity, null);
  assert.equal(setup.apply({ type: 'run-activity', runId: 'run-1', activity }).applied, false);
});

function prepared() {
  let snapshot = createFlowSnapshot({ conversationId: 'c1' });
  const apply = (fact) => {
    const result = applyFlowFact(snapshot, fact);
    snapshot = result.snapshot;
    return result;
  };
  assert.equal(apply({ type: 'run-preparing', runId: 'run-1', source: 'user', inputIds: ['in-1'], at: 10 }).applied, true);
  assert.equal(apply({ type: 'input-delivered', input: makeInput('in-1', '第一条'), runId: 'run-1', at: 11 }).applied, true);
  assert.equal(apply({ type: 'run-started', runId: 'run-1', at: 12, modelUsed: 'main' }).applied, true);
  return { snapshot, apply };
}

test('model recovery keeps its first-failure anchor through retries, continuation, patches and closure', () => {
  const setup = prepared();
  const initial = setup.apply({type: 'part-appended', runId: 'run-1', afterInputId: 'in-1', part: {partId: 'before', kind: 'text', content: 'Before'}}).snapshot;
  const recovery = {id: 'recovery-1', phase: 'waiting', firstFailureAt: 20, updatedAt: 20};
  const waiting = setup.apply({type: 'run-recovery', runId: 'run-1', afterInputId: 'in-1', recovery});
  const anchor = {itemId: 'run-1:a:in-1', afterPartId: 'before'};
  assert.deepEqual(waiting.snapshot.runs['run-1'].recovery.anchor, anchor);
  assert.deepEqual(applyFlowChange(initial, {kind: 'patch', conversationId: initial.conversationId, generation: initial.generation,
    baseRevision: initial.revision, revision: waiting.snapshot.revision, changes: [waiting.patch]}).snapshot, waiting.snapshot);
  setup.apply({type: 'part-appended', runId: 'run-1', afterInputId: 'in-1', part: {partId: 'after', kind: 'text', content: 'After'}});
  const recovered = setup.apply({type: 'run-recovery', runId: 'run-1', afterInputId: 'in-1', recovery: {...recovery, phase: 'recovered', updatedAt: 30}});
  assert.deepEqual(recovered.snapshot.runs['run-1'].recovery.anchor, anchor);
  const closed = setup.apply({type: 'run-closed', runId: 'run-1', at: 40, outcome: 'completed'});
  assert.deepEqual(closed.snapshot.runs['run-1'].recovery.anchor, anchor);
  assert.deepEqual(JSON.parse(JSON.stringify(closed.snapshot)).runs['run-1'].recovery.anchor, anchor);
});

test('a recovery before first output anchors to the current delivered input', () => {
  const setup = prepared();
  const result = setup.apply({type: 'run-recovery', runId: 'run-1', afterInputId: 'in-1', recovery: {id: 'first', phase: 'waiting'}});
  assert.deepEqual(result.snapshot.runs['run-1'].recovery.anchor, {itemId: 'run-1:a:in-1', afterPartId: null});
});

test('blocked 保留结构化原因、释放运行槽；无原因及停止后的迟到阻塞不能收口',()=>{
 const setup=prepared();
 assert.equal(setup.apply({type:'run-closed',runId:'run-1',outcome:'blocked'}).applied,false);
 const blocked={reason:'已确认外部资源不可用',nextAction:'等待资源恢复'};
 const result=setup.apply({type:'run-closed',runId:'run-1',outcome:'blocked',blocked,at:30});
 assert.equal(result.applied,true);assert.equal(result.snapshot.phase,'idle');assert.equal(result.snapshot.activeRunId,null);
 assert.equal(result.snapshot.runs['run-1'].outcome,'blocked');assert.deepEqual(result.snapshot.runs['run-1'].blocked,blocked);
 blocked.reason='changed';assert.notEqual(result.snapshot.runs['run-1'].blocked.reason,'changed');
 const stopping=prepared();stopping.apply({type:'run-stopping',runId:'run-1',reason:'stop'});
 assert.equal(stopping.apply({type:'run-closed',runId:'run-1',outcome:'blocked',blocked,at:40}).applied,false);
});

test('快照初值：schemaVersion/四态空闲/空集合', () => {
  const snapshot = createFlowSnapshot({ conversationId: 'c0' });
  assert.equal(snapshot.schemaVersion, FLOW_SCHEMA_VERSION);
  assert.equal(snapshot.phase, 'idle');
  assert.equal(snapshot.activeRunId, null);
  assert.equal(snapshot.queuePaused, false);
  assert.deepEqual(snapshot.pending, []);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.generation, 1);
});

test('input-accepted：入队、容量上限、重复身份拒绝', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'run-stopping', runId: 'run-1', reason: 'stop', at: 20 }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'run-closed', runId: 'run-1', outcome: 'stopped', at: 21 }).snapshot;
  for (let i = 2; i <= PENDING_CAPACITY + 1; i += 1) {
    snapshot = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput(`in-${i}`) }).snapshot;
  }
  assert.equal(snapshot.pending.length, PENDING_CAPACITY);
  const overflow = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput(`in-${PENDING_CAPACITY + 2}`) });
  assert.equal(overflow.applied, false);
  assert.equal(overflow.dropped, 'queue-full');
  const dup = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput('in-2') });
  assert.equal(dup.applied, false);
});

test('input-updated：仅 pending 可改，editRevision 前置校验，文本变化才加档', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput('in-x') }).snapshot;
  const ok = applyFlowFact(snapshot, { type: 'input-updated', inputId: 'in-x', patch: { text: '改后' } });
  assert.equal(ok.applied, true);
  assert.equal(ok.snapshot.pending[0].text, '改后');
  assert.equal(ok.snapshot.pending[0].editRevision, 1);
  const stale = applyFlowFact(ok.snapshot, { type: 'input-updated', inputId: 'in-x', expectedEditRevision: 0, patch: { text: '再改' } });
  assert.equal(stale.applied, false);
  assert.equal(stale.dropped, 'stale-input');
  const locked = applyFlowFact(ok.snapshot, { type: 'input-locked', inputId: 'in-x', targetRunId: 'run-1' }).snapshot;
  const rejected = applyFlowFact(locked, { type: 'input-updated', inputId: 'in-x', patch: { text: '锁定中' } });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.dropped, 'locked');
});

test('input-withdrawn：pending 可撤，submitting 锁定（force 兜底）', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput('in-y') }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'input-locked', inputId: 'in-y', targetRunId: 'run-1' }).snapshot;
  const locked = applyFlowFact(snapshot, { type: 'input-withdrawn', inputId: 'in-y' });
  assert.equal(locked.applied, false);
  assert.equal(locked.dropped, 'locked');
  const forced = applyFlowFact(snapshot, { type: 'input-withdrawn', inputId: 'in-y', force: true });
  assert.equal(forced.applied, true);
  assert.equal(forced.snapshot.pending.length, 0);
});

test('input-delivered：出队转正、重复投递幂等、外 run 拒绝', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput('in-m', '并入这条') }).snapshot;
  const delivered = applyFlowFact(snapshot, { type: 'input-delivered', input: makeInput('in-m', '并入这条'), runId: 'run-1', at: 30 });
  assert.equal(delivered.applied, true);
  const userItems = delivered.snapshot.timeline.filter((entry) => entry.kind === 'user');
  assert.equal(userItems.length, 2);
  assert.equal(userItems[1].id, 'in-m');
  assert.equal(userItems[1].deliveredAt, 30);
  assert.equal(delivered.snapshot.pending.length, 0);
  assert.deepEqual(delivered.snapshot.runs['run-1'].inputIds, ['in-1', 'in-m']);
  const again = applyFlowFact(delivered.snapshot, { type: 'input-delivered', input: makeInput('in-m', '并入这条'), runId: 'run-1', at: 31 });
  assert.equal(again.applied, false);
  assert.equal(again.dropped, 'duplicate-delivery');
  const foreign = applyFlowFact(delivered.snapshot, { type: 'input-delivered', input: makeInput('in-z'), runId: 'run-other' });
  assert.equal(foreign.applied, false);
  assert.equal(foreign.dropped, 'stale-run');
});

test('运行生命周期：单槽、settled 不改相位、closed 回空闲带终态', () => {
  let { snapshot } = prepared();
  assert.equal(snapshot.phase, 'running');
  const busy = applyFlowFact(snapshot, { type: 'run-preparing', runId: 'run-2' });
  assert.equal(busy.applied, false);
  assert.equal(busy.dropped, 'slot-busy');
  const settled = applyFlowFact(snapshot, { type: 'run-settled', runId: 'run-1', at: 40 });
  assert.equal(settled.applied, true);
  assert.equal(settled.snapshot.phase, 'running');
  const stopping = applyFlowFact(settled.snapshot, { type: 'run-stopping', runId: 'run-1', reason: 'stop', at: 41 });
  assert.equal(stopping.snapshot.phase, 'stopping');
  assert.equal(stopping.snapshot.queuePaused, true);
  const preemptStop = applyFlowFact(settled.snapshot, { type: 'run-stopping', runId: 'run-1', reason: 'preempt', at: 41 });
  assert.equal(preemptStop.snapshot.queuePaused, false, 'preempt 不暂停队列');
  const closed = applyFlowFact(stopping.snapshot, { type: 'run-closed', runId: 'run-1', outcome: 'stopped', at: 42 });
  assert.equal(closed.snapshot.phase, 'idle');
  assert.equal(closed.snapshot.activeRunId, null);
  assert.equal(closed.snapshot.runs['run-1'].outcome, 'stopped');
  const foreignClose = applyFlowFact(closed.snapshot, { type: 'run-closed', runId: 'run-1', outcome: 'completed', at: 43 });
  assert.equal(foreignClose.applied, false, '旧运行的关闭回执不能复活/改写终态');
});

test('part 追加与更新：首段建助手段、原位更新、同值不空转、外 run/重复 partId 丢弃', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', part: { partId: 'p1', kind: 'text', content: '开头' } }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', part: { partId: 'p2', kind: 'tool', toolCallId: 'tc1', status: 'running' } }).snapshot;
  const assistantItems = snapshot.timeline.filter((entry) => entry.kind === 'assistant');
  assert.equal(assistantItems.length, 1);
  assert.deepEqual(assistantItems[0].parts.map((p) => p.partId), ['p1', 'p2']);
  const dup = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', part: { partId: 'p1', kind: 'text', content: '重复' } });
  assert.equal(dup.applied, false);
  const foreign = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-x', part: { partId: 'p3', kind: 'text', content: '' } });
  assert.equal(foreign.applied, false);
  const revisionBefore = snapshot.revision;
  const noOp = applyFlowFact(snapshot, { type: 'part-updated', runId: 'run-1', partId: 'p1', patch: { content: '开头' } });
  assert.equal(noOp.applied, false);
  const updated = applyFlowFact(snapshot, { type: 'part-updated', runId: 'run-1', partId: 'p1', patch: { content: '开头接中段' } });
  assert.equal(updated.applied, true);
  assert.equal(updated.snapshot.revision, revisionBefore + 1);
  const item = updated.snapshot.timeline.filter((e) => e.kind === 'assistant')[0];
  assert.equal(item.parts[0].content, '开头接中段');
  // 并入后的输出段：afterInputId 不同则新开助手段，且不挪旧段位置。
  const seg = applyFlowFact(updated.snapshot, { type: 'part-appended', runId: 'run-1', afterInputId: 'in-m', part: { partId: 'p3', kind: 'text', content: '补充后的输出' } });
  assert.equal(seg.snapshot.timeline.filter((e) => e.kind === 'assistant').length, 2);
});

test('AC-01 子任务反序完成：后发快照先到，时间线顺序与身份不变', () => {
  let { snapshot } = prepared();
  // 同一助手段里两个 delegation part（先派 tc-a 再派 tc-b）。
  snapshot = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', afterInputId: 'in-1', part: { partId: 'run-1:d1', kind: 'delegation', tool: 'task', toolCallId: 'tc-a', taskId: 'task-a', status: 'running' } }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', afterInputId: 'in-1', part: { partId: 'run-1:d2', kind: 'delegation', tool: 'task', toolCallId: 'tc-b', taskId: 'task-b', status: 'running' } }).snapshot;
  const before = snapshot.timeline.find((entry) => entry.kind === 'assistant');
  // 后发的 task-b 先完成（反序），再补 task-a。
  snapshot = applyFlowFact(snapshot, { type: 'task-updated', task: { taskId: 'task-b', agent: 'explorer', outcome: 'complete', phase: 'terminal', toolCallId: 'tc-b', taskText: '后发任务' } }).snapshot;
  const midIds = snapshot.timeline.map((entry) => entry.kind === 'user' ? entry.id : entry.itemId);
  const midParts = snapshot.timeline.find((entry) => entry.kind === 'assistant').parts.map((part) => part.partId);
  assert.deepEqual(midParts, before.parts.map((part) => part.partId), 'b 先完成不移动 part 顺序');
  assert.equal(snapshot.tasks['task-b'].outcome, 'complete');
  assert.equal(snapshot.tasks['task-a'], undefined, 'a 未到不虚构');
  snapshot = applyFlowFact(snapshot, { type: 'task-updated', task: { taskId: 'task-a', agent: 'fixer', outcome: 'complete', phase: 'terminal', toolCallId: 'tc-a', taskText: '先发任务' } }).snapshot;
  const finalEntry = snapshot.timeline.find((entry) => entry.kind === 'assistant');
  assert.deepEqual(finalEntry.parts.map((part) => part.partId), before.parts.map((part) => part.partId), '两任务齐后顺序仍不变');
  assert.deepEqual(snapshot.timeline.map((entry) => entry.kind === 'user' ? entry.id : entry.itemId), midIds, '时间线条目身份与顺序全程稳定');
  assert.equal(snapshot.tasks['task-a'].toolCallId, 'tc-a');
  assert.equal(snapshot.tasks['task-b'].toolCallId, 'tc-b');
});

test('旧 generation 回执全丢弃', () => {
  let { snapshot } = prepared();
  const stale = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', generation: 1, part: { partId: 'pg', kind: 'text', content: '旧代' } });
  // 当前 generation=1 时 generation:1 会被应用（事实本身是当前代）；先 bump 再试旧代。
  const bumped = applyFlowFact(snapshot, { type: 'input-delivered', input: makeInput('in-r', '回卷目标'), runId: 'run-1', at: 50 });
  const cut = applyFlowFact(bumped.snapshot, { type: 'generation-bumped', cutAfterInputId: 'in-r' });
  assert.equal(cut.applied, true);
  assert.equal(cut.snapshot.generation, 2);
  assert.ok(!cut.snapshot.timeline.some((e) => e.kind === 'user' && e.id === 'in-r'), '回卷目标及之后被裁剪');
  assert.equal(stale.applied, true); // generation:1 当时仍是当前代——正常应用
  const oldGen = applyFlowFact(cut.snapshot, { type: 'part-appended', runId: 'run-1', generation: 1, part: { partId: 'pg2', kind: 'text', content: '旧代残留' } });
  assert.equal(oldGen.applied, false);
  assert.equal(oldGen.dropped, 'stale-generation');
});

test('generation-bumped：裁剪含目标项及其后全部，pending 保留', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput('in-keep') }).snapshot;
  const cut = applyFlowFact(snapshot, { type: 'generation-bumped', cutAfterInputId: 'in-1' });
  assert.equal(cut.snapshot.timeline.length, 0);
  assert.equal(cut.snapshot.pending.length, 1, '有效队列不因回卷丢失');
  const missing = applyFlowFact(snapshot, { type: 'generation-bumped', cutAfterInputId: 'nope' });
  assert.equal(missing.applied, false);
});

test('编辑回卷也移除被撤回工具所属的任务摘要、产物和待通知报告', () => {
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'part-appended', runId: 'run-1', part: { partId: 'p-task', kind: 'delegation', toolCallId: 'call-removed', tool: 'task' } }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'task-updated', task: { taskId: 'task-removed', toolCallId: 'call-removed', phase: 'terminal', taskText: '撤回的任务' } }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'task-updated', task: { taskId: 'task-kept', toolCallId: 'call-kept', phase: 'terminal', taskText: '保留的任务' } }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'report-queued', report: { taskId: 'task-removed', resultVersion: 1 } }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'artifact-updated', artifact: { artifactId: 'a-removed', taskId: 'task-removed' } }).snapshot;
  const cut = applyFlowFact(snapshot, { type: 'generation-bumped', cutAfterInputId: 'in-1' });
  assert.equal(cut.snapshot.tasks['task-removed'], undefined);
  assert.ok(cut.snapshot.tasks['task-kept']);
  assert.deepEqual(cut.snapshot.pendingReports, []);
  assert.deepEqual(cut.snapshot.artifacts, {});
});

test('报告去重：同 taskId+resultVersion 只排一次', () => {
  let { snapshot } = prepared();
  const report = { taskId: 't1', runs: 1, resultVersion: 3 };
  snapshot = applyFlowFact(snapshot, { type: 'report-queued', report }).snapshot;
  const dup = applyFlowFact(snapshot, { type: 'report-queued', report });
  assert.equal(dup.applied, false);
  const consumed = applyFlowFact(snapshot, { type: 'report-consumed', taskId: 't1', resultVersion: 3 });
  assert.equal(consumed.applied, true);
  assert.equal(consumed.snapshot.pendingReports.length, 0);
  const again = applyFlowFact(consumed.snapshot, { type: 'report-consumed', taskId: 't1', resultVersion: 3 });
  assert.equal(again.applied, false);
});

test('补丁协议：变更链回放＝最终快照；版本缺口/代次不符返回 stale', () => {
  const changes = [];
  const { snapshot: baseline, apply: original } = prepared();
  const apply = (fact) => {
    const result = original(fact);
    if (result.applied) {
      changes.push({
        kind: 'patch', conversationId: 'c1', generation: result.snapshot.generation,
        baseRevision: result.snapshot.revision - 1, revision: result.snapshot.revision,
        changes: result.patch.kind === 'multi' ? result.patch.changes : [result.patch],
      });
    }
    return result;
  };
  apply({ type: 'input-accepted', input: makeInput('in-k') });
  apply({ type: 'part-appended', runId: 'run-1', part: { partId: 'p1', kind: 'text', content: '流式' } });
  apply({ type: 'part-updated', runId: 'run-1', partId: 'p1', patch: { content: '流式到结尾' } });
  apply({ type: 'run-stopping', runId: 'run-1', reason: 'stop', at: 60 });
  const last = apply({ type: 'run-closed', runId: 'run-1', outcome: 'stopped', at: 61 });
  const latest = last.snapshot;
  // 从订阅时基线（prepared 后的快照）回放全部补丁——订阅方「先监听再取快照」后到达的增量。
  let client = baseline;
  for (const change of changes) {
    const result = applyFlowChange(client, change);
    assert.equal(result.ok, true, `revision ${change.baseRevision}→${change.revision}`);
    client = result.snapshot;
  }
  assert.deepEqual(client, latest);
  // 版本缺口：跳过一条再应用 → stale（订阅方须重取快照）。
  const gapped = applyFlowChange(client, changes[0]);
  assert.equal(gapped.ok, false);
  assert.equal(gapped.code, 'stale');
  // 代次不符：旧 generation 补丁丢弃。
  const oldGen = applyFlowChange(
    { ...client, generation: 2 },
    { ...changes[changes.length - 1], generation: 1 },
  );
  assert.equal(oldGen.ok, false);
  // snapshot 变更直接整体替换。
  const snap = applyFlowChange(client, { kind: 'snapshot', snapshot: latest });
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.snapshot, latest);
});

test('补丁合并：同条目连续 item-updated 只留最终值', () => {
  const mk = (baseRevision, revision, itemId, content) => ({
    kind: 'patch', conversationId: 'c1', generation: 1, baseRevision, revision,
    changes: [{ kind: 'item-updated', item: { itemId, kind: 'assistant', runId: 'r', afterInputId: null, parts: [{ partId: 'p', kind: 'text', content }] } }],
  });
  const first = coalesceFlowChanges(null, mk(0, 1, 'a1', '一'));
  const second = coalesceFlowChanges(first, mk(1, 2, 'a1', '一二'));
  const third = coalesceFlowChanges(second, mk(2, 3, 'a1', '一二三'));
  assert.equal(third.revision, 3);
  assert.equal(third.changes.length, 1);
  assert.equal(third.changes[0].item.parts[0].content, '一二三');
  const discontinuous = coalesceFlowChanges(first, mk(5, 6, 'a1', '不连续'));
  assert.equal(discontinuous.baseRevision, 5, '不连续不合批，原样透传');
});

// ---- 063：显式技能选择随 input/用户项贯穿 ----

test('063：input-updated 接受 skills 键；input-delivered 用户项冻结 skills 与 references', () => {
  const skills = [{ token: 'pdf', name: 'pdf', source: 'library', skillId: 'lib:pdf' }];
  let { snapshot } = prepared();
  snapshot = applyFlowFact(snapshot, { type: 'run-stopping', runId: 'run-1', reason: 'stop', at: 20 }).snapshot;
  snapshot = applyFlowFact(snapshot, { type: 'run-closed', runId: 'run-1', outcome: 'stopped', at: 21 }).snapshot;
  const accepted = applyFlowFact(snapshot, { type: 'input-accepted', input: makeInput('in-s', '用 pdf 整理', { skills }) });
  snapshot = accepted.snapshot;
  assert.deepEqual(snapshot.pending[0].skills, skills);
  const updated = applyFlowFact(snapshot, { type: 'input-updated', inputId: 'in-s', patch: { skills: [] } });
  assert.equal(updated.applied, true);
  assert.deepEqual(updated.snapshot.pending[0].skills, [], 'skills 是白名单键，可整组替换');
  // 投递：用户项冻结技能与引用（正文 token 与身份同批进时间线）。
  const references = [{ kind: 'file', key: 'file:a.md', name: 'a.md', subtitle: '文件 · a.md', refPath: 'a.md' }];
  const preparing = applyFlowFact(updated.snapshot, { type: 'run-preparing', runId: 'run-2', source: 'user', inputIds: ['in-s'], at: 30 });
  const delivered = applyFlowFact(preparing.snapshot, {
    type: 'input-updated', inputId: 'in-s', patch: { skills, references },
  });
  const delivered2 = applyFlowFact(delivered.snapshot, { type: 'input-delivered', input: { ...makeInput('in-s', '用 pdf 整理'), skills, references }, runId: 'run-2', at: 31 });
  assert.equal(delivered2.applied, true);
  const userItem = delivered2.snapshot.timeline.find((item) => item.kind === 'user' && item.id === 'in-s');
  assert.deepEqual(userItem.skills, skills);
  assert.deepEqual(userItem.references, references);
});

test('回卷补丁可被客户端增量应用（编辑重发不再带旧 generation）', () => {
  const setup = prepared();
  const before = setup.apply({ type: 'run-closed', runId: 'run-1', outcome: 'done', at: 20 }).snapshot;
  const cut = applyFlowFact(before, { type: 'generation-bumped', cutAfterInputId: 'in-1' });
  const change = { kind: 'patch', conversationId: 'c1', generation: cut.snapshot.generation, baseRevision: before.revision,
    revision: cut.snapshot.revision, changes: cut.patch.kind === 'multi' ? cut.patch.changes : [cut.patch] };
  const applied = applyFlowChange(before, change);
  assert.equal(applied.ok, true);
  assert.equal(applied.snapshot.generation, before.generation + 1);
  assert.deepEqual(applied.snapshot, cut.snapshot);
  // 跨代且未声明新 generation 的补丁仍判 stale。
  assert.equal(applyFlowChange(before, { ...change, changes: [{ kind: 'timeline', timeline: [] }] }).code, 'stale');
  assert.equal(applyFlowChange(before, { ...change, generation: before.generation + 2 }).code, 'stale');
});
