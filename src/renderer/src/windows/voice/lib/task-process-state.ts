import type { TaskStateSnapshot } from '@/shared/types';

export type ProcessStep = {
  key: string;
  title: string;
  detail: string;
  at: number;
  running: boolean;
  /** 异常步骤（操作未执行）：说明直接可见、红字。 */
  attention: boolean;
  /** 从日志尾注「（1.2s）」拆出的单步耗时；没有则空。 */
  duration: string;
};

/**
 * 过程步骤取任务原始事件流水（snap.log）。
 *
 * 056（2026-10-15 用户反馈「看不到执行了什么」）：主进程的工具日志是
 * 「已完成：<动作>（<耗时>）」句式——旧解析按第一个冒号切，标题全成了
 * 「已完成」、动作被折叠进详情，一屏根本看不出做了什么。现在：
 *   - 「已完成：」前缀剥掉，整句动作做标题（不再二次切分）；
 *   - 尾注耗时拆到时间位（与时刻并排展示）；
 *   - 运行中的一步不再拿最后一条已完成日志充数，用快照的 progressText
 *     （tool-start 起就有的「正在搜索内容」）单独追加在末尾；
 *   - 其余句式（「已允许（持续）：Terminal」等授权/异常行）保持旧的
 *     「标签：详情」两段式，详情进可展开区。
 * 同义生命周期事件「任务开始」「任务开始执行」（前者进程内、后者档案建档，
 * 历史快照重建后两条并存）不算一步（026 R-03）。
 */
const DONE_PREFIX = '已完成：';
const DURATION_NOTE = /（(\d+(?:\.\d+)?(?:ms|s|min))）$/;

export function processStepsOf(snap: TaskStateSnapshot): ProcessStep[] {
  const inFlight = snap.phase !== 'terminal';
  const log = snap.log ?? [];
  const START_TITLES = new Set(['任务开始', '任务开始执行']);
  const steps: ProcessStep[] = [];
  for (let index = 0; index < log.length; index += 1) {
    const line = log[index];
    let text = line.text;
    if (text.startsWith(DONE_PREFIX)) {
      const rest = text.slice(DONE_PREFIX.length);
      const hit = rest.match(DURATION_NOTE);
      steps.push({
        key: `${line.at}-${text.slice(0, 16)}`,
        title: hit ? rest.slice(0, hit.index) : rest,
        detail: '',
        at: line.at,
        running: false,
        attention: false,
        duration: hit?.[1] ?? '',
      });
      continue;
    }
    const separator = text.indexOf('：');
    const hasDetail = separator > 0 && separator < text.length - 1;
    const title = hasDetail ? text.slice(0, separator) : text;
    steps.push({
      // 稳定键：日志从头部裁剪时序号会位移，时间戳＋文本前缀不受影响（026 AC-04）。
      key: `${line.at}-${text.slice(0, 16)}`,
      title,
      detail: hasDetail ? text.slice(separator + 1) : '',
      at: line.at,
      running: false,
      attention: /^(操作未执行|确认超时|已拒绝本次操作|核实未能完成)/.test(title),
      duration: '',
    });
  }
  const filtered = steps.filter((step) => !START_TITLES.has(step.title.replace(/[。.]$/, '')));
  if (inFlight) {
    // 正在跑的一步：progressText 带实时计时「（已 3 秒）」，只留动作本身。
    const progress = snap.progressText?.replace(/（已 [^）]*）$/, '')?.trim();
    if (progress) {
      filtered.push({
        key: 'running',
        title: progress,
        detail: '',
        at: log[log.length - 1]?.at ?? snap.startedAt ?? Date.now(),
        running: true,
        attention: false,
        duration: '',
      });
    }
  }
  return filtered;
}

/** 执行耗时：<1 分钟按秒，不足整分略零头。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 时 ${restMinutes} 分` : `${hours} 时`;
}

/** 任务耗时：startedAt 到真正终态（含总结）；旧档缺省末条日志。 */
export function taskElapsedMs(snap: TaskStateSnapshot, now: number): number | null {
  const startedAt = snap.startedAt ?? snap.log?.[0]?.at;
  if (!startedAt) return null;
  const end = snap.phase === 'terminal' ? snap.endedAt ?? snap.log?.at(-1)?.at : now;
  return end && end > startedAt ? end - startedAt : null;
}
