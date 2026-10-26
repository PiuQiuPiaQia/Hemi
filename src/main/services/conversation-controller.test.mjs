// 057 会话控制器确定性单测（S1）：可控 runtime／store 替身，枚举相邻事件交错。
// 不接真实 SDK（S2 才接线）；这里钉死的是调度不变量——单槽、单次消费、停止边界、
// 回卷裁剪、续排门控与补丁连续性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationController, nextFlowPhase } from './conversation-controller.mjs';
import { applyFlowChange } from '../../../src/shared/conversation-flow.mjs';

const settle = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeEffects({ storeFails = 0, failAtCalls = [] } = {}) {
  const runtime = {
    starts: [], stops: [],
    start(spec) { const d = deferred(); runtime.starts.push({ spec, ...d }); return d.promise; },
    stop(spec) { runtime.stops.push(spec); return Promise.resolve({ ok: true }); },
  };
  let failures = storeFails;
  const store = {
    saves: [], flushed: 0,
    async update(id, payload) {
      store.calls = (store.calls ?? 0) + 1;
      if (failAtCalls.includes(store.calls)) throw new Error('disk full');
      if (failures > 0) { failures -= 1; throw new Error('disk full'); }
      store.saves.push({ id, payload });
    },
    async flush() { store.flushed += 1; },
  };
  return { runtime, store };
}

function makeController(effects) {
  let counter = 0;
  let clock = 1000;
  return createConversationController({
    conversationId: 'conv-test',
    effects,
    now: () => clock,
    makeId: (prefix) => `${prefix}-${String(++counter).padStart(2, '0')}`,
    tick: () => { clock += 1; },
  });
}

/** 驱动一次完整运行：send → resolve runtime.start → settled+closed。 */
async function runAndClose(controller, effects, { text, outcome = 'completed' } = {}) {
  const sendPromise = controller.command({ type: 'send', input: { text } });
  await settle();
  const start = effects.runtime.starts.at(-1);
  start.resolve({ modelUsed: 'mock-main' });
  const sent = await sendPromise;
  await settle();
  const runId = controller.getSnapshot().activeRunId;
  controller.applyFact({ type: 'run-settled', runId, at: 2000 });
  controller.applyFact({ type: 'run-closed', runId, outcome, at: 2001 });
  return { sent, runId };
}

test('nextFlowPhase：四态转移表（非法转移保持原状态）', () => {
  assert.equal(nextFlowPhase('idle', 'claim'), 'preparing');
  assert.equal(nextFlowPhase('preparing', 'ready'), 'running');
  assert.equal(nextFlowPhase('preparing', 'prepare-failed'), 'idle');
  assert.equal(nextFlowPhase('running', 'stop'), 'stopping');
  assert.equal(nextFlowPhase('preparing', 'stop'), 'stopping');
  assert.equal(nextFlowPhase('stopping', 'closed'), 'idle');
  assert.equal(nextFlowPhase('running', 'closed'), 'idle');
  assert.equal(nextFlowPhase('idle', 'ready'), 'idle', '空闲不能直接 ready');
  assert.equal(nextFlowPhase('idle', 'closed'), 'idle');
  assert.equal(nextFlowPhase('running', 'claim'), 'running', '运行中不能再占槽');
});

test('空闲发送：占槽→保存→用户项转正→running；收口回 idle', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const sendPromise = controller.command({ type: 'send', input: { text: '第一问' } });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'preparing');
  assert.equal(effects.runtime.starts.length, 1);
  effects.runtime.starts[0].resolve({ modelUsed: 'mock-main' });
  const sent = await sendPromise;
  await settle();
  assert.equal(sent.ok, true);
  assert.equal(sent.disposition, 'started');
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, 'running');
  assert.equal(snapshot.activeRunId, sent.runId);
  assert.deepEqual(snapshot.timeline.map((e) => e.kind), ['user']);
  assert.equal(snapshot.timeline[0].text, '第一问');
  // 适配层收口：settled 不改相位，closed 回 idle 并带终态。
  controller.applyFact({ type: 'run-settled', runId: sent.runId, at: 2000 });
  assert.equal(controller.getSnapshot().phase, 'running');
  controller.applyFact({ type: 'run-closed', runId: sent.runId, outcome: 'completed', at: 2001 });
  await settle();
  const closed = controller.getSnapshot();
  assert.equal(closed.phase, 'idle');
  assert.equal(closed.runs[sent.runId].outcome, 'completed');
  assert.ok(effects.store.saves.length >= 1, '受理先落最小快照');
});

test('忙时发送入队：FIFO 逐条派发，每条独立成回合', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  await runAndClose(controller, effects, { text: '首问' });
  const busy = controller.command({ type: 'send', input: { text: '第二问' } });
  await settle(3);
  // 首问已收口回 idle——这次是空闲直发，占槽后再排队两条。
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'mock-main' });
  const sent = await busy;
  await settle();
  assert.equal(sent.disposition, 'started');
  const q1 = await controller.command({ type: 'send', input: { text: '排队一' } });
  const q2 = await controller.command({ type: 'send', input: { text: '排队二' } });
  assert.equal(q1.disposition, 'queued');
  assert.equal(q2.disposition, 'queued');
  assert.equal(controller.getSnapshot().pending.length, 2);
  // 收口当前运行 → 队首自动派发。
  const runA = controller.getSnapshot().activeRunId;
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'completed', at: 2010 });
  await settle();
  assert.equal(controller.getSnapshot().pending.length, 1, '队首已转正');
  assert.equal(effects.runtime.starts.at(-1).spec.envelope.inputId, q1.inputId);
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'mock-main' });
  await settle();
  const runB = controller.getSnapshot().activeRunId;
  controller.applyFact({ type: 'run-closed', runId: runB, outcome: 'completed', at: 2020 });
  await settle();
  assert.equal(effects.runtime.starts.at(-1).spec.envelope.inputId, q2.inputId);
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'mock-main' });
  await settle();
  const texts = controller.getSnapshot().timeline.filter((e) => e.kind === 'user').map((e) => e.text);
  assert.deepEqual(texts, ['首问', '第二问', '排队一', '排队二'], 'FIFO 顺序派发、各转正一次');
  const runC = controller.getSnapshot().activeRunId;
  controller.applyFact({ type: 'run-closed', runId: runC, outcome: 'completed', at: 2030 });
  await settle();
});

