import type { TranscriptItem } from '@/shared/types';

/**
 * 024 消息编辑（2026-10-10 语义改版，仿 zcode 回卷；旧「标记冻结」语义已删）：
 *
 * - 所有非任务卡的用户消息可编辑；「重新发送」＝保存新文本（editedAt 打点）＋
 *   把这条之后的内容整段撤下（含回复、任务卡、终态交代），再从这条重新发起
 *   模型回合。被撤下的内容从对话流删除，不再标 stale／待重发。
 * - 主进程的宿主回写（mergeHostTurns／appendHostTurns／restoreTaskResults）
 *   会复活被删条目——回卷时收集「剪除键」（条目 id＋任务 taskId）随保存传
 *   主进程，档案持久化 cutKeys，两条写入路径都按它过滤。
 * - 在途回合由调用方先抢占作废（zcode：editUserQuery preempts active turn），
 *   不存在「模型在途时编辑被静默拒绝」。
 */

/** 可编辑判定：用户消息且非任务卡（语音/文字来源均可；已编辑过的可再编辑）。 */
export function isEditableMessage(item: TranscriptItem): boolean {
  return item.author === 'user' && item.kind !== 'task';
}

/** 回卷结果：撤下后的对话流＋剪除键（条目 id 与任务 taskId 的并集）。 */
export type RewindResult = {
  turns: TranscriptItem[];
  cutKeys: string[];
  /** 被撤下的条目数（日志与确认用；不含编辑点本身）。 */
  cutCount: number;
};

/**
 * 回卷到 editId：该条原位替换文本并重锚到重发时刻（createdAt＝editedAt——
 * 2026-10-14 用户裁决：重发的消息按「现在」摆位，不留在原时间点），其后条目
 * 整段删除。未找到 editId 返回 null（防御：编辑期间消息被清场）。
 */
export function rewindToMessage(
  transcripts: TranscriptItem[],
  editId: string,
  newText: string,
  editedAt: number,
): RewindResult | null {
  const index = transcripts.findIndex((item) => item.id === editId);
  if (index < 0) return null;

  const cutKeys = new Set<string>();
  for (const item of transcripts.slice(index + 1)) {
    cutKeys.add(item.id);
    if (item.taskId) cutKeys.add(item.taskId);
  }

  const turns = transcripts.slice(0, index);
  turns.push({
    ...transcripts[index],
    text: newText,
    createdAt: editedAt,
    editedAt,
  });
  return { turns, cutKeys: [...cutKeys], cutCount: transcripts.length - index - 1 };
}

/**
 * 转录/档案 → 模型上下文的公共过滤约定：任务卡、失败留痕（kind='error'）、
 * 空文本不进上下文（2026-10-07 会话审计：留痕只给人看、给档案留证）。
 * 回卷后对话流止于编辑点，本函数即得重跑上下文（含替换后的文本）。
 */
export function historyFromTurns(
  transcripts: TranscriptItem[],
): Array<{ author: 'user' | 'hemi'; text: string }> {
  const out: Array<{ author: 'user' | 'hemi'; text: string }> = [];
  for (const item of transcripts) {
    if (item.kind === 'task' || item.kind === 'error') continue;
    if (!item.text) continue;
    out.push({ author: item.author, text: item.text });
  }
  return out;
}

/** 切换会话/新建/载入时，编辑态一并失效（返回 editingId 是否仍存在）。 */
export function resolveEditingId(transcripts: TranscriptItem[], editingId: string | null): string | null {
  if (!editingId) return null;
  return transcripts.some((item) => item.id === editingId) ? editingId : null;
}

/** 重试收走结尾连续的失败留痕：重试即替代旧错误，新失败另留新痕——一次交互
 *  只保一条最新错误。2026-10-14 conv-mv5fs5vf 实录：配置故障期连点重试 5 次，
 *  6 条 reply-error 全堆进档案与回看。中部历史错误不动，只收结尾；无结尾错误
 *  返回 null（调用方免剪）。 */
export function supersedeTrailingErrors(
  transcripts: TranscriptItem[],
): { turns: TranscriptItem[]; cutKeys: string[]; cutCount: number } | null {
  let end = transcripts.length;
  while (end > 0 && transcripts[end - 1]?.kind === 'error') end -= 1;
  if (end === transcripts.length) return null;
  const removed = transcripts.slice(end);
  return {
    turns: transcripts.slice(0, end),
    cutKeys: removed.map((item) => item.id),
    cutCount: removed.length,
  };
}
