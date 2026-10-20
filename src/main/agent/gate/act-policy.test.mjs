// 021 act-policy 单测：双置信度、地板豁免、阈值防御、进展签名、执行事实、错误分类。
// 这些判定原先内联在 pi-browser 循环里没法直测——review 基线的四个 P1/P2 全在这里收口。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_FLOOR,
  DEFAULT_PASS,
  FLOOR_EXEMPT_OPS,
  JEV_ERROR_ADVICE,
  aggregateActionState,
  classifyJevError,
  effectiveConfidence,
  isFloorExempt,
  isSideEffect,
  isStableSequence,
  nextClickRepeat,
  progressSignature,
  resolveThresholds,
  snapIdentity,
  validConf,
} from './act-policy.mjs';

test('validConf：缺失/NaN/越界一律 null，0 与 1 合法（AC-05）', () => {
  assert.equal(validConf(0.42), 0.42);
  assert.equal(validConf(0), 0);
  assert.equal(validConf(1), 1);
  for (const bad of [null, undefined, NaN, Infinity, -0.1, 1.01, '0.9', true]) {
    assert.equal(validConf(bad), null, `应拒绝：${String(bad)}`);
  }
});

test('effectiveConfidence：目标动作取双置信最小值，目标缺失即无执行资格', () => {
  assert.equal(
    effectiveConfidence({ operationConfidence: 0.99, targetConfidence: 0.1, target: 3 }),
    0.1,
    'review 基线 P1：操作 0.99 / 目标 0.1 不得直通',
  );
  assert.equal(
    effectiveConfidence({ operationConfidence: 0.2, targetConfidence: 0.95, target: 3 }),
    0.2,
  );
  // 目标置信度缺失/非法 → null（不得自动执行）。
  assert.equal(effectiveConfidence({ operationConfidence: 0.99, targetConfidence: null, target: 3 }), null);
  assert.equal(effectiveConfidence({ operationConfidence: 0.99, targetConfidence: NaN, target: 3 }), null);
  assert.equal(effectiveConfidence({ operationConfidence: 0.99, target: 3 }), null);
  // 无目标动作只看操作值。
  assert.equal(effectiveConfidence({ operationConfidence: 0.55, target: null }), 0.55);
  assert.equal(effectiveConfidence({ operationConfidence: NaN, target: null }), null);
});

test('豁免清单：WAIT/滚动豁免且只作用于无副作用操作（2026-09-21 裁决）', () => {
  assert.deepEqual([...FLOOR_EXEMPT_OPS].sort(), ['SCROLL_DOWN', 'SCROLL_UP', 'WAIT']);
  for (const op of FLOOR_EXEMPT_OPS) assert.ok(isFloorExempt(op));
  for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT', 'DONE', 'BLOCKED']) {
    assert.equal(isFloorExempt(op), false, `${op} 不应豁免`);
  }
  for (const op of FLOOR_EXEMPT_OPS) assert.equal(isSideEffect(op), false);
  for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT']) assert.ok(isSideEffect(op));
});

test('resolveThresholds：非法配置回默认值，合法配置照用', () => {
  assert.deepEqual(resolveThresholds(), { pass: DEFAULT_PASS, floor: DEFAULT_FLOOR });
  assert.deepEqual(resolveThresholds('0.8', '0.5'), { pass: 0.8, floor: 0.5 });
  // 字符串数字与环境变量形态。
  assert.deepEqual(resolveThresholds('abc', 'x'), { pass: DEFAULT_PASS, floor: DEFAULT_FLOOR });
  // FLOOR ≥ PASS 反了 → 回默认。
  assert.deepEqual(resolveThresholds(0.3, 0.6), { pass: DEFAULT_PASS, floor: DEFAULT_FLOOR });
  assert.deepEqual(resolveThresholds(0.7, 0.7), { pass: DEFAULT_PASS, floor: DEFAULT_FLOOR });
  assert.deepEqual(resolveThresholds(1.2, 0.4), { pass: DEFAULT_PASS, floor: DEFAULT_FLOOR });
});

test('progressSignature：内容摘要/滚动位置参与，元素数量不再当内容', () => {
  const base = { title: 't', url: 'u', digest: 'aaa', scrollY: 0 };
  const decision = { op: 'CLICK', target: 3 };
  const sig = progressSignature(base, decision);
  // 翻页（内容变、元素数量恰好相同）：摘要变 → 签名变 → 不误熔断（R-10）。
  assert.notEqual(sig, progressSignature({ ...base, digest: 'bbb' }, decision));
  // 滚动：位置变 → 签名变。
  assert.notEqual(sig, progressSignature({ ...base, scrollY: 600 }, decision));
  // 同内容同决策：签名相同 → 才累加无进展。
  assert.equal(sig, progressSignature({ ...base }, { op: 'CLICK', target: 3 }));
  // 决策变化也计入签名。
  assert.notEqual(sig, progressSignature(base, { op: 'CLICK', target: 4 }));
});