test('队列容量 8：第 9 条 queue-full', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  await runAndClose(controller, effects, { text: '首问' });
  // 让会话保持 busy：占住槽不收口。
  const hold = controller.command({ type: 'send', input: { text: '占位' } });
  await settle();
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await hold;
  for (let i = 1; i <= 8; i += 1) {
    const r = await controller.command({ type: 'send', input: { text: `q${i}` } });
    assert.equal(r.disposition, 'queued');
  }
  const overflow = await controller.command({ type: 'send', input: { text: 'q9' } });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'queue-full');
  assert.equal(controller.getSnapshot().pending.length, 8);
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2100 });
  controller.command({ type: 'stop', pauseQueue: true });
  await settle();
});

test('准备中停止：立即 stopping＋暂停队列；迟到的准备结果不再起模型', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const sendPromise = controller.command({ type: 'send', input: { text: '慢启动' } });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'preparing');
  const stop = await controller.command({ type: 'stop' });
  assert.equal(stop.disposition, 'stop-requested');
  const stopped = controller.getSnapshot();
  assert.equal(stopped.phase, 'stopping');
  assert.equal(stopped.queuePaused, true);
  // runtime.start 迟到返回：不得再 commit running。
  effects.runtime.starts[0].resolve({ modelUsed: 'm' });
  const sent = await sendPromise;
  await settle();
  assert.equal(sent.disposition, 'stop-requested');
  assert.equal(controller.getSnapshot().phase, 'stopping', '迟到 ready 被丢弃');
  controller.applyFact({ type: 'run-closed', runId: stopped.activeRunId, outcome: 'stopped', at: 2400 });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'idle');
  // 2026-10-18 用户裁决：停止后没有新任务时只展示「继续任务」按钮——空队列下
  // 显式新发送即离开「停止待继续」态，暂停随之解除（按钮退场）；有排队项不受影响。
  const hold = controller.command({ type: 'send', input: { text: '暂停后的新消息' } });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'preparing');
  assert.equal(controller.getSnapshot().queuePaused, false, '空队列新任务解除停止暂停');
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await hold;
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2410 });
  await settle();
});

test('运行中停止：暂停队列保留 pending；收口后不自动续排；恢复队列才派发；旧回执不复活', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  await runAndClose(controller, effects, { text: '首问' });
  const hold = controller.command({ type: 'send', input: { text: '占位' } });
  await settle();
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await hold;
  await controller.command({ type: 'send', input: { text: '排队项' } });
  const stop = await controller.command({ type: 'stop' });
  assert.equal(stop.disposition, 'stop-requested');
  const runId = stop.runId;
  controller.applyFact({ type: 'run-closed', runId, outcome: 'stopped', at: 2500 });
  await settle();
  const afterStop = controller.getSnapshot();
  assert.equal(afterStop.queuePaused, true);
  assert.equal(afterStop.pending.length, 1, '待发送项保留');
  assert.equal(effects.runtime.starts.length, 2, '暂停时不自动续排');
  // 旧运行的迟到增量被丢弃（closed 后 runAccepts=false）。
  const revision = afterStop.revision;
  controller.applyFact({ type: 'part-appended', runId, part: { partId: 'late', kind: 'text', content: '迟到输出' } });
  assert.equal(controller.getSnapshot().revision, revision, '迟到 part 不改变状态');
  const resumed = await controller.command({ type: 'resumeQueue' });
  assert.equal(resumed.disposition, 'resumed');
  await settle();
  assert.equal(effects.runtime.starts.length, 3, '恢复队列后续排队首');
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await settle();
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2510 });
  await settle();
});

test('回卷：preempt 取消（不暂停队列）→ 关闭后裁剪＋generation+1＋替换运行；旧代回执丢弃', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const { sent } = await runAndClose(controller, effects, { text: '将被改写' });
  controller.applyFact({ type: 'part-appended', runId: sent.runId, part: { partId: 'p1', kind: 'text', content: '旧输出' } });
  const hold = controller.command({ type: 'send', input: { text: '第二问' } });
  await settle();
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await hold;
  await settle();
  const rewind = await controller.command({ type: 'rewind', targetInputId: sent.inputId, input: { text: '改写后的问题' } });
  assert.equal(rewind.disposition, 'rewinding');
  const stopping = controller.getSnapshot();
  assert.equal(stopping.phase, 'stopping');
  assert.equal(stopping.queuePaused, false, 'preempt 不暂停队列');
  assert.equal(effects.runtime.stops.at(-1).reason, 'preempt');
  controller.applyFact({ type: 'run-closed', runId: stopping.activeRunId, outcome: 'stopped', at: 2700 });
  await settle();
  const replaced = controller.getSnapshot();
  assert.equal(replaced.generation, 2);
  assert.equal(replaced.phase, 'preparing', '替换运行已占槽');
  assert.ok(!replaced.timeline.some((e) => e.kind === 'user' && e.id === sent.inputId), '回卷目标被裁掉');
  assert.ok(replaced.timeline.some((e) => e.kind === 'user' && e.text === '改写后的问题'));
  // 旧代回执全部失效。
  const revision = replaced.revision;
  const dropped = controller.applyFact({ type: 'part-appended', runId: sent.runId, generation: 1, part: { partId: 'ghost', kind: 'text', content: '旧代残留' } });
  assert.equal(dropped.applied, false);
  assert.equal(controller.getSnapshot().revision, revision);
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await settle();
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2710 });
  await settle();
  assert.equal(effects.runtime.starts.length, 3, '在途回卷替换收口后不再次执行');
  assert.equal(controller.getSnapshot().phase, 'idle');
});

test('停止尚未收口时回卷：等旧代关闭才裁剪，替换只派发一次并离开空队列停止态', async () => {
  const effects = makeEffects(), controller = makeController(effects);
  const first = controller.command({type: 'send', input: {inputId: 'original', text: '原问题'}});
  await settle(); effects.runtime.starts[0].resolve({}); await first;
  const old = controller.getSnapshot().activeRunId;
  await controller.command({type: 'stop', targetRunId: old});
  const rewind = {type: 'rewind', targetInputId: 'original', input: {inputId: 'replacement', text: '修改后'}};
  assert.equal((await controller.command(rewind)).ok, true);
  assert.equal((await controller.command(rewind)).ok, true, '重复同一身份不覆盖交接');
  assert.equal(controller.getSnapshot().generation, 1);
  assert.equal(controller.getSnapshot().activeRunId, old);
  assert.equal(controller.getSnapshot().phase, 'stopping');
  assert.equal(effects.runtime.starts.length, 1);
  assert.equal(effects.runtime.stops.length, 1, '沿用已经开始的停止');
  assert.equal((await controller.command({...rewind, input: {inputId: 'conflicting', text: '另一重发'}})).code, 'handoff-busy');
  controller.applyFact({type: 'run-closed', runId: old, generation: 1, outcome: 'stopped', at: 2700});
  await settle();
  assert.equal(effects.runtime.starts.length, 2);
  assert.equal(controller.getSnapshot().generation, 2);
  assert.equal(controller.getSnapshot().queuePaused, false);
  effects.runtime.starts[1].resolve({}); await settle();
  const current = controller.getSnapshot().activeRunId;
  assert.equal((await controller.command({type: 'stop', targetRunId: old})).code, 'run-changed');
  assert.equal(controller.applyFact({type: 'part-appended', runId: old, generation: 1, part: {partId: 'late', kind: 'text', content: '旧回复'}}).applied, false);
  controller.applyFact({type: 'run-closed', runId: current, generation: 2, outcome: 'completed', at: 2800});
  await settle();
  assert.equal(effects.runtime.starts.length, 2);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.deepEqual(controller.getSnapshot().timeline.filter(item => item.kind === 'user').map(item => item.id), ['replacement']);
});

