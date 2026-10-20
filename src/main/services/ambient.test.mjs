import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAmbientBlock } from './ambient.mjs';

test('环境块：固定时刻 + 固定时区 → 日期、星期、偏移、时间齐全', () => {
  // 2026-09-20 19:32 上海（周日）。UTC 时刻 = 11:32。
  const now = new Date('2026-09-20T11:32:00Z');
  const block = buildAmbientBlock({ now, timeZone: 'Asia/Shanghai' });
  assert.match(block, /【环境】今天是2026年9月20日，星期日（Asia\/Shanghai，UTC\+08:00），现在 19:32。/);
});

test('环境块：跨时区换算正确（UTC 时刻按目标时区呈现）', () => {
  const now = new Date('2026-09-20T23:30:00Z');
  const block = buildAmbientBlock({ now, timeZone: 'Asia/Tokyo' });
  // UTC 23:30 → 东京次日 08:30（9 月 21 日，周一）。
  assert.match(block, /今天是2026年9月21日，星期一（Asia\/Tokyo，UTC\+09:00），现在 08:30。/);
});

test('环境块：缺省时区也能出块（含今天与现在）', () => {
  const block = buildAmbientBlock({ now: new Date() });
  assert.match(block, /^【环境】今天是\d{4}年\d{1,2}月\d{1,2}日，星期[一二三四五六日]（.+，UTC[+-]\d{2}:\d{2}），现在 \d{2}:\d{2}。$/);
});

test('环境块：非法时区不抛错、返回空块（宁可不带，不给错误时间）', () => {
  const block = buildAmbientBlock({ now: new Date('2026-09-20T11:32:00Z'), timeZone: 'Not/AZone' });
  assert.equal(block, '');
});
