import assert from 'node:assert/strict';
import test from 'node:test';

import { fmtMs, noteActivity, startEventLoopLagMonitor } from './perf.mjs';

test('fmtMs：分档格式化，非法值兜底', () => {
  assert.equal(fmtMs(0), '0ms');
  assert.equal(fmtMs(843), '843ms');
  assert.equal(fmtMs(1234), '1.2s');
  assert.equal(fmtMs(59_999), '60.0s');
  assert.equal(fmtMs(125_000), '2m5s');
  assert.equal(fmtMs(Number.NaN), '?');
  assert.equal(fmtMs(-5), '?');
});

test('事件循环监控：漂移超阈值触发告警并累计，stop 后静默', () => {
  let clock = 10_000;
  const nowFn = () => clock;
  const pending = [];
  const schedule = (cb, ms) => {
    pending.push({ cb, at: clock + ms });
    return pending.length - 1;
  };
  const warns = [];
  const summaries = [];
  const monitor = startEventLoopLagMonitor({
    intervalMs: 1000,
    warnThresholdMs: 250,
    warnThrottleMs: 15_000,
    summaryEveryMs: 10_000,
    nowFn,
    schedule,
    cancel: () => {},
    onWarn: (info) => warns.push(info),
    onSummary: (stats) => summaries.push(stats),
  });

  const fire = () => {
    const next = pending.shift();
    clock = next.at; // 按计划准时触发：无漂移
    next.cb();
  };
  fire();
  fire();
  assert.equal(warns.length, 0, '准点触发不应告警');

  // 模拟一次 800ms 阻塞：探针晚到。
  const next = pending.shift();
  clock = next.at + 800;
  next.cb();
  assert.equal(warns.length, 1);
  assert.equal(warns[0].lagMs, 800);
  assert.deepEqual(monitor.stats(), { events: 1, totalMs: 800, maxMs: 800 });

  // 节流窗口内的第二次阻塞：不重复告警，但累计。
  const again = pending.shift();
  clock = again.at + 500;
  again.cb();
  assert.equal(warns.length, 1, '节流窗口内不刷屏');
  assert.equal(monitor.stats().events, 2);
  assert.equal(monitor.stats().maxMs, 800);

  // 推进时间到汇总窗口：拿到窗口统计（2 次 / 1300ms / 最长 800ms）。
  for (let i = 0; i < 12; i += 1) fire();
  assert.ok(
    summaries.some((s) => s.events === 2 && s.totalMs === 1300 && s.maxMs === 800),
    '窗口汇总应包含阻塞统计',
  );

  monitor.stop();
  const count = pending.length;
  fire();
  assert.equal(pending.length, count - 1, 'stop 后不再重排探针');
});

test('事件循环监控：分钟级冻结按疑似睡眠走 onSleep，不计阻塞统计（2026-09-30 审计）', () => {
  let clock = 10_000;
  const nowFn = () => clock;
  const pending = [];
  const schedule = (cb, ms) => {
    pending.push({ cb, at: clock + ms });
    return pending.length - 1;
  };
  const warns = [];
  const sleeps = [];
  const monitor = startEventLoopLagMonitor({
    intervalMs: 1000,
    warnThresholdMs: 250,
    warnThrottleMs: 15_000,
    summaryEveryMs: 10_000,
    nowFn,
    schedule,
    cancel: () => {},
    onWarn: (info) => warns.push(info),
    onSleep: (info) => sleeps.push(info),
  });

  // 模拟系统睡眠 16 分钟后唤醒：探针晚到。
  const wake = pending.shift();
  clock = wake.at + 16 * 60_000;
  wake.cb();
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0].lagMs, 16 * 60_000);
  assert.equal(warns.length, 0, '睡眠不触发阻塞告警');
  assert.deepEqual(
    monitor.stats(),
    { events: 0, totalMs: 0, maxMs: 0 },
    '睡眠不计入阻塞统计',
  );

  // 唤醒后真实阻塞照旧告警并累计。
  const next = pending.shift();
  clock = next.at + 900;
  next.cb();
  assert.equal(warns.length, 1);
  assert.equal(warns[0].lagMs, 900);
  assert.equal(monitor.stats().events, 1);

  monitor.stop();
});