test('空闲停止态回卷解除空队列暂停；有已暂停的排队消息时保持暂停', async () => {
  for (const queued of [false, true]) {
    const effects = makeEffects(), controller = makeController(effects);
    const {sent} = await runAndClose(controller, effects, {text: '原问题', outcome: 'stopped'});
    await settle(); controller.applyFact({type: 'queue-paused'});
    if (queued) controller.applyFact({type: 'input-accepted', input: {inputId: 'queued', text: '保留排队', editRevision: 0}});
    const resend = controller.command({type: 'rewind', targetInputId: sent.inputId, input: {inputId: 'replacement', text: '重发'}});
    await settle(); effects.runtime.starts.at(-1).resolve({}); await resend;
    assert.equal(controller.getSnapshot().queuePaused, queued);
    assert.deepEqual(controller.getSnapshot().pending.map(item => item.inputId), queued ? ['queued'] : []);
  }
});

test('并发回卷与异步冻结交错：只有一个替换受理，迟到冻结不能裁掉新代次', async () => {
  const effects = makeEffects(), controller = makeController(effects);
  const {sent} = await runAndClose(controller, effects, {text: '原问题'}); await settle();
  const frozen = deferred(); effects.runtime.freezeInput = () => frozen.promise;
  const late = controller.command({type: 'rewind', targetInputId: sent.inputId, input: {inputId: 'late', text: '迟到'}});
  effects.runtime.freezeInput = async () => ({});
  const winning = controller.command({type: 'rewind', targetInputId: sent.inputId, input: {inputId: 'winning', text: '获受理'}});
  await settle(); effects.runtime.starts.at(-1).resolve({}); await winning;
  frozen.resolve({});
  assert.equal((await late).ok, false);
  assert.equal(controller.getSnapshot().generation, 2);
  assert.equal(effects.runtime.starts.length, 2);
  assert.deepEqual(controller.getSnapshot().timeline.filter(item => item.kind === 'user').map(item => item.id), ['winning']);
});

for (const outcome of ['completed', 'failed', 'stopped']) {
  test(`空闲回卷：替换运行 ${outcome} 后不重复执行同一输入或再次裁剪历史`, async () => {
    const effects = makeEffects();
    const controller = makeController(effects);
    const { sent } = await runAndClose(controller, effects, { text: '原问题' });
    await settle();
    const rewind = controller.command({
      type: 'rewind', targetInputId: sent.inputId,
      input: { inputId: 'edited-input', text: '修改后的问题' },
    });
    await settle();
    assert.equal(effects.runtime.starts.length, 2);
    effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
    const replacement = await rewind;
    assert.equal(replacement.ok, true);
    controller.applyFact({ type: 'part-appended', runId: replacement.runId,
      part: { partId: 'edited-answer', kind: 'text', content: '保留这次回答' } });
    controller.applyFact({ type: 'run-closed', runId: replacement.runId, outcome, at: 2800 });
    await settle();
    const snapshot = controller.getSnapshot();
    assert.equal(effects.runtime.starts.length, 2, '同一替换输入只启动一次');
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.generation, 2, '替换收口不再次触发回卷');
    assert.equal(Object.values(snapshot.runs).filter(run => run.inputIds.includes('edited-input')).length, 1);
    assert.deepEqual(snapshot.timeline.filter(item => item.kind === 'user').map(item => item.id), ['edited-input']);
    assert.ok(snapshot.timeline.some(item => item.parts?.some(part => part.partId === 'edited-answer')));
  });
}

test('受理保存失败（SDK 未执行）：运行收口、输入回可见队列、不自动重发', async () => {
  const effects = makeEffects({ storeFails: 1 });
  const controller = makeController(effects);
  const result = await controller.command({ type: 'send', input: { text: '保存失败' } });
  await settle();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'storage-failed');
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, 'idle');
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.pending[0].text, '保存失败');
  assert.equal(snapshot.timeline.length, 0, '未转正不留残影');
  assert.equal(effects.runtime.starts.length, 0, '没调 SDK');
  assert.equal(snapshot.queuePaused, true, '保存失败暂停自动续排');
  assert.equal(snapshot.pending[0].state, 'pending', '恢复的输入不再自动派发');
});

test('后台报告：队列优先、非暂停空闲才转述；暂停时挂起', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  await runAndClose(controller, effects, { text: '首问' });
  const hold = controller.command({ type: 'send', input: { text: '占位' } });
  await settle();
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await hold;
  await controller.command({ type: 'send', input: { text: '排队优先' } });
  controller.applyFact({ type: 'report-queued', report: { taskId: 't1', runs: 1, resultVersion: 5 } });
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2800 });
  await settle();
  // 队列优先：先派排队项，不先转述报告。
  const queueStart = effects.runtime.starts.at(-1);
  assert.equal(queueStart.spec.source, 'queue');
  assert.equal(queueStart.spec.envelope.text, '排队优先');
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await settle();
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2810 });
  await settle();
  // 队列空了：报告转述回合（source=event，无用户输入）。
  const eventStart = effects.runtime.starts.at(-1);
  assert.equal(eventStart.spec.source, 'event');
  assert.equal(eventStart.spec.envelope, null);
  assert.equal(controller.getSnapshot().pendingReports.length, 0);
  eventStart.resolve({ modelUsed: 'm' });
  await settle();
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 2820 });
  // 暂停变体：显式停止后报告只挂起。
  controller.applyFact({ type: 'report-queued', report: { taskId: 't2', runs: 1, resultVersion: 1 } });
  await controller.command({ type: 'stop', pauseQueue: true });
  await settle();
  assert.equal(controller.getSnapshot().pendingReports.length, 1);
  assert.equal(effects.runtime.starts.length, 4, '暂停时不自动转述');
});

