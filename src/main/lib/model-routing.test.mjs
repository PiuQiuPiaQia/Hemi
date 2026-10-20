import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_SELECTION_ID,
  describeModelError,
  isSameCandidate,
  routeStopReason,
  RoutingStoppedError,
} from './model-routing.mjs';

const chat = { baseUrl: 'https://a.example/v1', apiKey: 'k1', model: 'model-a', name: 'A' };
const fallback = { baseUrl: 'https://b.example/v1', apiKey: 'k2', model: 'model-b', name: 'B' };

test('isSameCandidate：同端点同型号重复；不同端点的同名模型是不同候选', () => {
  assert.equal(isSameCandidate(chat, { ...chat }), true);
  assert.equal(isSameCandidate(chat, { baseUrl: chat.baseUrl, apiKey: '别的key', model: chat.model }), true);
  assert.equal(isSameCandidate(chat, { ...fallback }), false);
  assert.equal(isSameCandidate(chat, null), false);
  assert.equal(isSameCandidate(chat, { ...chat, baseUrl: `${chat.baseUrl}/chat/completions/` }), true);
  assert.equal(isSameCandidate(chat, { ...chat, baseUrl: 'https://b.example/v1' }), false);
  assert.equal(isSameCandidate(chat, { ...chat, api: 'anthropic-messages' }), false);
});

test('routeStopReason：无备用≠预算耗尽（no-fallback 独立于 budget-used），拒绝原因如实区分', () => {
  // 2026-10-08 会话审计：glm-5.3-flash 无备用连接错误被记成 budget-used，
  // 「预算已花」的说法进了用户可见的 outcomeReason——语义失真。
  assert.equal(routeStopReason({ hasFallback: false, fallbackUsed: false }), 'no-fallback');
  assert.equal(routeStopReason({ hasFallback: false, fallbackUsed: true }), 'no-fallback');
  assert.equal(routeStopReason({ hasFallback: true, fallbackUsed: true }), 'budget-used');
  assert.equal(routeStopReason({ hasFallback: true, fallbackUsed: false, outputStarted: true }), 'output-started');
  assert.equal(
    routeStopReason({ hasFallback: true, fallbackUsed: false, requireVision: true, fallbackSupportsVision: false }),
    'vision-missing',
  );
  assert.equal(
    routeStopReason({ hasFallback: true, fallbackUsed: false, fallbackDuplicate: true }),
    'duplicate-candidate',
  );
  assert.equal(routeStopReason({ hasFallback: true, fallbackUsed: false }), null);
});

test('RoutingStoppedError：终止错误带原因与原失败信息', () => {
  const error = new RoutingStoppedError('budget-used', '503 Service Unavailable');
  assert.match(error.message, /HEMI_ROUTING_STOPPED: budget-used/);
  assert.match(error.message, /503 Service Unavailable/);
  assert.equal(error.reason, 'budget-used');
});

test('describeModelError：进气泡／任务卡的路由内部码翻成人话，原失败信息保留在括号里，认不出的原样返回', () => {
  // 2026-10-19 会话审计：「回合未完成：HEMI_ROUTING_STOPPED: output-started（terminated）」原样上屏，
  // 用户看不懂、1h45m 后把同一句话原样重发才拿到回答。
  const raw = new RoutingStoppedError('output-started', 'terminated').message;
  const text = describeModelError(raw);
  assert.doesNotMatch(text, /HEMI_ROUTING_STOPPED|output-started/);
  assert.match(text, /输出过程中中断/);
  assert.doesNotMatch(text, /再发一遍|重试/, '已有工具副作用时不默认建议整轮重发');
  assert.match(text, /（底层报错：terminated）$/, '原失败信息要留给日志／审计对账');
  assert.equal(describeModelError('HEMI_ROUTING_STOPPED: no-fallback'), '模型请求失败，当前没有可用的备用模型');
  assert.match(describeModelError(new RoutingStoppedError('fallback-exhausted', '503')), /已尝试本轮可用的备用模型，仍未成功.*503/);
  assert.match(describeModelError(new RoutingStoppedError('budget-used', '503').message), /允许的备用尝试已用完.*（底层报错：503）/);
  assert.match(describeModelError(new RoutingStoppedError('vision-missing').message), /不支持本轮图片/);
  assert.match(describeModelError(new RoutingStoppedError('身份／权限或运行上限错误，不切备用', '401 Unauthorized').message), /^模型身份、权限或运行上限检查未通过，本轮未切换备用模型（底层报错：401 Unauthorized）$/);
  assert.match(describeModelError('Error: HEMI_ROUTING_STOPPED: output-started（连接断开（socket））'), /（底层报错：连接断开（socket））$/);
  assert.equal(describeModelError('HEMI_ROUTING_STOPPED: future-reason（503）'), 'HEMI_ROUTING_STOPPED: future-reason（503）');
  assert.equal(describeModelError('HEMI_ROUTING_STOPPED: toString'), 'HEMI_ROUTING_STOPPED: toString');
  assert.equal(describeModelError('Connection error.'), 'Connection error.');
  assert.equal(describeModelError(null), '');
});

test('AUTO_SELECTION_ID：保留值不与物理 modelKey 冲突（物理键必含 /）', () => {
  assert.equal(AUTO_SELECTION_ID, 'auto');
  assert.ok(!AUTO_SELECTION_ID.includes('/'));
});
