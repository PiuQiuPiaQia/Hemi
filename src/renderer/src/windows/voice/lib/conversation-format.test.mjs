import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanTitleSource,
  displayTitle,
  formatRelative,
  groupByRecency,
  pickRecent,
  recencyKey,
  reorderWithinGroup,
} from './conversation-format.ts';

test('formatRelative：各级相对时间', () => {
  assert.equal(formatRelative(0), '—');
});

test('cleanTitleSource：摘掉开头语气词与顿逗', () => {
  assert.equal(cleanTitleSource('呃，今天天气怎么样呢？今天北京的天气。'), '今天天气怎么样呢？今天北京的天气。');
  assert.equal(cleanTitleSource('嗯 那个 帮我整理下载文件夹'), '帮我整理下载文件夹');
  assert.equal(cleanTitleSource('然后、把会议改到三点'), '把会议改到三点');
  assert.equal(cleanTitleSource('正常开头的消息不动'), '正常开头的消息不动');
  assert.equal(cleanTitleSource('呃呃，连续语气词只摘一层'), '呃呃，连续语气词只摘一层');
});

// ---- 026 侧栏可读性：displayTitle 展示层清理 ----
test('026 displayTitle：URL 收成「链接」，语气词与空白清理，空结果回退原文', () => {
  assert.equal(displayTitle('下载 https://github.com/a/b/tree/main 里面的文件'), '下载 链接 里面的文件');
  assert.equal(displayTitle('呃，今天天气怎么样'), '今天天气怎么样');
  assert.equal(displayTitle('  在ssd的对应目\t录  创建  '), '在ssd的对应目 录 创建');
  assert.equal(displayTitle('https://only-url.example.com/x'), '链接');
  assert.equal(displayTitle('正常标题'), '正常标题');
  assert.equal(displayTitle('  '), '  ');
});

// —— P1 侧栏时间分组 ——
const NOW = new Date(2026, 9, 8, 15, 0).getTime();
const at = (daysAgo, hour = 10) => new Date(2026, 9, 8 - daysAgo, hour, 0).getTime();

test('P1 recencyKey：今天 / 昨天 / 7 天内 / 更早按自然日切', () => {
  assert.equal(recencyKey(at(0, 0), NOW), 'today');
  assert.equal(recencyKey(at(1, 23), NOW), 'yesterday');
  assert.equal(recencyKey(at(1, 0), NOW), 'yesterday');
  assert.equal(recencyKey(at(2), NOW), 'week');
  assert.equal(recencyKey(at(6), NOW), 'week');
  assert.equal(recencyKey(at(7), NOW), 'earlier');
  assert.equal(recencyKey(0, NOW), 'earlier'); // 损坏行无时间
});

test('P1 groupByRecency：固定组序、组内保持传入（手动）顺序、空组不出', () => {
  const list = [
    { id: 'a', updatedAt: at(3) },
    { id: 'b', updatedAt: at(0) },
    { id: 'c', updatedAt: at(0, 8) },
    { id: 'd', updatedAt: at(30) },
  ];
  const groups = groupByRecency(list, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['今天', '7 天内', '更早']);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['b', 'c']);
});

test('P1 pickRecent：按更新时间取集合，顺序沿用传入序', () => {
  const list = [
    { id: 'old', updatedAt: 1 },
    { id: 'x', updatedAt: 5 },
    { id: 'y', updatedAt: 9 },
  ];
  assert.deepEqual(pickRecent(list, 2).map((s) => s.id), ['x', 'y']);
});

test('P1 reorderWithinGroup：组员填回原位、组外不动、跨组拒绝', () => {
  const all = ['a', 'x', 'b', 'y', 'c'];
  assert.deepEqual(reorderWithinGroup(all, ['a', 'b', 'c'], 'c', 'a'), ['c', 'x', 'a', 'y', 'b']);
  assert.equal(reorderWithinGroup(all, ['a', 'b', 'c'], 'a', 'x'), null);
  assert.equal(reorderWithinGroup(all, ['a', 'b'], 'a', 'a'), null);
});