test('订阅补丁流：baseRevision 链连续，从任意快照回放等于最终状态', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const changes = [];
  controller.subscribe((change) => changes.push(change));
  await runAndClose(controller, effects, { text: '首问' });
  for (let i = 1; i < changes.length; i += 1) {
    assert.equal(changes[i].baseRevision, changes[i - 1].revision, `补丁链连续 @${i}`);
  }
  // 从「订阅时基线」（初值）回放。
  const { createFlowSnapshot } = await import('../../../src/shared/conversation-flow.mjs');
  let client = createFlowSnapshot({ conversationId: 'conv-test' });
  for (const change of changes) {
    const result = applyFlowChange(client, change);
    assert.equal(result.ok, true);
    client = result.snapshot;
  }
  assert.deepEqual(client, controller.getSnapshot());
});

test('两会话控制器互不串扰', async () => {
  const effectsA = makeEffects();
  const effectsB = makeEffects();
  const a = makeController(effectsA);
  const b = makeController(effectsB);
  const runA = a.command({ type: 'send', input: { text: 'A 的问题' } });
  const runB = b.command({ type: 'send', input: { text: 'B 的问题' } });
  await settle();
  effectsA.runtime.starts[0].resolve({ modelUsed: 'a' });
  effectsB.runtime.starts[0].resolve({ modelUsed: 'b' });
  await Promise.all([runA, runB]);
  await settle();
  assert.equal(a.getSnapshot().timeline[0].text, 'A 的问题');
  assert.equal(b.getSnapshot().timeline[0].text, 'B 的问题');
  assert.equal(effectsA.runtime.starts.length, 1);
  assert.equal(effectsB.runtime.starts.length, 1);
  a.applyFact({ type: 'run-closed', runId: a.getSnapshot().activeRunId, outcome: 'completed', at: 2900 });
  assert.equal(b.getSnapshot().phase, 'running', 'A 收口不影响 B');
  b.applyFact({ type: 'run-closed', runId: b.getSnapshot().activeRunId, outcome: 'completed', at: 2901 });
  await settle();
});

test('S2 抢话直发（preempt=active）：取消当前运行（不暂停队列）→ 关闭后作为新回合重发', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  await runAndClose(controller, effects, { text: '首问' });
  const hold = controller.command({ type: 'send', input: { text: '在途回合' } });
  await settle();
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await hold;
  await settle();
  // 在途时用户直发（llm:chat 口径）：抢话替换，不排队。
  const preempting = await controller.command({ type: 'send', input: { text: '抢话的新消息' }, preempt: 'active' });
  assert.equal(preempting.disposition, 'preempting');
  const stopping = controller.getSnapshot();
  assert.equal(stopping.phase, 'stopping');
  assert.equal(stopping.queuePaused, false, 'preempt 不暂停队列');
  assert.equal(effects.runtime.stops.at(-1).reason, 'preempt');
  controller.applyFact({ type: 'run-closed', runId: stopping.activeRunId, outcome: 'stopped', at: 3000 });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'preparing', '替换回合已占槽');
  const userTexts = controller.getSnapshot().timeline.filter((e) => e.kind === 'user').map((e) => e.text);
  assert.deepEqual(userTexts, ['首问', '在途回合', '抢话的新消息'], '抢话不裁剪时间线，新消息接续');
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await settle();
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 3010 });
  await settle();
});

test('S2 runtime 自闭合：适配层自呈 run-started/closed 时控制器不重复收口、结果透传', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  // 适配层语义：start 执行中自己 applyFact run-started，结束时 run-closed 后 resolve。
  const originalStart = effects.runtime.start;
  effects.runtime.start = async (spec) => {
    controller.applyFact({ type: 'run-started', runId: spec.runId, at: 3100, modelUsed: 'self-close-m' });
    await new Promise((resolve) => setImmediate(resolve));
    controller.applyFact({ type: 'run-settled', runId: spec.runId, at: 3101 });
    controller.applyFact({ type: 'run-closed', runId: spec.runId, outcome: 'completed', at: 3102 });
    return { modelUsed: 'self-close-m', result: { text: '自闭合结果' }, aborted: false };
  };
  const sent = await controller.command({ type: 'send', input: { text: '自闭合回合' } });
  await settle();
  assert.equal(sent.ok, true);
  assert.equal(sent.disposition, 'started');
  assert.equal(sent.runtimeResult.result.text, '自闭合结果');
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().runs[sent.runId].outcome, 'completed');
});

test('通话停止屏障：重复提交幂等，下一条不能覆盖已受理输入', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const initial = controller.command({ type: 'send', input: { inputId: 'old', text: '旧通话' } });
  await settle();
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await initial;
  const oldRun = controller.getSnapshot().activeRunId;
  const next = { type: 'send', input: { inputId: 'next', text: '接管句', inputSource: 'voice' }, preempt: 'active' };
  assert.equal((await controller.command(next)).disposition, 'preempting');
  assert.equal((await controller.command(next)).disposition, 'preempting', '重试同一身份不重复请求停止');
  assert.equal((await controller.command({ type: 'send', input: { inputId: 'old' }, preempt: 'active' })).disposition, 'already-accepted');
  assert.equal((await controller.command({ ...next, input: { inputId: 'third', text: '下一句' } })).code, 'handoff-busy');
  assert.equal(effects.runtime.stops.length, 1);
  assert.equal(controller.getSnapshot().pending.length, 0, '通话接管不进入普通待发送队列');
  controller.applyFact({ type: 'run-closed', runId: oldRun, outcome: 'stopped', at: 3000 });
  await settle();
  assert.equal(effects.runtime.starts.at(-1).spec.envelope.inputId, 'next');
  effects.runtime.starts.at(-1).resolve({ modelUsed: 'm' });
  await settle();
  assert.deepEqual(controller.getSnapshot().timeline.filter(item => item.kind === 'user').map(item => item.id), ['old', 'next']);
});

