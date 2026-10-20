import assert from 'node:assert/strict';
import test from 'node:test';

import { createFlowSnapshot, applyFlowFact } from './conversation-flow.mjs';
import { createWorkflowFlowRouter, workflowCardFact } from '../main/workflows/flow-router.mjs';

/** 建一个带运行槽的快照（run-started 语义由 controller 管；这里直接造 runs 条目）。 */
function snapshotWithRun(runId = 'run-1') {
  const snapshot = createFlowSnapshot({ conversationId: 'c1' });
  const fact = { type: 'run-preparing', runId, source: 'user', inputIds: [], at: 1, generation: 1 };
  return applyFlowFact(snapshot, fact).snapshot;
}

function deliver(snapshot, input) {
  return applyFlowFact(snapshot, {
    type: 'input-delivered',
    input: { inputId: 'in-1', text: '', workflow: input.workflow, ...input },
    runId: 'run-1',
    at: 10,
    generation: 1,
  });
}

const WORKFLOW = { invocationId: 'inv-9', workflowId: 'wf-weekly', workflowRunId: 'wrun-1', title: '周报' };

test('workflow 输入投递：出执行卡 part、不伪造用户气泡', () => {
  const { snapshot, applied } = deliver(snapshotWithRun(), { workflow: WORKFLOW });
  assert.equal(applied, true);
  assert.equal(snapshot.timeline.some((e) => e.kind === 'user'), false, '没有用户文字项');
  const cardItem = snapshot.timeline.find((e) => e.kind === 'assistant');
  const part = cardItem?.parts?.[0];
  assert.equal(part?.kind, 'workflow-card');
  assert.equal(part?.partId, 'card-inv-9');
  assert.equal(part?.status, 'starting');
  assert.equal(part?.invocationId, 'inv-9');
  assert.equal(part?.workflowRunId, 'wrun-1');
});

test('workflow 卡片状态经 part-updated 原位更新（partId 不变、位置稳定）', () => {
  let { snapshot } = deliver(snapshotWithRun(), { workflow: WORKFLOW });
  const updated = applyFlowFact(snapshot, {
    type: 'part-updated',
    runId: 'run-1',
    generation: 1,
    at: 20,
    partId: 'card-inv-9',
    patch: { kind: 'workflow-card', invocationId: 'inv-9', status: 'running', currentNodeId: 'agent' },
  });
  assert.equal(updated.applied, true);
  snapshot = updated.snapshot;
  assert.equal(snapshot.timeline.length, 1, '不新增卡片');
  assert.equal(snapshot.timeline[0].parts[0].status, 'running');
  assert.equal(snapshot.timeline[0].parts[0].currentNodeId, 'agent');
  assert.equal(snapshot.timeline[0].parts[0].partId, 'card-inv-9');
});

test('workflowCardFact：partId＋patch 形状、原位合并到终态', () => {
  const fact = workflowCardFact({ invocationId: 'i1', status: 'completed', patch: { finishedAt: 5 }, at: 6 });
  assert.equal(fact.partId, 'card-i1');
  assert.equal(fact.patch.status, 'completed');
  const applied = applyFlowFact(deliver(snapshotWithRun(), { workflow: { invocationId: 'i1' } }).snapshot, {
    ...fact,
    runId: 'run-1',
    generation: 1,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.snapshot.timeline[0].parts[0].status, 'completed');
});

test('普通文字输入不受影响：仍转正用户气泡（回归守卫）', () => {
  const { snapshot } = deliver(snapshotWithRun(), { workflow: null, text: '你好' });
  assert.equal(snapshot.timeline[0].kind, 'user');
  assert.equal(snapshot.timeline[0].text, '你好');
});

// ---------- flow-router ----------

function controllerStub() {
  const facts = [];
  return {
    facts,
    applyFact(f) {
      facts.push(f);
    },
  };
}

test('flow-router.start：running→终态两段事实、runId/generation 注入、成功收口', async () => {
  const applied = [];
  const router = createWorkflowFlowRouter({
    runInvocation: async ({ invocationId, onProgress }) => {
      assert.equal(invocationId, 'inv-9');
      onProgress?.({ status: 'waiting', patch: { waitReason: '登录' } });
      return { status: 'completed', outputs: { report: '/tmp/x.md' } };
    },
  });
  const outcome = await router.start({
    runId: 'run-1',
    envelope: { inputId: 'in-1', workflow: WORKFLOW },
    generation: 3,
    applyFact: (f) => applied.push(f),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'completed');
  const statuses = applied.filter((f) => f.type === 'part-updated').map((f) => f.patch.status);
  assert.deepEqual(statuses, ['running', 'waiting', 'completed']);
  assert.ok(applied.every((f) => f.runId === 'run-1' && f.generation === 3));
  const finalPart = applied.at(-1).patch;
  assert.deepEqual(finalPart.outputs, { report: '/tmp/x.md' });
});

test('flow-router.start：runner 抛错 → failed 事实＋ok:false（不悬挂）', async () => {
  const router = createWorkflowFlowRouter({
    runInvocation: async () => {
      throw new Error('模型 503');
    },
  });
  const controller = controllerStub();
  const outcome = await router.start({
    runId: 'run-1',
    envelope: { inputId: 'in-1', workflow: WORKFLOW },
    generation: 1,
    applyFact: (f) => controller.applyFact(f),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'failed');
  const last = controller.facts.at(-1).patch;
  assert.equal(last.status, 'failed');
  assert.match(last.error, /模型 503/);
});

test('flow-router.start：非 completed 终态（stopped/uncertain→failed 映射）', async () => {
  const router = createWorkflowFlowRouter({ runInvocation: async () => ({ status: 'stopped' }) });
  const controller = controllerStub();
  const outcome = await router.start({
    runId: 'run-1',
    envelope: { workflow: WORKFLOW },
    generation: 1,
    applyFact: (f) => controller.applyFact(f),
  });
  assert.equal(outcome.status, 'stopped');
  assert.equal(controller.facts.at(-1).patch.status, 'stopped');
});

test('flow-router 缺 runInvocation 拒绝装配；缺 invocationId 拒绝启动', async () => {
  assert.throws(() => createWorkflowFlowRouter({}));
  const router = createWorkflowFlowRouter({ runInvocation: async () => ({ status: 'completed' }) });
  await assert.rejects(() => router.start({ runId: 'r', envelope: { workflow: {} }, generation: 1, applyFact: () => {} }));
});
