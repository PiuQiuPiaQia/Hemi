import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoutingExtension, resetRoutingForApplicationTurn, settledRoutingError } from './pi-factory.mjs';
import { describeModelError } from '../lib/model-routing.mjs';

/** 只取 route 闭包：假 pi 记下注册的虚拟模型，modelRegistry.find 回传「provider/model」字符串。 */
function routerOf({ withoutFallback = false, extraFallbacks = [] } = {}) {
  const runtime = { state: { slot: 'primary', fallbackUsed: false } };
  const execution = {
    modelKey: 'p/main', name: 'P', model: 'main-m', api: 'anthropic-messages',
    baseUrl: 'https://a', apiKey: 'k', thinkingLevel: 'default',
  };
  const fallback = {
    modelKey: 'q/fb', name: 'Q', model: 'fb-m', api: 'openai-completions',
    baseUrl: 'https://b', apiKey: 'k2', thinkingLevel: 'default',
  };
  const routing = { execution, fallback: withoutFallback ? null : fallback,
    ...(extraFallbacks.length ? { fallbacks: [fallback, ...extraFallbacks] } : {}) };
  let virtual = null;
  const pi = {
    registerProvider: () => {},
    registerVirtualModel: (definition) => { virtual = definition; },
  };
  createRoutingExtension({ routing, runtime }).factory(pi);
  const ctx = { modelRegistry: { find: (provider, model) => `${provider}/${model}` } };
  return { route: (request) => virtual.route(request, ctx), runtime, routing };
}

const failure = { message: { stopReason: 'error', errorMessage: '503 service_unavailable', content: [] } };

test('SDK 预算先耗尽时按实际候选说明失败，未走完候选／取消／已有明确原因不改写', () => {
  const raw = '503 service_unavailable', routing = { fallback: {} };
  assert.match(settledRoutingError(raw, { routing, state: { slot: 'fallback' } }), /HEMI_ROUTING_STOPPED: fallback-exhausted/);
  assert.equal(settledRoutingError(raw, { routing, state: { slot: 'primary' } }), raw);
  assert.equal(settledRoutingError(raw, { routing: { fallbacks: [{}, {}] }, state: { candidateIndex: 1 } }), raw);
  assert.equal(settledRoutingError(raw, { routing, state: { slot: 'fallback' }, aborted: true }), raw);
  assert.match(settledRoutingError(raw, { routing: null }), /HEMI_ROUTING_STOPPED: no-fallback/);
  assert.match(settledRoutingError('terminated', { routing, state: { slot: 'fallback' }, outputStarted: true }), /HEMI_ROUTING_STOPPED: output-started/);
  assert.equal(settledRoutingError('401 Unauthorized', { routing, state: { slot: 'fallback' } }), '401 Unauthorized');
  assert.equal(settledRoutingError('429 insufficient_quota', { routing: null }), '429 insufficient_quota');
  const explicit = 'HEMI_ROUTING_STOPPED: output-started（terminated）';
  assert.equal(settledRoutingError(explicit, { routing, state: { slot: 'fallback' } }), explicit);
  assert.equal(settledRoutingError(null, { routing, state: { slot: 'fallback' } }), null);
});

test('056/057 备用路由：回合内切备用不回跳；SDK user 理由不再重置；宿主回合重置才回主模型', () => {
  const { route, runtime, routing } = routerOf();
  const r1 = route({ reason: 'user', state: undefined });
  assert.equal(r1.model, 'hemi/main-m');
  const r2 = route({ reason: 'retry', state: r1.state, failed: failure });
  assert.equal(r2.model, 'hemi-fallback/fb-m');
  assert.deepEqual(r2.state, { slot: 'fallback', fallbackUsed: true, candidateIndex: 1, epoch: 0 });
  // 同一回合的后续请求（工具结果之后）仍用备用。
  const r3 = route({ reason: 'continuation', state: r2.state });
  assert.equal(r3.model, 'hemi-fallback/fb-m');
  // 057（AC-32，探针 B6a/B6b）：并入（steer 消化）产生的新 turn 也是 reason=user——
  // 路由层不得据此重置，否则同一应用运行内的并入被拉回主模型。
  const r4 = route({ reason: 'user', state: r3.state });
  assert.equal(r4.model, 'hemi-fallback/fb-m', 'SDK user 理由不再重置备用');
  assert.deepEqual(r4.state, { slot: 'fallback', fallbackUsed: true, candidateIndex: 1, epoch: 0 });
  // 宿主在新的应用回合边界（prompt）显式重置：回主模型、备用机会恢复、切换留痕。
  const routes = [];
  const switched = resetRoutingForApplicationTurn({ routing, runtime, onRoute: (event) => routes.push(event) });
  assert.equal(switched, true);
  assert.deepEqual(routes, [{ to: { modelKey: 'p/main', name: 'P', model: 'main-m' }, fallbackUsed: false }]);
  const r5 = route({ reason: 'user', state: undefined });
  assert.equal(r5.model, 'hemi/main-m');
  assert.deepEqual(r5.state, { slot: 'primary', fallbackUsed: false, epoch: 1 });
  // 回归（main-agent 实测钓出）：SDK 会把上一回合的备用 state 原样回传——
  // epoch 旧代的 state 必须被宿主重置冲掉，不能把新回合又拉回备用。
  const stale = route({ reason: 'user', state: { slot: 'fallback', fallbackUsed: true, candidateIndex: 1, epoch: 0 } });
  assert.equal(stale.model, 'hemi/main-m', '旧代 state 作废');
  // 新回合里再失败，仍能用一次备用。
  const r6 = route({ reason: 'retry', state: stale.state, failed: failure });
  assert.equal(r6.model, 'hemi-fallback/fb-m');
});