test('bug#17：上游 start 挂死时停止→新发送不永久卡（closeWaitMs 到点按不明收口续排）', async () => {
  const effects = makeEffects();
  const controller = createConversationController({
    conversationId: 'conv-hang', effects, now: () => 1000,
    makeId: (() => { let n = 0; return (p) => `${p}-${++n}`; })(),
    closeWaitMs: 60, // 测试注入短预算（生产 30s）
  });
  // 运行 1：start 永久挂死（不 settle）——复刻模型请求无响应。
  void controller.command({ type: 'send', input: { inputId: 'in-1', text: '挂死回合', inputSource: 'text' } });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'preparing'); // start 未返回（挂死），停在准备段
  // 用户追加排队（挂死期间）。
  await controller.command({ type: 'send', input: { inputId: 'in-q', text: '追加', inputSource: 'text' } });
  assert.equal(controller.getSnapshot().pending.length, 1);
  // 用户再发（抢话）——旧 start 挂死；旧实现 postClose 无限等待 ⇒ 新回合永不启动。
  const second = await controller.command({ type: 'send', input: { inputId: 'in-2', text: '新回合', inputSource: 'text' }, preempt: 'active' });
  assert.equal(second.disposition, 'preempting');
  // 关闭事实到达（stop 已请求；挂死运行由适配层/看门狗收口）——此后 controller 侧
  // postClose 至多等 closeWaitMs：到点按不明继续，新回合（pendingNext）必须起跑。
  controller.applyFact({ type: 'run-closed', runId: 'run-1-1', outcome: 'stopped', at: 1200 });
  await new Promise((r) => setTimeout(r, 200));
  const snap = controller.getSnapshot();
  const startedRuns = effects.runtime.starts.filter((s) => s.spec?.envelope?.inputId === 'in-2');
  assert.equal(startedRuns.length, 1, '新回合在预算内起跑（不被挂死提交钉死）');
  assert.equal(snap.activeRunId, startedRuns[0].spec.runId);
  // 收尾：结算新 start。
  const last = effects.runtime.starts.at(-1);
  last.resolve({ modelUsed: 'm' });
  await settle();
});

test('060 S1：执行中并发普通发送全部排队——不打断当前、FIFO 逐条派发（AC-01/02）', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const a = controller.command({ type: 'send', input: { inputId: 'in-a', text: 'A', inputSource: 'text' } });
  await settle();
  assert.equal(controller.getSnapshot().phase, 'preparing');
  const b = await controller.command({ type: 'send', input: { inputId: 'in-b', text: 'B', inputSource: 'text' } });
  const c = await controller.command({ type: 'send', input: { inputId: 'in-c', text: 'C', inputSource: 'text' } });
  assert.equal(b.disposition, 'queued');
  assert.equal(c.disposition, 'queued');
  assert.deepEqual(controller.getSnapshot().pending.map((p) => p.inputId), ['in-b', 'in-c']);
  assert.equal(effects.runtime.stops.length, 0, 'A 无被动 abort');
  // 替身语义：每轮手动收口（resolve＋settled＋closed）。
  const closeRun = async (index) => {
    const start = effects.runtime.starts[index];
    start.resolve({ modelUsed: 'm' });
    await settle(2);
    controller.applyFact({ type: 'run-settled', runId: start.spec.runId, at: 2000 });
    controller.applyFact({ type: 'run-closed', runId: start.spec.runId, outcome: 'completed', at: 2001 });
    await settle(8);
  };
  // A 收口 → B 派发 → B 收口 → C 派发（FIFO，逐条单槽）。
  await closeRun(0);
  assert.equal(effects.runtime.starts.length, 2);
  assert.equal(effects.runtime.starts[1].spec.envelope.inputId, 'in-b');
  await closeRun(1);
  assert.equal(effects.runtime.starts.length, 3);
  assert.equal(effects.runtime.starts[2].spec.envelope.inputId, 'in-c');
  await closeRun(2);
  await a;
});

test('060 S1：双同文独立身份各消费一次（不按文本去重/合并）（AC-03）', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const a = controller.command({ type: 'send', input: { inputId: 'in-a', text: '先跑', inputSource: 'text' } });
  await settle();
  await controller.command({ type: 'send', input: { inputId: 'in-1a', text: '1', inputSource: 'text' } });
  await controller.command({ type: 'send', input: { inputId: 'in-1b', text: '1', inputSource: 'text' } });
  assert.equal(controller.getSnapshot().pending.length, 2, '同文两条都在队');
  const closeRun = async (index) => {
    const start = effects.runtime.starts[index];
    start.resolve({ modelUsed: 'm' });
    await settle(2);
    controller.applyFact({ type: 'run-settled', runId: start.spec.runId, at: 2000 });
    controller.applyFact({ type: 'run-closed', runId: start.spec.runId, outcome: 'completed', at: 2001 });
    await settle(8);
  };
  await closeRun(0);
  await closeRun(1);
  assert.equal(effects.runtime.starts.length, 3, '两条同文各起独立运行');
  const delivered = effects.runtime.starts.map((s) => s.spec.envelope?.inputId);
  assert.deepEqual(delivered, ['in-a', 'in-1a', 'in-1b'], '同文按身份各派发一次');
  await closeRun(2);
  await a;
});

test('060 S1：队列满（8 条）拒绝第 9 条且原队不变（AC-04）', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const a = controller.command({ type: 'send', input: { inputId: 'in-run', text: '占槽', inputSource: 'text' } });
  await settle();
  for (let i = 1; i <= 8; i += 1) {
    const r = await controller.command({ type: 'send', input: { inputId: `in-${i}`, text: `q${i}`, inputSource: 'text' } });
    assert.equal(r.disposition, 'queued', `第 ${i} 条入队`);
  }
  const ninth = await controller.command({ type: 'send', input: { inputId: 'in-9', text: 'q9', inputSource: 'text' } });
  assert.equal(ninth.ok, false);
  assert.equal(ninth.code, 'queue-full');
  assert.equal(controller.getSnapshot().pending.length, 8, '原队不变');
  assert.ok(controller.getSnapshot().pending.every((p) => p.inputId !== 'in-9'));
  effects.runtime.starts[0].resolve({ modelUsed: 'm' });
  await a;
  await settle(8);
});

test('060 S1：停止中提交也占用（queued）——恢复队列后才派发（AC-02/08）', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const a = controller.command({ type: 'send', input: { inputId: 'in-a', text: 'A', inputSource: 'text' } });
  await settle();
  await controller.command({ type: 'stop' }); // → stopping（真停：暂停队列）
  assert.equal(controller.getSnapshot().phase, 'stopping');
  const b = await controller.command({ type: 'send', input: { inputId: 'in-b', text: 'B', inputSource: 'text' } });
  assert.equal(b.disposition, 'queued', '停止中提交按排队受理（宿主占用判定不看过期本地忙）');
  // A 收口（stopped）——队列暂停：B 不自动派发。
  const runA = effects.runtime.starts[0].spec.runId;
  effects.runtime.starts[0].resolve({ modelUsed: 'm', aborted: true });
  await settle(4);
  controller.applyFact({ type: 'run-settled', runId: runA, at: 3000 });
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'stopped', at: 3001 });
  await settle(8);
  assert.equal(effects.runtime.starts.length, 1, '停止后不自动续排');
  assert.equal(controller.getSnapshot().queuePaused, true);
  await controller.command({ type: 'resumeQueue' });
  await settle(8);
  assert.equal(effects.runtime.starts.length, 2, '显式恢复后才派发队首');
  assert.equal(effects.runtime.starts[1].spec.envelope.inputId, 'in-b');
  effects.runtime.starts[1].resolve({ modelUsed: 'm' });
  await settle(4);
  await a;
});

