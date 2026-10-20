// 048 S5：会话用量聚合（口径、紧凑格式、来源筛选、缺用量计数、模型合并）。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateUsage,
  formatCompactTokens,
  formatPercent,
  usageEntryTotals,
} from './session-usage.ts';

function record(source, modelKey, overrides = {}) {
  return {
    source,
    modelKey,
    modelName: '供应商',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    genMs: 0,
    at: 1,
    ...overrides,
  };
}

test('formatCompactTokens：紧凑格式四段', () => {
  assert.equal(formatCompactTokens(250), '250');
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(58_100), '58.1k');
  assert.equal(formatCompactTokens(2_000), '2k');
  assert.equal(formatCompactTokens(123_456), '123k');
  assert.equal(formatCompactTokens(1_200_000), '1.2M');
  assert.equal(formatCompactTokens(12_000_000), '12M');
});

test('formatPercent：取整百分比、null 显示破折号', () => {
  assert.equal(formatPercent(0.707), '71%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(null), '—');
});

test('aggregateUsage：口径＝输入含缓存读写、输出含思考、TPS/命中率按合计', () => {
  const view = aggregateUsage([
    record('chat', 'p1/m1', { input: 100, output: 40, cacheRead: 60, cacheWrite: 0, genMs: 2000 }),
    record('chat', 'p1/m1', { input: 50, output: 10, cacheRead: 0, cacheWrite: 10, genMs: 1000 }),
  ]);
  assert.equal(view.totals.input, 100 + 60 + 50 + 10, '输入＝Σ(input＋cacheRead＋cacheWrite)');
  assert.equal(view.totals.output, 50);
  assert.equal(view.totals.tps, 50 / 3, 'TPS＝Σoutput ÷ ΣgenMs(秒)');
  assert.equal(view.totals.cacheHit, 60 / 220);
  assert.equal(view.totals.calls, 2);
  assert.equal(view.rows.length, 1, '同模型合并');
});

test('aggregateUsage：来源筛选——对话桶含 chat/fallback/summary/title，任务桶只 task', () => {
  const records = [
    record('chat', 'p1/m1', { input: 10, output: 1 }),
    record('fallback', 'p2/m2', { input: 20, output: 2 }),
    record('summary', 'p1/m1', { input: 30, output: 3 }),
    record('title', 'p1/m1', { input: 40, output: 4 }),
    record('task', 'p3/m3', { input: 500, output: 50, calls: 7 }),
  ];
  const chat = aggregateUsage(records, 'chat');
  assert.equal(chat.totals.input, 10 + 20 + 30 + 40);
  assert.equal(chat.rows.length, 2);
  assert.deepEqual(chat.rows[0].sources, ['chat']);

  const task = aggregateUsage(records, 'task');
  assert.equal(task.totals.input, 500);
  assert.equal(task.rows[0].calls, 7, '任务行按聚合的调用次数');
  assert.equal(task.overall.calls, 11, '表头按物理调用次数，不数聚合行');
  assert.equal(task.totals.calls, 7);
  assert.equal(chat.totals.calls, 4);
});

test('aggregateUsage：同一模型两侧都用过——「全部」合并一行、筛选各算各的', () => {
  const records = [
    record('chat', 'p1/glm', { input: 100, output: 10 }),
    record('task', 'p1/glm', { input: 200, output: 20, calls: 3 }),
  ];
  const all = aggregateUsage(records, 'all');
  assert.equal(all.rows.length, 1);
  assert.equal(all.rows[0].calls, 4);
  assert.deepEqual(all.rows[0].sources, ['chat', 'task']);

  assert.equal(aggregateUsage(records, 'chat').rows[0].calls, 1);
  assert.equal(aggregateUsage(records, 'task').rows[0].calls, 3);
});

test('aggregateUsage：缺用量计次不进数值；模型按总 tokens 降序', () => {
  const view = aggregateUsage([
    record('chat', 'p1/small', { input: 10, output: 5, missing: 0 }),
    record('task', 'p2/big', { input: 900, output: 100, calls: 2, missing: 3 }),
  ], 'all');
  assert.equal(view.rows[0].modelKey, 'p2/big');
  assert.equal(view.totals.missing, 3, '缺用量调用单独计数');
  assert.equal(view.overall.missing, 3);
});

test('usageEntryTotals：空记录返回 null（入口隐藏）', () => {
  assert.equal(usageEntryTotals([]), null);
  const totals = usageEntryTotals([
    record('chat', 'p1/m1', { input: 100, output: 40, cacheRead: 60 }),
  ]);
  assert.equal(totals.totalTokens, 200);
  assert.equal(totals.cacheHit, 60 / 160);
});

test('真实会话形状：6 条对话调用＋两份任务聚合＝99 次，筛选与明细同口径', () => {
  const records = [
    ...Array.from({ length: 6 }, () => record('chat', 'internal', { requestedModel: 'claude-sonnet-5-5', input: 1 })),
    record('task', 'deepseek-flash', { calls: 60, input: 1 }),
    record('task', 'deepseek-flash', { calls: 33, input: 1 }),
  ];
  const all = aggregateUsage(records);
  assert.equal(all.overall.calls, 99);
  assert.equal(all.totals.calls, all.rows.reduce((sum, row) => sum + row.calls, 0));
  assert.equal(aggregateUsage(records, 'chat').totals.calls, 6);
  assert.equal(aggregateUsage(records, 'task').totals.calls, 93);
  assert.equal(all.rows.find((row) => row.modelKey === 'internal').label, '供应商 · claude-sonnet-5-5');
});

test('按角色合并：同模型跨角色不混淆、同角色跨模型合并、未知归属不猜测', async () => {
  const { aggregateRoleUsage } = await import('./session-usage.ts');
  const rows = [
    record('chat', 'p/shared', { role: 'main', input: 100, output: 10, genMs: 1000 }),
    record('task', 'p/shared', { role: 'explorer', input: 200, output: 20, genMs: 2000 }),
    record('task', 'p/other', { role: 'explorer', input: 300, output: 30, genMs: 3000, calls: 2 }),
    record('title', 'p/shared', { role: 'auxiliary', input: 10, output: 2 }),
    record('task', 'p/shared', { input: 7, calls: 4, missing: 4 }),
  ];
  const view = aggregateRoleUsage(rows);
  assert.deepEqual(view.rows.map(row => row.role), ['main', 'explorer', 'auxiliary', 'unknown']);
  const explorer = view.rows.find(row => row.role === 'explorer');
  assert.equal(explorer.calls, 3);
  assert.equal(explorer.input, 500);
  assert.equal(explorer.output, 50);
  assert.equal(explorer.tps, 10);
  for (const field of ['calls', 'input', 'output', 'missing']) {
    assert.equal(view.rows.reduce((sum, row) => sum + row[field], 0), view.totals[field], `角色行与整体 ${field} 对账`);
  }
  assert.equal(view.rows.at(-1).calls, 4, '旧任务账本不能假定为执行角色');
});
