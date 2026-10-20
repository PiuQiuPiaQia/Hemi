// 057 AC-36/TC-057-012：可重复竞争时序矩阵（U 层，确定性种子调度）。
// 保留四组；原组1/2并入场景随060用户移除功能退役：
//   ③stop×ready/settled/迟到回执
//   ④用户发送×队列派发×后台报告  ⑤rewind×旧代次回执  ⑥订阅快照×补丁链（纯归约）
// 每组默认 100 条种子序列（HEMI_RACE_N 可调；HEMI_RACE_SEED="组:种子" 单跑一条）：
// 随机事件顺序＋随机微任务注入深度；每条序列断言统一不变量——单主运行、单输入消费、
// 终态不倒退、旧代次不污染、队列 FIFO/暂停语义。失败消息携带组号、种子与操作序列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationController } from './conversation-controller.mjs';
import { applyFlowChange, createFlowSnapshot } from '../../shared/conversation-flow.mjs';

const N = Number(process.env.HEMI_RACE_N ?? 100);
const ONLY = process.env.HEMI_RACE_SEED ?? null;

/** mulberry32：确定性 PRNG。 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 关闭当前运行：先结算在途 start（真实适配层 resolve→close 原子），再落收口事实。 */
const closeRun = (h, outcome = 'completed') => () => {
  const pending = h.runtime.starts.find((s) => !s.settled);
  if (pending) settleStart(pending, { modelUsed: 'mock-main', aborted: outcome === 'stopped' });
  const snap = h.controller.getSnapshot();
  const runId = snap.activeRunId ?? Object.keys(snap.runs ?? {}).at(-1);
  if (runId) {
    h.controller.applyFact({ type: 'run-settled', runId, at: 10 });
    h.controller.applyFact({ type: 'run-closed', runId, outcome, at: 11 });
  }
  return Promise.resolve();
};

const settle = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject, settled: false };
}
const settleStart = (d, value = { modelUsed: 'mock-main' }) => { d.settled = true; d.resolve(value); };

function makeHarness() {
  const runtime = {
    starts: [], stops: [],
    start(spec) { const d = deferred(); runtime.starts.push({ spec, ...d }); return d.promise; },
    stop() { runtime.stops.push(1); return Promise.resolve({ ok: true }); },
  };
  const store = { saves: 0, async update() { store.saves += 1; }, async flush() {} };
  let counter = 0;
  let clock = 1000;
  const controller = createConversationController({
    conversationId: 'conv-race',
    effects: { runtime, store },
    now: () => clock,
    makeId: (prefix) => `${prefix}-${++counter}`,
    tick: () => { clock += 1; },
  });
  return { runtime, store, controller };
}

const makeInput = (inputId, text = inputId) => ({
  inputId, editRevision: 0, text, inputSource: 'text', attachmentIds: [], references: null, createdAt: 1,
});

/** 每条序列结束后的统一不变量。 */
function invariants(h, tag) {
  const snap = h.controller.getSnapshot();
  const unresolved = h.runtime.starts.filter((s) => !s.settled).length;
  assert.equal(unresolved, 0, `${tag} 结束后仍有未决 start`);
  const delivered = [];
  for (const s of h.runtime.starts) delivered.push(s.spec?.envelope?.inputId);
  const dup = delivered.filter((id, i) => id && delivered.indexOf(id) !== i);
  assert.equal(dup.length, 0, `${tag} 同输入双消费 ${dup}`);
  for (const [id, run] of Object.entries(snap.runs ?? {})) {
    if (run.closedAt && run.outcome == null) assert.fail(`${tag} run ${id} closed 无终态`);
  }
  return snap;
}

/** 事件随机排序执行，事件间注入随机微任务深度。 */
async function drive(events, rand) {
  const order = [...events].sort(() => rand() - 0.5);
  const names = [];
  for (const { name, run } of order) {
    names.push(name);
    await run();
    await settle(1 + Math.floor(rand() * 3));
  }
  await settle(6);
  return names;
}

const seedLoop = async (group, body) => {
  for (let seed = 1; seed <= N; seed += 1) {
    if (ONLY && ONLY !== `${group}:${seed}`) continue;
    await body(seed, prng(seed * 7919 + group * 104729));
  }
};
const fire = (p) => { void p.catch(() => 'rejected'); };