test('060 S1：同一提交重复回执不重复执行（同 inputId → already-accepted，AC-03）', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  void controller.command({ type: 'send', input: { inputId: 'in-a', text: 'A', inputSource: 'text' } });
  await settle();
  await controller.command({ type: 'send', input: { inputId: 'in-b', text: 'B', inputSource: 'text' } });
  const again = await controller.command({ type: 'send', input: { inputId: 'in-b', text: 'B', inputSource: 'text' } });
  assert.equal(again.ok, true);
  assert.equal(again.disposition, 'already-accepted');
  assert.equal(controller.getSnapshot().pending.length, 1, '同身份不重复入队');
  const runA = effects.runtime.starts[0].spec.runId;
  effects.runtime.starts[0].resolve({ modelUsed: 'm' });
  await settle(4);
  controller.applyFact({ type: 'run-settled', runId: runA, at: 100 });
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'completed', at: 101 });
  await settle(8);
  assert.equal(effects.runtime.starts.length, 2);
  assert.equal(effects.runtime.starts[1].spec.envelope.inputId, 'in-b');
  assert.equal(effects.runtime.starts.filter((x) => x.spec.envelope?.inputId === 'in-b').length, 1, 'B 恰派发一次');
});

test('060 S1：派发保存失败——条目回队、队列暂停、不自动重试（AC-04/17）', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  const update = effects.store.update.bind(effects.store);
  let injected = false;
  effects.store.update = async (id, payload) => {
    const snap = controller.getSnapshot();
    if (!injected && snap.phase === 'preparing' && snap.runs[snap.activeRunId]?.inputIds.includes('in-b')) {
      injected = true;
      throw new Error('disk full at B dispatch');
    }
    return update(id, payload);
  };
  void controller.command({ type: 'send', input: { inputId: 'in-a', text: 'A', inputSource: 'text' } });
  await settle();
  await controller.command({ type: 'send', input: { inputId: 'in-b', text: 'B', inputSource: 'text' } });
  const runA = effects.runtime.starts[0].spec.runId;
  effects.runtime.starts[0].resolve({ modelUsed: 'm' });
  await settle(4);
  controller.applyFact({ type: 'run-settled', runId: runA, at: 100 });
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'completed', at: 101 });
  await settle(8);
  const snap = controller.getSnapshot();
  assert.equal(injected, true, '故障确实注入 B 派发保存，不依赖写入次数');
  assert.equal(effects.runtime.starts.length, 1, '保存失败不启动运行时（SDK 未执行）');
  assert.equal(snap.queuePaused, true, '派发失败暂停自动续排');
  assert.equal(snap.pending.find((x) => x.inputId === 'in-b')?.state, 'pending', '条目回队可见');
  const bRun = Object.keys(snap.runs).find((id) => id !== runA);
  assert.equal(snap.runs[bRun]?.outcome, 'failed');
  // 显式恢复后重派发（故障只注入一次）。
  await controller.command({ type: 'resumeQueue' });
  await settle(8);
  assert.equal(effects.runtime.starts.length, 2, '显式恢复后才重试派发');
  effects.runtime.starts[1].resolve({ modelUsed: 'm' });
  await settle(4);
});

test('060 R-21：显式插队——保存优先关系后停 A；A 收口后 B 优先派发、队列不暂停、A 不续跑', async () => {
  const effects = makeEffects();
  const controller = makeController(effects);
  void controller.command({ type: 'send', input: { inputId: 'in-a', text: 'A', inputSource: 'text' } });
  await settle();
  await controller.command({ type: 'send', input: { inputId: 'in-b', text: 'B', inputSource: 'text' } });
  await controller.command({ type: 'send', input: { inputId: 'in-c', text: 'C', inputSource: 'text' } });
  const runA = effects.runtime.starts[0].spec.runId;
  const promoted = await controller.command({ type: 'promoteInput', inputId: 'in-b' });
  assert.equal(promoted.disposition, 'promoting');
  assert.equal(effects.runtime.stops.length, 1, '旧目标收到停止请求');
  assert.equal(controller.getSnapshot().queuePaused, false, '插队让位不暂停普通队列');
  assert.equal(controller.getSnapshot().pending.find((x) => x.inputId === 'in-b')?.promoteTarget, runA, '优先关系冻结到旧目标 runId');
  // A 收口（停止确认）→ B 优先派发（先于队首 C）。
  effects.runtime.starts[0].resolve({ modelUsed: 'm', aborted: true });
  await settle(4);
  controller.applyFact({ type: 'run-settled', runId: runA, at: 900 });
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'stopped', at: 901 });
  await settle(8);
  assert.equal(effects.runtime.starts.length, 2, 'B 在停止确认后派发');
  assert.equal(effects.runtime.starts[1].spec.envelope.inputId, 'in-b');
  // B 收口 → C 按普通 FIFO 继续（A 不重新入队、不续跑）。
  const runB = effects.runtime.starts[1].spec.runId;
  effects.runtime.starts[1].resolve({ modelUsed: 'm' });
  await settle(4);
  controller.applyFact({ type: 'run-settled', runId: runB, at: 902 });
  controller.applyFact({ type: 'run-closed', runId: runB, outcome: 'completed', at: 903 });
  await settle(8);
  assert.equal(effects.runtime.starts.length, 3);
  assert.equal(effects.runtime.starts[2].spec.envelope.inputId, 'in-c');
  assert.ok(!controller.getSnapshot().pending.some((x) => x.inputId === 'in-a'), 'A 不出现在任何队列');
  effects.runtime.starts[2].resolve({ modelUsed: 'm' });
  await settle(4);
});

test('060 输入框编辑锁定队列原位置；旧回合完成后不越过编辑项，保存后原身份派发一次', async () => {
  const effects = makeEffects(), controller = makeController(effects);
  const a = controller.command({ type: 'send', input: { inputId: 'A', text: 'A' } });
  await settle(); effects.runtime.starts[0].resolve({}); await a;
  const runA = controller.getSnapshot().activeRunId;
  await controller.command({ type: 'send', input: { inputId: 'B', text: 'B', attachmentIds: ['file-b'] } });
  await controller.command({ type: 'send', input: { inputId: 'C', text: 'C' } });
  const edit = await controller.command({ type: 'beginEditInput', inputId: 'B' });
  assert.equal(edit.ok, true); assert.equal(edit.input.text, 'B');
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'completed', at: 30 });
  await settle(); assert.equal(effects.runtime.starts.length, 1, '不能跳过编辑中的队首');
  const saved = await controller.command({ type: 'finishEditInput', inputId: 'B', expectedEditRevision: 0, patch: { text: 'B已修改' } });
  assert.equal(saved.ok, true);
  await settle(); const dispatched = effects.runtime.starts[1];
  assert.equal(dispatched.spec.envelope.inputId, 'B');
  assert.equal(dispatched.spec.envelope.text, 'B已修改');
  assert.deepEqual(dispatched.spec.envelope.attachmentIds, ['file-b']);
  assert.deepEqual(controller.getSnapshot().pending.map((item) => item.inputId), ['C']);
  dispatched.resolve({});
});

