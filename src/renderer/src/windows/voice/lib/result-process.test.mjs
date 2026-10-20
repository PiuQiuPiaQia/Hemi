import assert from 'node:assert/strict';
import test from 'node:test';
import { elapsedClock, readableUrls, resultStepsOf, verifySummaryOf } from './result-process.ts';

test('时间列是距开始的用时（稿 00:04），不是钟点', () => {
  assert.equal(elapsedClock(4_200), '00:04');
  assert.equal(elapsedClock(346_000), '05:46');
  assert.equal(elapsedClock(3_723_000), '1:02:03');
  assert.equal(elapsedClock(-5), '00:00');
});

test('步骤句：去「已完成：」前缀、单步耗时降为尾注、网址解码去协议头', () => {
  const steps = [
    { key: 'a', title: '已完成', detail: '查看任务标签页（33.1s）', at: 1_000 + 37_000, running: false, attention: false },
    { key: 'b', title: '已完成', detail: '打开网页 https://www.bing.com/search?q=API%E4%B8%AD%E8%BD%AC%E7%AB%99+%E7%（226ms）', at: 1_000 + 96_000, running: false, attention: false },
    { key: 'c', title: '操作未执行', detail: '截图', at: 1_000 + 120_000, running: false, attention: true },
    { key: 'd', title: '收尾判定已接收', detail: '', at: 1_000 + 346_000, running: false, attention: false },
  ];
  assert.deepEqual(resultStepsOf(steps, 1_000), [
    { key: 'a', time: '00:37', text: '查看任务标签页', note: '33.1s', attention: false },
    { key: 'b', time: '01:36', text: '打开网页 bing.com/search?q=API中转站+%E7%', note: '226ms', attention: false },
    { key: 'c', time: '02:00', text: '操作未执行：截图', note: '', attention: true },
    { key: 'd', time: '05:46', text: '收尾判定已接收', note: '', attention: false },
  ]);
});

test('网址读法：根路径不留斜杠，中文路径解码', () => {
  assert.equal(readableUrls('打开网页 https://302.ai/'), '打开网页 302.ai');
  assert.equal(readableUrls('读 https://runapi.ai/zh-CN 页'), '读 runapi.ai/zh-CN 页');
  assert.equal(readableUrls('https://example.com/%E4%B8%AD%E6%96%87/a'), 'example.com/中文/a');
});

test('核验摘要一句话：结论＋数量，不铺证据全文', () => {
  assert.deepEqual(
    verifySummaryOf({ verdict: 'partial', evidence: ['10 条关键断言已重开页面逐条核对'], unchecked: ['CometAPI 未核实'], at: 1 }),
    { label: '核验：部分完成', text: '10 条关键断言已重开页面逐条核对；未核实 1 项。' },
  );
  assert.deepEqual(
    verifySummaryOf({ verdict: 'complete', evidence: ['甲。', '乙', '丙', '丁'], unchecked: ['备注：一', '备注：二'], at: 1 }),
    { label: '核验：完成', text: '已核对 4 条依据；未核实 2 项。' },
  );
  assert.deepEqual(verifySummaryOf({ verdict: 'complete', evidence: [], unchecked: [], at: 1 }), { label: '核验：完成', text: '' });
  assert.equal(verifySummaryOf({ verdict: 'unknown', evidence: [], unchecked: [], at: 1 }), null);
  assert.equal(verifySummaryOf(null), null);
});
