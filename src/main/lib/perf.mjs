// 性能埋点小工具：毫秒格式化 + 主进程事件循环阻塞监控。
//
// 刻意不 import Electron——门控/原语层在 node --test（无 Electron 运行时）下
// 也能安全引用；日志由调用方注入。
//
// 「跑任务很卡」的两类根因各有一条主线：
//  - 主进程被同步任务占住（视觉原语 spawnSync、同步文件 IO）→ 事件循环阻塞
//    监控直接量出来：UI 刷新、音频回调、任务事件在阻塞期间全部停摆；
//  - 某个环节慢（模型往返、审查 LLM、单个工具）→ 各调用点用 fmtMs 记分段耗时。

/** 毫秒 → 人读格式：<1s 用 ms，<1min 用一位小数秒，再往上用 m+s。 */
export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * 主进程活动面包屑（2026-10-06 审计）：主进程在做可能重的活前后记一笔，
 * 阻塞告警触发时带出「卡的那段时间里在干什么」——闲置期亚秒级阻塞
 * （C19，10-04 起留观）两个审计周期零归因，先让证据自己开口；
 * 若告警时窗口内一笔活动都没有，即指向进程外停摆（系统级 IO/换页）。
 *
 * 模块级环形缓冲：写路径只 push 一次对象，读只在告警时发生，无定时器。
 * 容量按「一次任务收尾的写盘数 + 余量」取 64。
 */
const ACTIVITY_RING_MAX = 64;
const activityRing = [];

/** 记一笔主进程活动（label 用稳定短名，如 `conversation-save`）。 */
export function noteActivity(label, at = Date.now()) {
  activityRing.push({ label, at });
  if (activityRing.length > ACTIVITY_RING_MAX) {
    activityRing.splice(0, activityRing.length - ACTIVITY_RING_MAX);
  }
}