test('060 重复优先点击不重复停止；冻结旧目标，交接后不把取消改指向新运行', async () => {
  const effects = makeEffects(), controller = makeController(effects);
  const a = controller.command({ type: 'send', input: { inputId: 'A', text: 'A' } });
  await settle(); effects.runtime.starts[0].resolve({}); await a;
  const runA = controller.getSnapshot().activeRunId;
  await controller.command({ type: 'send', input: { inputId: 'B', text: 'B' } });
  await controller.command({ type: 'promoteInput', inputId: 'B' });
  for (let i = 0; i < 20; i++) assert.equal((await controller.command({ type: 'promoteInput', inputId: 'B' })).disposition, 'already-promoting');
  assert.equal(effects.runtime.stops.length, 1);
  controller.applyFact({ type: 'run-closed', runId: runA, outcome: 'stopped', at: 30 });
  await settle(); assert.equal(effects.runtime.starts.length, 2);
  effects.runtime.starts[1].resolve({}); await settle();
  assert.equal(effects.runtime.stops.length, 1);
});

test('060 等待阶段交接时用户主动停止：立即升级取消并暂停队列，不再自动执行优先项', async () => {
  const effects = makeEffects(), controller = makeController(effects);
  const sent = controller.command({ type: 'send', input: { inputId: 'A', text: 'A' } });
  await settle(); effects.runtime.starts[0].resolve({}); await sent;
  const run = controller.getSnapshot().activeRunId;
  await controller.command({ type: 'send', input: { inputId: 'B', text: 'B' } });
  await controller.command({ type: 'promoteInput', inputId: 'B' });
  await controller.command({ type: 'stop', reason: 'stop' });
  assert.equal(effects.runtime.stops.length, 2);
  assert.equal(controller.getSnapshot().runs[run].stopReason, 'stop');
  assert.equal(controller.getSnapshot().queuePaused, true);
  assert.equal(controller.getSnapshot().pending[0].promoteAt, null);
  controller.applyFact({ type: 'run-closed', runId: run, outcome: 'stopped', at: 40 });
  await settle(); assert.equal(effects.runtime.starts.length, 1);
});

test('060 编辑草稿可恢复、乱序不回退；保存失败保留编辑锁，取消保留原消息', async () => {
  const effects = makeEffects(), controller = makeController(effects);
  const sent = controller.command({ type: 'send', input: { inputId: 'A', text: 'A' } });
  await settle(); effects.runtime.starts[0].resolve({}); await sent;
  await controller.command({ type: 'send', input: { inputId: 'B', text: 'B原文' } });
  await controller.command({ type: 'beginEditInput', inputId: 'B' });
  await controller.command({ type: 'saveInputEditDraft', inputId: 'B', draftRevision: 10, patch: { text: '新草稿' } });
  await controller.command({ type: 'saveInputEditDraft', inputId: 'B', draftRevision: 9, patch: { text: '旧草稿' } });
  assert.equal((await controller.command({ type: 'beginEditInput', inputId: 'B' })).input.editDraft.text, '新草稿');
  const save = effects.store.update;
  effects.store.update = async () => { throw new Error('disk full'); };
  assert.equal((await controller.command({ type: 'finishEditInput', inputId: 'B', patch: { text: '改稿' } })).ok, false);
  assert.equal(controller.getSnapshot().pending[0].state, 'editing');
  assert.equal(controller.getSnapshot().pending[0].text, 'B原文');
  effects.store.update = save;
  await controller.command({ type: 'finishEditInput', inputId: 'B', cancel: true });
  assert.equal(controller.getSnapshot().pending[0].state, 'pending');
  assert.equal(controller.getSnapshot().pending[0].text, 'B原文');
});

test('060 拖拽调整宿主队列顺序，资料和身份不变；当前运行完成后按新序派发', async () => {
  const effects = makeEffects(); const controller = makeController(effects);
  const active = controller.command({ type: 'send', input: { inputId: 'A', text: '当前任务' } });
  await settle(); effects.runtime.starts[0].resolve({}); await active;
  await controller.command({ type: 'send', input: { inputId: 'B', text: '原队首', attachmentIds: ['file-B'], references: [{ id: 'ref-B' }] } });
  await controller.command({ type: 'send', input: { inputId: 'C', text: '拖到前面' } });
  const original = controller.getSnapshot(); const itemB = original.pending[0];
  const result = await controller.command({ type: 'reorderInput', inputId: 'C', overInputId: 'B', expectedInputIds: ['B', 'C'] });
  assert.equal(result.ok, true);
  const reordered = controller.getSnapshot();
  assert.deepEqual(reordered.pending.map(i => i.inputId), ['C', 'B']);
  assert.strictEqual(reordered.pending[1], itemB, '不重建正文、附件或引用');
  assert.deepEqual(reordered.timeline, original.timeline, '拖拽不改正式流');
  assert.equal(effects.runtime.stops.length, 0, '排序不会停止当前运行');
  assert.ok(effects.store.saves.some(save => save.payload.revision === result.revision));
  controller.applyFact({ type: 'run-closed', runId: original.activeRunId, outcome: 'completed', at: 3000 });
  await settle(); assert.equal(effects.runtime.starts.at(-1).spec.envelope.inputId, 'C');
  effects.runtime.starts.at(-1).resolve({}); await settle();
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 4000 });
  await settle(); assert.equal(effects.runtime.starts.at(-1).spec.envelope.inputId, 'B');
  effects.runtime.starts.at(-1).resolve({}); await settle();
});

