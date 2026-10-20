import type { TranscriptItem } from '@/shared/types';

/**
 * 026 R-09 阶段简报成组（2026-10-09 用户反馈 conv-mv0nx45i：四条简报各挂一遍
 * 任务名胶囊、正文与正式回答同重，对话流很碎）。只动视觉密度——简报照旧逐条
 * 入史、按 017 规则播报；渲染时把同一任务的连续简报收成一条进展时间线。
 *
 * 归组只认显式 taskId（旧档缺身份保持原样，不按邻接猜归属）；终态交代与核实
 * 失败有稳定身份前缀（shared/task-announcement 同口径），它们是正式回答，不进组。
 */
const ANNOUNCEMENT_ID = /^task-(result|verify-fail):/;

export function isStageBrief(item: TranscriptItem): boolean {
  return (
    item.author === 'hemi' &&
    !item.kind &&
    Boolean(item.taskId) &&
    !ANNOUNCEMENT_ID.test(item.id)
  );
}

export type TranscriptEntry =
  | {
      type: 'item';
      item: TranscriptItem;
      /** 挂同任务标识：带 taskId 的 Hemi 消息且上一条不属于同一任务。 */
      showRelation: boolean;
    }
  | {
      type: 'stages';
      /** 首条简报身份——组内追加新简报时 React 键不变。 */
      key: string;
      taskId: string;
      items: TranscriptItem[];
      showRelation: boolean;
      /** 本组含该任务的最新一条简报（运行中据此高亮「当前」）。 */
      latest: boolean;
    };

/** 条目所属任务：任务卡（含冻结卡）与带 taskId 的 Hemi 消息；用户消息不属于任何任务。 */
function taskOf(item: TranscriptItem): string | null {
  if (item.kind === 'task') return item.taskId ?? item.taskSnap?.taskId ?? null;
  return item.author === 'hemi' ? (item.taskId ?? null) : null;
}

/**
 * 同任务标识只在离开任务上下文时出现：紧跟自己任务卡/同任务简报的那条不再
 * 重复任务名（截图里同一胶囊连挂四遍）；中间插了闲聊或别的任务才挂上。
 */
export function groupStageBriefs(items: TranscriptItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const latestGroup = new Map<string, Extract<TranscriptEntry, { type: 'stages' }>>();
  let prevTask: string | null = null;
  for (const item of items) {
    const task = taskOf(item);
    if (isStageBrief(item) && task) {
      const last = entries.at(-1);
      if (last?.type === 'stages' && last.taskId === task) {
        last.items.push(item);
      } else {
        const group = { type: 'stages' as const, key: `stages:${item.id}`, taskId: task, items: [item], showRelation: prevTask !== task, latest: false };
        entries.push(group);
        latestGroup.set(task, group);
      }
    } else {
      entries.push({ type: 'item', item, showRelation: item.kind !== 'task' && task !== null && prevTask !== task });
    }
    prevTask = task;
  }
  for (const group of latestGroup.values()) group.latest = true;
  return entries;
}

/** 简报超过这个数就折叠更早的，只留最近 STAGE_TAIL 条（长任务不刷屏）。 */
export const STAGE_FOLD_AT = 4;
export const STAGE_TAIL = 3;

export function visibleStageCount(total: number, expanded: boolean): number {
  return expanded || total <= STAGE_FOLD_AT ? total : STAGE_TAIL;
}