test('snapIdentity/isStableSequence：有界轮询里只有最后两个相同才算稳定（R-08）', () => {
  const snap = { title: 't', url: 'u', digest: 'a', scrollY: 0, evidence: { digest: 'e' } };
  const id = snapIdentity(snap);
  assert.equal(isStableSequence([id]), false, '一张快照无从谈稳定');
  assert.equal(isStableSequence([id, id]), true);
  assert.equal(isStableSequence([id, snapIdentity({ ...snap, digest: 'b' }), snapIdentity({ ...snap, digest: 'b' })]), true);
  assert.equal(isStableSequence([id, snapIdentity({ ...snap, digest: 'b' })]), false);
  // 证据变化也算画面变化（结果正文进核验）。
  assert.notEqual(id, snapIdentity({ ...snap, evidence: { digest: 'e2' } }));
});

test('aggregateActionState：终态与执行事实独立（R-09）', () => {
  const clickOk = { op: 'CLICK', receipt: 'ok', status: 'ok' };
  // 有成功副作用、终态非 done → partially-executed（不再是 not-executed）。
  assert.equal(aggregateActionState([clickOk], 'circuit-no-progress'), 'partially-executed');
  assert.equal(aggregateActionState([clickOk, { op: 'CLICK', receipt: null, status: 'stale' }], 'error'), 'partially-executed');
  // 回执丢失优先：不能假装知道结果。
  assert.equal(aggregateActionState([clickOk, { op: 'CLICK', status: 'dispatched-unknown' }], 'error'), 'dispatched-unknown');
  // 一步都没发出过副作用动作才是 not-executed。
  assert.equal(aggregateActionState([], 'error'), 'not-executed');
  assert.equal(aggregateActionState([{ op: 'WAIT', status: 'ok' }], 'circuit-wait'), 'not-executed');
  // done 且有副作用 → executed。
  assert.equal(aggregateActionState([clickOk], 'done'), 'executed');
});

test('nextClickRepeat：同目标 + 页面无变化累加，换目标/换操作/页面变化清零（0.2.2 复盘）', () => {
  // 真机实录（task-1-mucq6hjn）：同一排序项连点 5 次、页面摘要一字未变。
  const first = nextClickRepeat(null, { op: 'CLICK', target: 59, digest: 'd1' });
  assert.deepEqual(first, { target: 59, digest: 'd1', repeats: 0 }, '首点只记态不计数');
  const second = nextClickRepeat(first, { op: 'CLICK', target: 59, digest: 'd1' });
  assert.equal(second.repeats, 1, '同目标第 2 次且页面无变化 → repeats 1（调用方在派发前停段）');
  // 页面变了（点击生效）→ 清零，合法的再次点击不受影响。
  assert.equal(nextClickRepeat(first, { op: 'CLICK', target: 59, digest: 'd2' }).repeats, 0);
  // 换目标 → 清零。
  assert.equal(nextClickRepeat(first, { op: 'CLICK', target: 60, digest: 'd1' }).repeats, 0);
  // 换操作 → 清零（且不保留 CLICK 态）。
  assert.deepEqual(
    nextClickRepeat(second, { op: 'TYPE_TEXT', target: 2, digest: 'd1' }),
    { target: null, digest: null, repeats: 0 },
  );
  // 无目标动作 → 清零。
  assert.equal(nextClickRepeat(second, { op: 'WAIT', target: null, digest: 'd1' }).repeats, 0);
});

test('classifyJevError：HTTP 错误分类清楚，认证类带直接兜底建议（R-03/R-05）', () => {
  assert.equal(classifyJevError('Jev 调用失败 HTTP 401：Authentication failed'), 'auth');
  assert.equal(classifyJevError('Jev 调用失败 HTTP 403：forbidden'), 'auth');
  assert.equal(classifyJevError('Jev 调用失败 HTTP 429：Rate limited'), 'rate-limit');
  assert.equal(classifyJevError('Jev 调用失败 HTTP 500：boom'), 'server');
  assert.equal(classifyJevError('Jev 调用失败 HTTP 400：bad request'), 'bad-request');
  assert.equal(classifyJevError('Jev 请求失败：fetch failed'), 'network');
  assert.equal(classifyJevError('什么都不是'), 'unknown');
  for (const kind of ['auth', 'rate-limit', 'server', 'bad-request', 'network', 'unknown']) {
    assert.ok(JEV_ERROR_ADVICE[kind].includes('browser_click'), `${kind} 的建议应指向原工具兜底`);
  }
  assert.match(JEV_ERROR_ADVICE.auth, /不要重试 browser_act/);
});

test('classifyJevError：「未配置」归 auth——key 缺失不该引导原样重试', () => {
  assert.equal(classifyJevError('Jev API Key 未配置，请先粘贴并保存。'), 'auth');
});