test('AC-36 组3：stop×ready/settled/迟到回执＋新输入不受旧取消影响', async () => {
  await seedLoop(3, (seed, rand) => {
    const h = makeHarness();
    const tag = `G3#${seed}`;
    return (async () => {
      fire(h.controller.command({ type: 'send', input: makeInput('in-a3') }));
      await settle();
      const startA = h.runtime.starts.at(-1);
      const stop1 = async () => h.controller.command({ type: 'stop', reason: 'stop', targetRunId: h.controller.getSnapshot().activeRunId }).catch(() => ({ ok: false }));
      const ready = () => { settleStart(startA); return Promise.resolve(); };
      const closeStopped = closeRun(h, 'stopped');
      const names = await drive([
        { name: 'stop', run: stop1 },
        { name: 'ready', run: ready },
        { name: 'close-stopped', run: closeStopped },
        { name: 'dup-stop', run: stop1 },
      ], rand);
      const snap1 = invariants(h, tag);
      assert.ok(['idle', 'stopping'].includes(snap1.phase), `${tag} 相位异常 ${snap1.phase}（${names.join('→')}）`);
      const startsForA = h.runtime.starts.filter((s) => s.spec?.envelope?.inputId === 'in-a3');
      assert.ok(startsForA.length <= 1, `${tag} in-a3 二次 start（${names.join('→')}）`);
      // 新输入 J 正常受理并收口；旧 stop（目标失效）不污染
      fire(h.controller.command({ type: 'send', input: makeInput('in-j') }));
      await settle();
      const startJ = h.runtime.starts.find((s) => !s.settled);
      assert.ok(startJ && startJ.spec?.envelope?.inputId === 'in-j', `${tag} 新输入 J 未受理`);
      settleStart(startJ);
      await settle();
      const runJ = h.controller.getSnapshot().activeRunId;
      if (runJ) {
        h.controller.applyFact({ type: 'run-settled', runId: runJ, at: 30 });
        h.controller.applyFact({ type: 'run-closed', runId: runJ, outcome: 'completed', at: 31 });
      }
      const lateStop = await h.controller.command({ type: 'stop', reason: 'stop', targetRunId: 'run-stale' }).catch(() => ({ ok: false }));
      assert.equal(lateStop?.ok, false, `${tag} 旧 stop 应返回目标失效`);
      await settle();
      const snap2 = invariants(h, tag);
      assert.ok(snap2.runs?.[runJ]?.outcome !== 'stopped', `${tag} 旧取消污染新回合`);
    })();
  });
});

test('AC-36 组4：用户发送×队列派发×后台报告同到达', async () => {
  await seedLoop(4, (seed, rand) => {
    const h = makeHarness();
    const tag = `G4#${seed}`;
    return (async () => {
      fire(h.controller.command({ type: 'send', input: makeInput('in-a4') }));
      await settle();
      const startA = h.runtime.starts.at(-1);
      for (const id of ['in-q1', 'in-q2']) {
        fire(h.controller.command({ type: 'send', input: makeInput(id) }));
        await settle();
      }
      let maxConcurrent = 0;
      const tick = async () => {
        maxConcurrent = Math.max(maxConcurrent, h.runtime.starts.filter((s) => !s.settled).length);
        await settle(1);
      };
      const closeA = closeRun(h);
      const sendC = () => { fire(h.controller.command({ type: 'send', input: makeInput('in-c') })); return Promise.resolve(); };
      const report = () => { h.controller.poke(); return Promise.resolve(); };
      const names = await drive([
        { name: 'close-A', run: closeA },
        { name: 'send-C', run: sendC },
        { name: 'report', run: report },
        { name: 'tick', run: tick },
        { name: 'ready-A', run: () => { if (!startA.settled) settleStart(startA); return Promise.resolve(); } },
      ], rand);
      // 排空队列并记录派发顺序
      const dispatchOrder = [];
      for (let i = 0; i < 8; i += 1) {
        await settle();
        maxConcurrent = Math.max(maxConcurrent, h.runtime.starts.filter((s) => !s.settled).length);
        const pending = h.runtime.starts.find((s) => !s.settled);
        if (!pending) break;
        dispatchOrder.push(pending.spec?.envelope?.inputId);
        settleStart(pending);
        await settle();
        const rid = h.controller.getSnapshot().activeRunId;
        if (rid) {
          h.controller.applyFact({ type: 'run-settled', runId: rid, at: 50 });
          h.controller.applyFact({ type: 'run-closed', runId: rid, outcome: 'completed', at: 51 });
        }
      }
      await settle();
      const snap = invariants(h, tag);
      assert.ok(maxConcurrent <= 1, `${tag} 并发主运行 ${maxConcurrent}（${names.join('→')}）`);
      const qi = dispatchOrder.indexOf('in-q1');
      const q2i = dispatchOrder.indexOf('in-q2');
      if (qi >= 0 && q2i >= 0) assert.ok(qi < q2i, `${tag} FIFO 破坏 ${dispatchOrder}（${names.join('→')}）`);
      // 报告/新输入不吞队列：若仍挂起，q1/q2 必须仍在 pending（未被丢弃）
      const pendingIds = (snap.pending ?? []).map((p) => p.inputId);
      for (const id of ['in-q1', 'in-q2']) {
        const dispatched = dispatchOrder.includes(id);
        assert.ok(dispatched || pendingIds.includes(id), `${tag} ${id} 凭空消失（${names.join('→')}）`);
      }
    })();
  });
});