test('宿主回合重置：本就在主模型时不动、不虚发切换事件；已在备用时回主模型', () => {
  {
    const { runtime, routing } = routerOf();
    const routes = [];
    assert.equal(resetRoutingForApplicationTurn({ routing, runtime, onRoute: (e) => routes.push(e) }), false);
    assert.equal(routes.length, 0);
    assert.deepEqual(runtime.state, { slot: 'primary', fallbackUsed: false });
  }
  {
    const { runtime, routing } = routerOf();
    runtime.state = { slot: 'fallback', fallbackUsed: true };
    assert.equal(resetRoutingForApplicationTurn({ routing, runtime }), true);
    assert.deepEqual(runtime.state, { slot: 'primary', fallbackUsed: false });
  }
});

test('恢复的备用 epoch 与新实例相同时，手动重试首请求仍用主模型；direct 不消费重置边界', () => {
  const { route, runtime, routing } = routerOf();
  resetRoutingForApplicationTurn({ routing, runtime });
  const archived = { slot: 'fallback', fallbackUsed: true, candidateIndex: 1, epoch: 1 };
  assert.equal(route({ reason: 'direct' }).model, 'hemi/main-m');
  const first = route({ reason: 'retry', state: archived, failed: failure });
  assert.equal(first.model, 'hemi/main-m', '旧失败不能触发新应用回合的自动降级');
  assert.deepEqual(first.state, { slot: 'primary', fallbackUsed: false, epoch: 1 });
  const automatic = route({ reason: 'retry', state: first.state, failed: failure });
  assert.equal(automatic.model, 'hemi-fallback/fb-m', '本次主请求失败后仍可自动降级');
  assert.equal(route({ reason: 'user', state: automatic.state }).model, 'hemi-fallback/fb-m', '同一运行内并入沿用当前模型');
});

test('备用已用过的回合里再失败：路由拒绝（不来回跳）', () => {
  const { route } = routerOf();
  const r1 = route({ reason: 'retry', state: { slot: 'primary', fallbackUsed: false }, failed: failure });
  assert.throws(() => route({ reason: 'retry', state: r1.state, failed: failure }), error => {
    assert.equal(error.reason, 'fallback-exhausted');
    assert.match(describeModelError(error), /已尝试本轮可用的备用模型/);
    assert.doesNotMatch(describeModelError(error), /没有.*备用/);
    return true;
  });
});

test('未配备用与候选链耗尽分别说明原因，多候选仍按冻结顺序向前切换', () => {
  const empty = routerOf({ withoutFallback: true });
  assert.throws(() => empty.route({ reason: 'retry', failed: failure }), error => {
    assert.equal(error.reason, 'no-fallback');
    assert.match(describeModelError(error), /当前模型请求失败，本轮未切换模型/);
    return true;
  });
  const { route } = routerOf({ extraFallbacks: [{ modelKey: 'r/last', model: 'last-m',
    api: 'openai-completions', baseUrl: 'https://last/v1', apiKey: 'k3' }] });
  const first = route({ reason: 'retry', failed: failure });
  const second = route({ reason: 'retry', state: first.state, failed: failure });
  assert.equal(second.model, 'hemi-fallback-2/last-m', '已经切过备用仍能使用后续允许候选');
  assert.throws(() => route({ reason: 'retry', state: second.state, failed: failure }),
    error => error.reason === 'fallback-exhausted');
});

test('生产 route：上下文溢出重试保留当前主／备用槽位和备用机会', () => {
  const { route } = routerOf();
  const failed = { message: { stopReason: 'error', errorMessage: '400 context_length_exceeded maximum context length exceeded', content: [] } };
  for (const state of [{ slot: 'primary', fallbackUsed: false }, { slot: 'fallback', fallbackUsed: true }]) {
    const before = route({ reason: 'user', state });
    const after = route({ reason: 'retry', state: before.state, failed });
    assert.equal(after.model, before.model);
    assert.deepEqual(after.state, before.state);
  }
});