test('060 拖动期间新消息到达或原项开始派发：旧队列身份表拒绝，不吞新增项或已上屏项', async () => {
  const effects = makeEffects(); const controller = makeController(effects);
  const active = controller.command({ type: 'send', input: { inputId: 'A', text: '当前任务' } });
  await settle(); effects.runtime.starts[0].resolve({}); await active;
  for (const inputId of ['B', 'C', 'D']) await controller.command({ type: 'send', input: { inputId, text: inputId } });
  assert.equal((await controller.command({ type: 'reorderInput', inputId: 'C', overInputId: 'B', expectedInputIds: ['B', 'C'] })).code, 'stale-queue');
  assert.deepEqual(controller.getSnapshot().pending.map(i => i.inputId), ['B', 'C', 'D']);
  controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 3000 });
  await settle();
  assert.equal((await controller.command({ type: 'reorderInput', inputId: 'C', overInputId: 'B', expectedInputIds: ['B', 'C', 'D'] })).code, 'stale-queue');
  assert.equal(controller.getSnapshot().timeline.filter(i => i.id === 'B').length, 1);
  assert.deepEqual(controller.getSnapshot().pending.map(i => i.inputId), ['C', 'D']);
  effects.runtime.starts.at(-1).resolve({}); await settle();
});

test('060 编辑、交接和待核对项是排序锚点；普通项不能越过，但同一段内仍可调整', async () => {
  const effects = makeEffects(); const controller = makeController(effects);
  controller.applyFact({ type: 'queue-paused' });
  for (const inputId of ['B', 'C', 'D', 'E']) controller.applyFact({ type: 'input-accepted', input: { inputId, text: inputId, editRevision: 0 } });
  await controller.command({ type: 'beginEditInput', inputId: 'C' });
  const move = (inputId, overInputId) => controller.command({ type: 'reorderInput', inputId, overInputId, expectedInputIds: ['B', 'C', 'D', 'E'] });
  assert.equal((await move('D', 'B')).code, 'locked');
  assert.equal((await move('C', 'B')).code, 'locked');
  assert.equal((await move('E', 'D')).ok, true);
  assert.deepEqual(controller.getSnapshot().pending.map(i => i.inputId), ['B', 'C', 'E', 'D']);
  assert.equal(controller.getSnapshot().queuePaused, true, '排序不解除暂停');
  assert.equal(effects.runtime.starts.length, 0);
  await controller.command({ type: 'finishEditInput', inputId: 'C', cancel: true });
  controller.applyFact({ type: 'input-promoted', inputId: 'C', targetRunId: null, at: 1001 });
  assert.equal((await controller.command({ type: 'reorderInput', inputId: 'E', overInputId: 'B', expectedInputIds: ['B', 'C', 'E', 'D'] })).code, 'locked');
  controller.applyFact({ type: 'input-promoted', inputId: 'C', targetRunId: null, at: null });
  controller.applyFact({ type: 'input-locked', inputId: 'C' });
  controller.applyFact({ type: 'input-recovered', inputId: 'C', to: 'needs-review' });
  assert.equal((await controller.command({ type: 'reorderInput', inputId: 'E', overInputId: 'B', expectedInputIds: ['B', 'C', 'E', 'D'] })).code, 'locked');
});

test('060 排序保存失败如实报告；保留内存事实和新顺序，恢复快照不启动任务', async () => {
  const effects = makeEffects(); const controller = makeController(effects);
  controller.applyFact({ type: 'queue-paused' });
  for (const inputId of ['B', 'C']) controller.applyFact({ type: 'input-accepted', input: { inputId, text: inputId, editRevision: 0 } });
  const update = effects.store.update; effects.store.update = async () => { throw new Error('disk full'); };
  const result = await controller.command({ type: 'reorderInput', inputId: 'C', overInputId: 'B', expectedInputIds: ['B', 'C'] });
  assert.equal(result.ok, false); assert.equal(result.code, 'storage-failed');
  assert.deepEqual(controller.getSnapshot().pending.map(i => i.inputId), ['C', 'B']);
  effects.store.update = update;
  const restored = makeController(makeEffects()); restored.restore(controller.getSnapshot());
  assert.deepEqual(restored.getSnapshot().pending.map(i => i.inputId), ['C', 'B']);
  assert.equal(restored.getSnapshot().queuePaused, true);
});


test('060 用户移除并入：旧命令明确拒绝，排队消息、资料与当前运行保持原样', async () => {
  const effects = makeEffects(); const controller = makeController(effects);
  const active = controller.command({ type: 'send', input: { inputId: 'A', text: '当前任务' } });
  await settle(); effects.runtime.starts[0].resolve({}); await active;
  await controller.command({ type: 'send', input: { inputId: 'B', text: '排队内容', attachmentIds: ['file-B'], references: [{id:'ref-B'}] } });
  const before = controller.getSnapshot();
  const result = await controller.command({ type: 'mergeInput', inputId: 'B', expectedEditRevision: 0 });
  assert.deepEqual(result, { ok: false, code: 'unsupported' });
  assert.deepEqual(controller.getSnapshot(), before);
  assert.equal(effects.runtime.starts.length, 1);
  assert.equal(effects.runtime.stops.length, 0);
});

test('同一 inputId 在准备槽内并发重送只受理一次，不额外入队',async()=>{
  const effects=makeEffects(),controller=makeController(effects);
  const first=controller.command({type:'send',input:{inputId:'stable-workflow-request',text:'工作流',workflow:{invocationId:'inv-1'}}});
  await settle();
  assert.equal(controller.getSnapshot().phase,'preparing');
  const duplicate=await controller.command({type:'send',input:{inputId:'stable-workflow-request',text:'工作流',workflow:{invocationId:'inv-1'}}});
  assert.equal(duplicate.ok,true);
  assert.equal(controller.getSnapshot().pending.length,0);
  assert.equal(effects.runtime.starts.length,1);
  effects.runtime.starts[0].resolve({modelUsed:'mock'});await first;
});

test('结构化工作流撤回必须同步归属状态；失败留在队列，参数不能退化为文字编辑',async()=>{
  const effects=makeEffects(),controller=makeController(effects);let writes=0;
  effects.runtime.withdraw=async({input})=>{assert.equal(input.workflow.invocationId,'inv-withdraw');if(++writes===1)throw Error('disk full');};
  const active=controller.command({type:'send',input:{text:'当前任务'}});await settle();
  const queued=await controller.command({type:'send',input:{text:'工作流',workflow:{invocationId:'inv-withdraw'}}});
  assert.equal((await controller.command({type:'beginEditInput',inputId:queued.inputId})).code,'workflow-frozen');
  assert.equal((await controller.command({type:'withdrawInput',inputId:queued.inputId})).code,'storage-failed');
  assert.equal(controller.getSnapshot().pending[0].state,'pending');
  assert.equal((await controller.command({type:'withdrawInput',inputId:queued.inputId})).ok,true);
  assert.equal(controller.getSnapshot().pending.length,0);assert.equal(writes,2);assert.equal(effects.runtime.starts.length,1);
  effects.runtime.starts[0].resolve({});await active;
});
