// 048 S5：思考展示纯函数（时长文案、最新一行截取）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatThinkingDuration, latestLineOf } from './thinking-format.ts';

test('formatThinkingDuration：秒取整、≥60s 用 1m 19s', () => {
  assert.equal(formatThinkingDuration(0), '0s');
  assert.equal(formatThinkingDuration(12_400), '12s');
  assert.equal(formatThinkingDuration(79_000), '1m 19s');
  assert.equal(formatThinkingDuration(60_000), '1m 00s');
  assert.equal(formatThinkingDuration(-5), '0s');
});

test('latestLineOf：取最新段落最后一句；短句连同前一句；多段取末段', () => {
  // 长句（≥24 字）：只取它。
  const long = '这是一个足够长的句子用来超过二十四个字符的阈值显示。';
  assert.equal(latestLineOf(`前一句。\n\n${long}`), long);

  // 短句（<24 字）：连同前一句。
  assert.equal(latestLineOf('用户要建文件。这个很短。'), '用户要建文件。这个很短。');

  // 多段：最新段落优先。
  assert.equal(
    latestLineOf('第一段想完了。\n\n第二段。最后一句话到这里。'),
    '第二段。最后一句话到这里。',
  );

  assert.equal(latestLineOf(''), '');
  assert.equal(latestLineOf('\n\n  \n\n'), '');
});

test('latestLineOf：英文句号切分同样成立', () => {
  assert.equal(
    latestLineOf('If they go up, it is light. Same comparison, reversed.'),
    'Same comparison, reversed.',
  );
});

test('waitingStatusText：2s 内只说正在想，之后带计时，≥15s 改口等待模型回应', async () => {
  const { waitingStatusText } = await import('./thinking-format.ts');
  assert.equal(waitingStatusText(0), '正在想');
  assert.equal(waitingStatusText(1_999), '正在想');
  assert.equal(waitingStatusText(2_000), '正在想 · 2s');
  assert.equal(waitingStatusText(14_400), '正在想 · 14s');
  assert.equal(waitingStatusText(15_000), '等待模型回应 · 15s');
  assert.equal(waitingStatusText(79_000), '等待模型回应 · 1m 19s');
});
