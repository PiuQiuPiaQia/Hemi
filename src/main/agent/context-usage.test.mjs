// 上下文容量快照纯函数单测：分类估算（两种方言的请求形状）＋快照组装
// （usage 锚点、压缩后未知态、无请求时不给分类）。接线（main-agent 暂存、
// 轮末广播）由主链路测试覆盖，这里只钉口径。
import assert from 'node:assert/strict';
import test from 'node:test';

import { breakdownOfRequestParams, buildContextSnapshot, CONTEXT_CATEGORIES } from './context-usage.mjs';

test('breakdownOfRequestParams：anthropic 方言——system/tools/对话/工具结果分桶', () => {
  const breakdown = breakdownOfRequestParams({
    system: [{ type: 'text', text: 'x'.repeat(400) }],
    tools: [{ name: 'read', description: 'y'.repeat(200) }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'z'.repeat(80) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(120) }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'b'.repeat(160) }] },
      { role: 'user', content: [{ type: 'text', text: 'c'.repeat(40) }] },
    ],
  });
  assert.ok(breakdown);
  assert.equal(breakdown.system, Math.ceil(JSON.stringify([{ type: 'text', text: 'x'.repeat(400) }]).length / 4));
  assert.equal(breakdown.tools, Math.ceil(JSON.stringify([{ name: 'read', description: 'y'.repeat(200) }]).length / 4));
  // 对话桶按块 JSON 字符估算（含块包装字符），与实现同口径。
  const textBlock = (text) => JSON.stringify([{ type: 'text', text }]).length;
  assert.equal(breakdown.conversation, Math.ceil((textBlock('z'.repeat(80)) + textBlock('a'.repeat(120)) + textBlock('c'.repeat(40))) / 4));
  assert.equal(breakdown.toolResults, Math.ceil(JSON.stringify([{ type: 'tool_result', content: 'b'.repeat(160) }]).length / 4));
  assert.equal(breakdown.estimated, breakdown.system + breakdown.tools + breakdown.conversation + breakdown.toolResults);
});

test('breakdownOfRequestParams：openai 方言——role=tool 与 system 消息也分桶', () => {
  const breakdown = breakdownOfRequestParams({
    messages: [
      { role: 'system', content: 's'.repeat(44) },
      { role: 'user', content: 'u'.repeat(12) },
      { role: 'tool', content: 't'.repeat(20) },
    ],
  });
  assert.ok(breakdown);
  assert.equal(breakdown.system, 11);
  assert.equal(breakdown.conversation, 3);
  assert.equal(breakdown.toolResults, 5);
  assert.equal(breakdown.tools, 0);
});

test('breakdownOfRequestParams：空参数不写零（null）', () => {
  assert.equal(breakdownOfRequestParams(null), null);
  assert.equal(breakdownOfRequestParams({}), null);
  assert.equal(breakdownOfRequestParams({ messages: [] }), null);
});

test('buildContextSnapshot：usage 锚点总量＋分类按比例缩放', () => {
  const snapshot = buildContextSnapshot({
    usage: { tokens: 51000, contextWindow: 1000000, percent: 5.1 },
    breakdown: { system: 1000, tools: 5000, conversation: 3000, toolResults: 1000, estimated: 10000 },
  });
  assert.ok(snapshot);
  assert.equal(snapshot.tokens, 51000);
  assert.equal(snapshot.contextWindow, 1000000);
  assert.equal(snapshot.percent, 5.1);
  assert.equal(snapshot.unknownReason, undefined);
  // 类目键与 CONTEXT_CATEGORIES 对齐；比例不受缩放影响。
  assert.deepEqual(snapshot.categories.map((category) => category.key), CONTEXT_CATEGORIES.map((category) => category.key));
  assert.equal(snapshot.categories[0].key, 'tools');
  assert.equal(snapshot.categories[0].percent, 50);
  const scaled = snapshot.categories.reduce((acc, category) => acc + category.tokens, 0);
  assert.ok(Math.abs(scaled - 51000) <= snapshot.categories.length);
});

test('buildContextSnapshot：压缩后未确认——tokens/percent 为 null，标 unknownReason', () => {
  const snapshot = buildContextSnapshot({
    usage: { tokens: null, contextWindow: 200000, percent: null },
    breakdown: { system: 1, tools: 1, conversation: 1, toolResults: 1, estimated: 4 },
  });
  assert.deepEqual(snapshot, { tokens: null, contextWindow: 200000, percent: null, categories: [], unknownReason: 'compaction' });
});

test('buildContextSnapshot：usage 缺失返回 null；无请求估算时不给分类', () => {
  assert.equal(buildContextSnapshot({ usage: undefined, breakdown: null }), null);
  assert.equal(buildContextSnapshot({ usage: { contextWindow: 0 }, breakdown: null }), null);
  const snapshot = buildContextSnapshot({ usage: { tokens: 300, contextWindow: 128000, percent: 0.2 }, breakdown: null });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.categories, []);
  assert.equal(snapshot.percent, 0.2);
});
