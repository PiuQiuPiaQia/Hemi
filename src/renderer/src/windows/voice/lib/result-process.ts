import type { TaskStateSnapshot } from '@/shared/types';
import type { ProcessStep } from './task-process-state';

/**
 * 050 状态行「查看过程」原地展开的步骤口径（稿 designs/2026-10-10-result-delivery
 * 的 .proc-list）：时间列是距任务开始的用时（00:04），不是钟点；步骤句去掉
 * 「已完成：」这类默认状态前缀、网址解码去协议头，单步耗时降为淡色尾注
 * （稿里的「· 浏览器」位）。完整原始流水仍在 025 过程抽屉与任务档案里。
 */
export type ResultStep = {
  key: string;
  /** 距任务开始：mm:ss（≥1 小时 h:mm:ss）。 */
  time: string;
  text: string;
  /** 淡色尾注：单步耗时等。 */
  note: string;
  attention: boolean;
};

/** 用时钟面：00:04、05:46、1:02:03。 */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 百分号编码逐段解码（截断的半个字节序列原样保留，不抛错）。 */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    for (let end = run.length; end >= 3; end -= 3) {
      try {
        return decodeURIComponent(run.slice(0, end)) + run.slice(end);
      } catch {
        // 末尾是被截断的多字节序列：退一个字节再试。
      }
    }
    return run;
  });
}

/** 步骤句里的网址读成人话：解码、去协议头与 www.、去单独的末尾斜杠。 */
export function readableUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s（）()]+/g, (url) =>
    decodePercent(url)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, ''),
  );
}

const DEFAULT_STATE_TITLES = new Set(['已完成']);
const TRAILING_DURATION = /\s*[（(]\s*(\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒))\s*[）)]\s*$/;

/** steps 取 processStepsOf(snap)（与过程抽屉同一流水口径）；startedAt 缺省用首步。
 * 056 起 processStepsOf 已把「已完成：」与尾注耗时拆好（step.duration），
 * 这里对旧形状（title/detail 两段）保持兼容。 */
export function resultStepsOf(steps: ProcessStep[], startedAt?: number | null): ResultStep[] {
  const base = startedAt ?? steps[0]?.at ?? 0;
  return steps.map((step) => {
    const sentence = step.detail
      ? DEFAULT_STATE_TITLES.has(step.title) ? step.detail : `${step.title}：${step.detail}`
      : step.title;
    const duration = sentence.match(TRAILING_DURATION);
    const body = duration ? sentence.slice(0, duration.index) : sentence;
    return {
      key: step.key,
      time: elapsedClock(step.at - base),
      text: readableUrls(body).trim(),
      note: step.duration || (duration ? duration[1].replace(/\s+/g, '') : ''),
      attention: step.attention,
    };
  });
}

const VERDICT_WORD: Record<string, string> = { complete: '完成', partial: '部分完成', unknown: '无法确认' };

/**
 * 核验摘要一句话（稿 .proc-verify：「核验：部分完成 · 10 条关键断言已核对；
 * 未核实 2 项」）——证据全文不在这里铺开，只给结论与数量。
 */
export function verifySummaryOf(
  verification: TaskStateSnapshot['verification'],
): { label: string; text: string } | null {
  if (!verification) return null;
  const evidence = (verification.evidence ?? []).filter(Boolean);
  const unchecked = (verification.unchecked ?? []).filter(Boolean);
  // 没跑成的核验（停止/失败时的 unknown 空壳）不出摘要，免得读成「核验过了」。
  if (verification.verdict === 'unknown' && !evidence.length && !unchecked.length) return null;
  const parts: string[] = [];
  if (evidence.length === 1) parts.push(evidence[0].replace(/[。.；;]+$/, ''));
  else if (evidence.length > 1) parts.push(`已核对 ${evidence.length} 条依据`);
  if (unchecked.length) parts.push(`未核实 ${unchecked.length} 项`);
  return {
    label: `核验：${VERDICT_WORD[verification.verdict] ?? '记录'}`,
    text: parts.length ? `${parts.join('；')}。` : '',
  };
}
