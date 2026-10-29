// 编辑回卷前等在途运行收口（2026-10-29 真机：在途回合中编辑重发，新消息卡在待发送）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationController } from './conversation-controller.mjs';
import { closeConversationRun } from './run-completion.mjs';
import { waitRunSettled } from './run-settle.mjs';

const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function setup() {
  const starts = [];
  const runtime = {
    start() { let resolve; const p = new Promise((r) => { resolve = r; }); starts.push({ resolve }); return p; },
    stop() { return Promise.resolve({ ok: true }); },
  };
  const store = { async update() {}, async flush() {} };
  let n = 0;
  const controller = createConversationController({
    conversationId: 'conv-settle', effects: { runtime, store }, makeId: (p) => `${p}-${++n}`,
  });
  return { controller, starts };
}

async function startRunning(controller, starts, text) {
  const sent = controller.command({ type: 'send', input: { text } });
  await settle();
  starts.at(-1).resolve({ modelUsed: 'mock' });
  await sent;
  await settle();
  return controller.getSnapshot();
}

test('旧缺陷对照：运行中直接 generation-bumped，旧代 run-closed 被丢弃，新发送永远排队', async () => {
  const { controller, starts } = setup();
  const snap = await startRunning(controller, starts, 'first');
  const runId = snap.activeRunId;
  const generation = snap.generation;
  await controller.command({ type: 'stop', reason: 'preempt' });
  controller.applyFact({ type: 'generation-bumped', cutAfterInputId: snap.timeline[0].id });
  await closeConversationRun({ controller, runId, generation, outcome: 'stopped', persist: async () => {} });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'stopping');
  const sent = await controller.command({ type: 'send', input: { text: 'edited' } });
  assert.equal(sent.disposition, 'queued');
});

test('waitRunSettled：等旧运行按原代收口后再回卷，重发直接起跑', async () => {
  const { controller, starts } = setup();
  const snap = await startRunning(controller, starts, 'first');
  const runId = snap.activeRunId;
  const generation = snap.generation;
  const waiting = waitRunSettled(controller, { timeoutMs: 2000 });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'stopping');
  await closeConversationRun({ controller, runId, generation, outcome: 'stopped', persist: async () => {} });
  assert.equal(await waiting, true);
  controller.applyFact({ type: 'generation-bumped', cutAfterInputId: snap.timeline[0].id });
  const sent = controller.command({ type: 'send', input: { text: 'edited' } });
  await settle();
  starts.at(-1).resolve({ modelUsed: 'mock' });
  const result = await sent;
  assert.notEqual(result.disposition, 'queued');
  assert.equal(controller.getSnapshot().phase, 'running');
  assert.equal(controller.getSnapshot().pending.length, 0);
});

test('waitRunSettled：空闲直接返回；旧运行不收口时超时返回 false', async () => {
  const { controller, starts } = setup();
  assert.equal(await waitRunSettled(controller), true);
  await startRunning(controller, starts, 'first');
  assert.equal(await waitRunSettled(controller, { timeoutMs: 30 }), false);
});