test('AC-36 组5：rewind×旧代次回执不污染', async () => {
  await seedLoop(5, (seed, rand) => {
    const h = makeHarness();
    const tag = `G5#${seed}`;
    return (async () => {
      fire(h.controller.command({ type: 'send', input: makeInput('in-a5') }));
      await settle();
      const startA = h.runtime.starts.at(-1);
      settleStart(startA);
      await settle();
      const runId = h.controller.getSnapshot().activeRunId;
      h.controller.applyFact({ type: 'run-settled', runId, at: 50 });
      h.controller.applyFact({ type: 'run-closed', runId, outcome: 'completed', at: 51 });
      await settle();
      fire(h.controller.command({ type: 'rewind', inputId: 'in-a5' }));
      await settle();
      const after = h.controller.getSnapshot();
      const oldGen = after.generation - 1;
      const names = await drive([
        { name: 'old-part', run: () => { h.controller.applyFact({ type: 'part-appended', runId, afterInputId: 'in-a5', generation: oldGen, part: { partId: `${runId}:late`, kind: 'text', content: '迟到增量' } }); return Promise.resolve(); } },
        { name: 'old-delivered', run: () => { h.controller.applyFact({ type: 'input-delivered', input: { inputId: 'in-z5', text: '旧投递', inputSource: 'text' }, runId, generation: oldGen, at: 52 }); return Promise.resolve(); } },
        { name: 'old-closed', run: () => { h.controller.applyFact({ type: 'run-closed', runId, outcome: 'completed', generation: oldGen, at: 53 }); return Promise.resolve(); } },
      ], rand);
      const final = invariants(h, tag);
      assert.ok(final.revision >= after.revision, `${tag} revision 倒退（${names.join('→')}）`);
      assert.ok(!JSON.stringify(final.timeline ?? []).includes('迟到增量'), `${tag} 旧代次增量混入（${names.join('→')}）`);
      assert.ok(!(final.timeline ?? []).some((item) => item.kind === 'user' && item.text === '旧投递'), `${tag} 旧投递复活（${names.join('→')}）`);
    })();
  });
});

test('AC-36 组6：订阅快照×补丁链（缺口 stale 判定，纯归约）', async () => {
  await seedLoop(6, (seed, rand) => {
    const tag = `G6#${seed}`;
    return (async () => {
      let snap = createFlowSnapshot({ conversationId: 'c6' });
      snap.revision = 10;
      const names = [];
      for (const step of ['p11', 'p11dup', 'p13', 'oldsnap', 'bump'].sort(() => rand() - 0.5)) {
        names.push(step);
        if (step === 'p11' || step === 'p11dup') {
          const r = applyFlowChange(snap, { kind: 'patch', patch: { kind: 'meta', meta: { revision: 11 } }, baseRevision: 10 });
          if (r.ok) snap = r.snapshot;
        } else if (step === 'p13') {
          const r = applyFlowChange(snap, { kind: 'patch', patch: { kind: 'meta', meta: { revision: 13 } }, baseRevision: 12 });
          if (r.ok) snap = r.snapshot;
        } else if (step === 'oldsnap') {
          const r = applyFlowChange(snap, { kind: 'snapshot', snapshot: { ...snap, revision: 9 } });
          if (r.ok) snap = r.snapshot;
        } else {
          const r = applyFlowChange(snap, { kind: 'snapshot', snapshot: { ...snap, generation: (snap.generation ?? 1) + 1, revision: 20 } });
          if (r.ok) snap = r.snapshot;
        }
        await settle(1);
      }
      assert.ok(snap.revision >= 10, `${tag} revision 倒退（${names.join('→')}）：${snap.revision}`);
      assert.ok(snap.revision <= 20, `${tag} revision 越界（${names.join('→')}）：${snap.revision}`);
    })();
  });
});
