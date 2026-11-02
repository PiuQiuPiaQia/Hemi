import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localDateKey, nextLocalMidnight, parseLocalDate, resolveUsageDateRange,
  usageHeatmapRange, validateUsageDates,
} from './usage-history-dates.ts';

const inTimezone = (timezone, run) => {
  const original = process.env.TZ;
  process.env.TZ = timezone;
  try { run(); } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
};

test('今天使用本地日界，包含末毫秒而不包含明天（UTC 正负偏移）', () => {
  for (const zone of ['Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    inTimezone(zone, () => {
      const now = new Date(2026, 10, 2, 0, 15);
      const range = resolveUsageDateRange({preset: 'today'}, now);
      assert.equal(range.from, new Date(2026, 10, 2).getTime());
      assert.equal(range.to, new Date(2026, 10, 3).getTime() - 1);
      assert.equal(localDateKey(new Date(range.from)), '2026-11-02');
      assert.equal(new Date(range.to).getHours(), 23);
      assert.equal(new Date(range.to).getMilliseconds(), 999);
    });
  }
});

test('昨天与近 7 天按日历跨月、跨年，不是过去 168 小时', () => {
  inTimezone('Asia/Shanghai', () => {
    const now = new Date(2026, 0, 1, 18, 30);
    assert.deepEqual(resolveUsageDateRange({preset: 'yesterday'}, now), {
      from: new Date(2025, 11, 31).getTime(), to: new Date(2026, 0, 1).getTime() - 1,
    });
    assert.deepEqual(resolveUsageDateRange({preset: 'last7'}, now), {
      from: new Date(2025, 11, 26).getTime(), to: new Date(2026, 0, 2).getTime() - 1,
    });
    assert.deepEqual(resolveUsageDateRange({preset: 'all'}, now), {});
  });
});

test('夏令时开始和结束分别使用 23 / 25 小时的日界', () => {
  inTimezone('America/New_York', () => {
    for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]]) {
      const now = new Date(2026, month, day, 12);
      const today = resolveUsageDateRange({preset: 'today'}, now);
      assert.equal(today.to - today.from + 1, hours * 60 * 60 * 1000);
      assert.equal(nextLocalMidnight(now).getTime(), today.to + 1);
      const yesterday = resolveUsageDateRange({preset: 'yesterday'}, nextLocalMidnight(now));
      assert.deepEqual(yesterday, today);
      assert.deepEqual(resolveUsageDateRange({preset: 'custom', start: localDateKey(now), end: localDateKey(now)}, now), today);
    }
    const week = resolveUsageDateRange({preset: 'last7'}, new Date(2026, 2, 10, 10));
    assert.equal(week.to - week.from + 1, (7 * 24 - 1) * 60 * 60 * 1000);
  });
});

test('自定义日期验证缺失、无效和倒序；合法同日范围包括当天全部', () => {
  inTimezone('Asia/Shanghai', () => {
    assert.match(validateUsageDates('', ''), /请选择/);
    for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-1', 'no-date']) {
      assert.equal(parseLocalDate(invalid), null);
      assert.match(validateUsageDates(invalid, '2026-12-31'), /有效日期/);
    }
    assert.equal(localDateKey(parseLocalDate('2024-02-29')), '2024-02-29');
    assert.equal(localDateKey(parseLocalDate('0099-01-01')), '0099-01-01');
    assert.match(validateUsageDates('2026-11-03', '2026-11-02'), /不能晚于/);
    assert.throws(() => resolveUsageDateRange({preset: 'custom', start: '', end: ''}, new Date()), RangeError);
    const range = resolveUsageDateRange({preset: 'custom', start: '2026-11-02', end: '2026-11-02'}, new Date());
    assert.equal(range.from, new Date(2026, 10, 2).getTime());
    assert.equal(range.to, new Date(2026, 10, 3).getTime() - 1);
  });
});

test('跨午夜重新求值使今天和昨天移动到新的本地日', () => {
  inTimezone('America/New_York', () => {
    const before = new Date(2026, 9, 31, 23, 59, 59, 999);
    const after = nextLocalMidnight(before);
    assert.equal(localDateKey(after), '2026-11-01');
    assert.notDeepEqual(resolveUsageDateRange({preset: 'today'}, before), resolveUsageDateRange({preset: 'today'}, after));
    assert.deepEqual(resolveUsageDateRange({preset: 'today'}, before), resolveUsageDateRange({preset: 'yesterday'}, after));
  });
});

test('热力图仅在超过七天的范围显示，截取末尾 12 周而不冒充全部历史', () => {
  inTimezone('Asia/Shanghai', () => {
    const now = new Date(2026, 10, 2, 18);
    for (const preset of ['today', 'yesterday', 'last7']) {
      assert.equal(usageHeatmapRange(resolveUsageDateRange({preset}, now), now), null);
    }
    const full = usageHeatmapRange({}, now);
    assert.equal(localDateKey(full.last), '2026-11-02');
    assert.equal(localDateKey(full.first), '2026-08-11');
    const custom = usageHeatmapRange(resolveUsageDateRange({preset: 'custom', start: '2026-09-20', end: '2026-10-02'}, now), now);
    assert.equal(localDateKey(custom.first), '2026-09-20');
    assert.equal(localDateKey(custom.last), '2026-10-02');
  });
});