test('事件循环监控：powerMonitor 证实的短睡眠不再误报阻塞（2026-10-06 审计）', () => {
  let clock = 10_000;
  const nowFn = () => clock;
  const pending = [];
  const schedule = (cb, ms) => {
    pending.push({ cb, at: clock + ms });
    return pending.length - 1;
  };
  const warns = [];
  const sleeps = [];
  const monitor = startEventLoopLagMonitor({
    intervalMs: 1000,
    warnThresholdMs: 250,
    warnThrottleMs: 15_000,
    summaryEveryMs: 10_000,
    nowFn,
    schedule,
    cancel: () => {},
    onWarn: (info) => warns.push(info),
    onSleep: (info) => sleeps.push(info),
  });

  // 一轮准点探针，锚点就位。
  const first = pending.shift();
  clock = first.at;
  first.cb();

  // 复现 10-06 现场：系统小睡 1m29s（低于 5min 冻结阈值）。suspend 在睡前
  // 标记，resume 在唤醒后、探针回调之前处理（事件顺序两种都要不误报）。
  monitor.markSuspend();
  const wake = pending.shift();
  clock = wake.at + 89_000;
  monitor.markResume(); // resume 回调先于探针触发
  wake.cb();
  assert.equal(warns.length, 0, '短睡眠不得触发阻塞告警');
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0].lagMs, 89_000);
  assert.equal(sleeps[0].source, 'power', 'powerMonitor 证实的睡眠标 power');
  assert.deepEqual(
    monitor.stats(),
    { events: 0, totalMs: 0, maxMs: 0 },
    '短睡眠不计入阻塞统计',
  );

  // 变体：探针先于 resume 回调触发（挂起尚未恢复）——同样按睡眠处理。
  clock += 1; // 上一轮 resume 已在唤醒时刻标记，新挂起必须晚于它
  monitor.markSuspend();
  const wake2 = pending.shift();
  clock = wake2.at + 123_000;
  wake2.cb(); // 此时 resume 还没来
  monitor.markResume();
  assert.equal(warns.length, 0);
  assert.equal(sleeps.length, 2);
  assert.equal(sleeps[1].source, 'power');

  // 唤醒落定后的真实阻塞照旧告警（判据随锚点推进自然过期）。
  const next = pending.shift();
  clock = next.at + 700;
  next.cb();
  assert.equal(warns.length, 1);
  assert.equal(warns[0].lagMs, 700);

  monitor.stop();
});

test('事件循环监控：无 powerMonitor 标记时分钟级兜底仍走 onSleep（freeze 源）', () => {
  let clock = 10_000;
  const nowFn = () => clock;
  const pending = [];
  const schedule = (cb, ms) => {
    pending.push({ cb, at: clock + ms });
    return pending.length - 1;
  };
  const sleeps = [];
  const monitor = startEventLoopLagMonitor({
    intervalMs: 1000,
    nowFn,
    schedule,
    cancel: () => {},
    onSleep: (info) => sleeps.push(info),
  });

  const wake = pending.shift();
  clock = wake.at + 16 * 60_000;
  wake.cb();
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0].source, 'freeze', '未接线 powerMonitor 时按时长启发式');

  monitor.stop();
});

test('事件循环监控：阻塞告警带出窗口内活动面包屑（C19 归因）', () => {
  let clock = 10_000;
  const nowFn = () => clock;
  const pending = [];
  const schedule = (cb, ms) => {
    pending.push({ cb, at: clock + ms });
    return pending.length - 1;
  };
  const ring = [];
  const warns = [];
  const monitor = startEventLoopLagMonitor({
    intervalMs: 1000,
    warnThresholdMs: 250,
    warnThrottleMs: 0, // 本用例要看连续两次告警，关掉节流
    nowFn,
    schedule,
    cancel: () => {},
    activitySource: () => ring,
    onWarn: (info) => warns.push(info),
  });

  const first = pending.shift();
  clock = first.at;
  first.cb();

  // 阻塞窗口内一笔在途活动 + 窗口外一笔旧活动（不得混入）+ 同名第二次。
  ring.push({ label: 'stale-activity', at: clock - 60_000 });
  const blocked = pending.shift();
  // 第一笔在漂移窗口 [blocked.at, now] 起点后（探针已排程、阻塞进行中）。
  ring.push({ label: 'conversation-save', at: blocked.at + 100 });
  clock = blocked.at + 800;
  ring.push({ label: 'conversation-save', at: clock - 50 });
  blocked.cb();
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].activities, ['conversation-save×2']);

  // 窗口内零登记活动 → 空数组（指向进程外停摆）。
  const quiet = pending.shift();
  clock = quiet.at + 600;
  quiet.cb();
  assert.equal(warns.length, 2);
  assert.deepEqual(warns[1].activities, []);

  monitor.stop();
});

test('noteActivity：环形缓冲超量写入后窗口过滤仍准确（模块级环健康）', () => {
  let clock = 10_000;
  const nowFn = () => clock;
  const pending = [];
  const schedule = (cb, ms) => {
    pending.push({ cb, at: clock + ms });
    return pending.length - 1;
  };
  const warns = [];
  // 不注入 activitySource：走模块级默认环（noteActivity 的真实落点）。
  const monitor = startEventLoopLagMonitor({
    intervalMs: 1000,
    warnThresholdMs: 250,
    nowFn,
    schedule,
    cancel: () => {},
    onWarn: (info) => warns.push(info),
  });

  const first = pending.shift();
  clock = first.at;
  first.cb();

  // 80 次远期写入（超环容量 64）+ 阻塞窗口内一笔近期写入：
  // 环淘汰旧条目不抛错，窗口过滤只带出近期那笔。
  for (let i = 0; i < 80; i += 1) {
    noteActivity(`bulk-${i}`, clock - 60_000 + i);
  }
  const blocked = pending.shift();
  clock = blocked.at + 900;
  noteActivity('windowed-op', clock - 10);
  blocked.cb();
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].activities, ['windowed-op'], '远期批量写入不进窗口摘要');

  monitor.stop();
});