/** 阻塞窗口 [windowStartMs, now] 内的活动摘要：按首次出现顺序计数。 */
function summarizeActivities(source, windowStartMs, now, slackMs = 500) {
  const counts = new Map();
  for (const entry of source()) {
    if (entry.at < windowStartMs - slackMs || entry.at > now) continue;
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label}×${n}` : label));
}

/**
 * 事件循环阻塞监控：按 intervalMs 周期探针，实际触发时刻相对预期时刻的
 * 漂移即阻塞时长（期间整个主进程——UI 转发、IPC、定时器——都停摆）。
 *
 * 递归 setTimeout 而非 setInterval：每轮以「实际触发时刻」为下一轮锚点，
 * 不把上一轮的漂移滚进下一轮，长阻塞只报一次。
 *
 * 系统睡眠/挂起防护（两道，层层递进）：
 *  a) powerMonitor 显式窗口（2026-10-06 审计）：宿主把 Electron powerMonitor
 *     的 suspend/resume 接到 markSuspend/markResume。resume 落在本次漂移窗口
 *     [expectedAt, now] 内、或挂起尚未恢复 → 该漂移按睡眠走 onSleep，不看
 *     时长——macOS 合盖小睡/Power Nap 常只有 1-3 分钟，低于冻结阈值却会被
 *     当成「分钟级阻塞」告警（10-06 实测一晚 3 条 1m29s~2m44s 假阻塞）。
 *     本模块不 import Electron，标记由宿主注入，单测离线可驱动。
 *  b) 时长启发式兜底：未接线 powerMonitor（node --test / 早期启动窗口）时，
 *     分钟级漂移（真阻塞到分钟级＝进程已死锁）按疑似睡眠单独走 onSleep。
 * 两条路都不计统计、不告警，避免污染阻塞指标与 10 分钟汇总
 *  （2026-09-30 审计：一晚睡眠刷出 5 条 10-16 分钟的假阻塞告警）。
 *
 * 回调由调用方接线到 logger：
 *  - onWarn({ lagMs, activities })：单次阻塞超阈值（自带节流，避免连环慢
 *    时刷屏）；activities 为阻塞窗口内的活动面包屑摘要（可为空数组）；
 *  - onSleep({ lagMs, source })：睡眠时段（info 级留痕，不计阻塞）；
 *    source: 'power'＝powerMonitor 证实，'freeze'＝时长启发式；
 *  - onSummary(windowStats)：周期汇总（窗口内 events/totalMs/maxMs）。
 * schedule/cancel/nowFn/activitySource 可注入（单测离线驱动），stop() 后不再触发。
 *
 * @returns {{
 *   stop(): void,
 *   stats(): { events: number, totalMs: number, maxMs: number },
 *   markSuspend(): void,
 *   markResume(): void,
 * }}
 */
export function startEventLoopLagMonitor({
  intervalMs = 1000,
  warnThresholdMs = 250,
  warnThrottleMs = 15_000,
  summaryEveryMs = 10 * 60_000,
  sleepSuspectMs = 5 * 60_000,
  nowFn = Date.now,
  schedule = (cb, ms) => {
    const timer = setTimeout(cb, ms);
    timer.unref?.();
    return timer;
  },
  cancel = clearTimeout,
  activitySource = () => activityRing,
  onWarn = () => {},
  onSleep = () => {},
  onSummary = () => {},
} = {}) {
  let stopped = false;
  let timer = null;
  let expectedAt = nowFn() + intervalMs;
  // -Infinity：首次阻塞必报，其后才受节流约束（0 会在启动后一个节流窗口内吞掉首报）。
  let lastWarnAt = -Infinity;
  let windowStartedAt = nowFn();
  let windowStats = { events: 0, totalMs: 0, maxMs: 0 };
  const totalStats = { events: 0, totalMs: 0, maxMs: 0 };
  // powerMonitor 显式睡眠标记（宿主注入）：只记最近一次挂起/恢复时刻。
  // 「resume 落在漂移窗口内」的判据随锚点推进自然过期，无需手动清理；
  // suspend 无 resume 跟进的场景按「仍挂起」处理（powerMonitor 事件成对，
  // macOS 实测可靠；宁可漏报一条阻塞，不把整段睡眠记成进程死锁）。
  let suspendMarkedAt = null;
  let resumeMarkedAt = null;
  const markSuspend = () => {
    suspendMarkedAt = nowFn();
  };
  const markResume = () => {
    resumeMarkedAt = nowFn();
  };

  const absorb = (stats, lagMs) => {
    stats.events += 1;
    stats.totalMs += lagMs;
    stats.maxMs = Math.max(stats.maxMs, lagMs);
  };

  const tick = () => {
    if (stopped) return;
    const now = nowFn();
    const lagMs = now - expectedAt;
    const lagWindowStart = expectedAt;
    expectedAt = now + intervalMs;
    const stillSuspended =
      suspendMarkedAt !== null &&
      (resumeMarkedAt === null || resumeMarkedAt < suspendMarkedAt);
    const resumedWithinLagWindow =
      resumeMarkedAt !== null && resumeMarkedAt >= lagWindowStart;
    const powerConfirmedSleep = stillSuspended || resumedWithinLagWindow;
    if ((lagMs >= sleepSuspectMs || powerConfirmedSleep) && lagMs >= warnThresholdMs) {
      // 系统睡眠/挂起：powerMonitor 证实或分钟级漂移兜底——不计阻塞统计、
      // 不告警，只单独留痕。
      try {
        onSleep({
          lagMs,
          source: powerConfirmedSleep && lagMs < sleepSuspectMs ? 'power' : 'freeze',
        });
      } catch {
        /* 监控回调异常不外溢 */
      }
    } else if (lagMs >= warnThresholdMs) {
      absorb(windowStats, lagMs);
      absorb(totalStats, lagMs);
      if (now - lastWarnAt >= warnThrottleMs) {
        lastWarnAt = now;
        try {
          onWarn({
            lagMs,
            maxLagMs: totalStats.maxMs,
            activities: summarizeActivities(activitySource, lagWindowStart, now),
          });
        } catch {
          /* 监控回调异常不外溢 */
        }
      }
    }
    if (now - windowStartedAt >= summaryEveryMs) {
      const snapshotStats = { ...windowStats };
      windowStats = { events: 0, totalMs: 0, maxMs: 0 };
      windowStartedAt = now;
      if (snapshotStats.events > 0) {
        try {
          onSummary(snapshotStats);
        } catch {
          /* 同上 */
        }
      }
    }
    timer = schedule(tick, intervalMs);
  };

  timer = schedule(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer != null) cancel(timer);
      timer = null;
    },
    stats() {
      return { events: totalStats.events, totalMs: totalStats.totalMs, maxMs: totalStats.maxMs };
    },
    markSuspend,
    markResume,
  };
}
