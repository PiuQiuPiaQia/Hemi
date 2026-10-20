// log-time 单测：钉住「本地时区 + 日期 + 毫秒」格式（2026-09-29 会话审计引入）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatLogTime } from './log-time.mjs';

test('formatLogTime：本地日期时间带毫秒，格式钉死', () => {
  const d = new Date(2026, 8, 29, 14, 30, 22, 437); // 本地 2026-09-29 14:30:22.437
  const line = formatLogTime(d);
  assert.equal(line, '2026-09-29 14:30:22.437');
  assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('formatLogTime：毫秒补零到三位、月份日期补零', () => {
  const d = new Date(2026, 0, 5, 1, 2, 3, 7);
  assert.equal(formatLogTime(d), '2026-01-05 01:02:03.007');
});

test('formatLogTime：非 Date 入参按时间值折算，不抛错', () => {
  const fromNumber = formatLogTime(new Date(2026, 8, 29, 0, 0, 0, 0).getTime());
  assert.equal(fromNumber, '2026-09-29 00:00:00.000');
});
