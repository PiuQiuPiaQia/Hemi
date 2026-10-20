// 057 AC-25 负载基准（纯归约层，无 Electron）：1000 个文本增量 + 结构变化的
// 归约/补丁应用/序列化耗时与最坏单步耗时（主进程同步段不得 ≥250ms）。
// 运行：node scripts/bench-057-flow.mjs（exit 0＝基准内）
import { applyFlowFact, createFlowSnapshot, applyFlowChange, FLOW_SCHEMA_VERSION } from '../src/shared/conversation-flow.mjs';

const now = Date.now();
let snapshot = createFlowSnapshot({ conversationId: 'bench' });
snapshot = applyFlowFact(snapshot, { type: 'run-preparing', runId: 'run-bench', source: 'user', inputIds: ['in-b'], at: now }).snapshot;
snapshot = applyFlowFact(snapshot, { type: 'run-started', runId: 'run-bench', at: now }).snapshot;

// 1000 个文本增量（累计内容替换口径）。
let worstStepMs = 0;
const reduceStarted = performance.now();
for (let i = 1; i <= 1000; i += 1) {
  const stepStarted = performance.now();
  const fact = i === 1
    ? { type: 'part-appended', runId: 'run-bench', part: { partId: 'p1', kind: 'text', content: `字${i}` } }
    : { type: 'part-updated', runId: 'run-bench', partId: 'p1', patch: { content: `字${i}` } };
  const result = applyFlowFact(snapshot, fact);
  if (i > 1 && !result.applied && result.dropped === 'no-op') continue; // 同值不空转
  snapshot = result.snapshot;
  worstStepMs = Math.max(worstStepMs, performance.now() - stepStarted);
}
const reduceMs = performance.now() - reduceStarted;

// 补丁链回放（客户端口径）：模拟 20 条补丁（每条含 50 次累计的最终值）。
let client = createFlowSnapshot({ conversationId: 'bench' });
const replayStarted = performance.now();
for (let chunk = 1; chunk <= 20; chunk += 1) {
  const change = {
    kind: 'patch', conversationId: 'bench', generation: 1,
    baseRevision: client.revision, revision: client.revision + 1,
    changes: [{ kind: 'item-updated', item: { itemId: 'i1', kind: 'assistant', runId: 'run-bench', afterInputId: null, parts: [{ partId: 'p1', kind: 'text', content: `块${chunk}` }] } }],
  };
  const applied = applyFlowChange(client, change);
  if (!applied.ok) throw new Error(`补丁 ${chunk} 失败：${applied.code}`);
  client = applied.snapshot;
}
const replayMs = performance.now() - replayStarted;

// 序列化（flow-store 落盘体）。
const serializeStarted = performance.now();
const payload = JSON.stringify({ id: 'bench', schemaVersion: FLOW_SCHEMA_VERSION, flow: snapshot });
const serializeMs = performance.now() - serializeStarted;

const BUDGET = { worstStepMs: 50, perReduceMs: 2, serializeMs: 250 };
const perReduceMs = reduceMs / 1000;
const ok = worstStepMs < BUDGET.worstStepMs && perReduceMs < BUDGET.perReduceMs && serializeMs < BUDGET.serializeMs;
console.log(`HEMI_BENCH_057=${JSON.stringify({
  ok,
  worstStepMs: Number(worstStepMs.toFixed(2)),
  perReduceMs: Number(perReduceMs.toFixed(3)),
  replay20PatchesMs: Number(replayMs.toFixed(2)),
  serializeMs: Number(serializeMs.toFixed(2)),
  payloadKB: Number((payload.length / 1024).toFixed(0)),
  budget: BUDGET,
})}`);
process.exit(ok ? 0 : 1);
