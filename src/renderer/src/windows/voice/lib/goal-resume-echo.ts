import type { FlowSnapshotView } from '@shared/protocol';
import type { TranscriptItem } from '@/shared/types';

type Scope = Pick<FlowSnapshotView, 'conversationId' | 'generation'>;
export type GoalResumeEcho = Scope & {
  precedingRunIds: ReadonlySet<string>;
  transcript: TranscriptItem;
};

/** 命令不建用户消息：冻结提交前的运行边界，而不是让本地原话永远追加在投影尾部。 */
export function createGoalResumeEcho(snapshot: Scope & Pick<FlowSnapshotView, 'runs'>, transcript: TranscriptItem): GoalResumeEcho {
  return { conversationId: snapshot.conversationId, generation: snapshot.generation,
    precedingRunIds: new Set(Object.keys(snapshot.runs)), transcript };
}

/** 只插入本地回显，不重排权威时间线；首字前占位、流式分段和完成回复都在回显之后。 */
export function mergeGoalResumeEchoes(transcripts: TranscriptItem[], echoes: GoalResumeEcho[], scope: Scope | null): TranscriptItem[] {
  const current = echoes.filter(echo => echo.conversationId === scope?.conversationId && echo.generation === scope.generation);
  if (!current.length) return transcripts;
  const insertions = new Map<number, TranscriptItem[]>();
  for (const echo of current) {
    const nextRun = transcripts.findIndex(item => item.flow && !echo.precedingRunIds.has(item.flow.runId));
    const index = nextRun < 0 ? transcripts.length : nextRun;
    insertions.set(index, [...(insertions.get(index) ?? []), echo.transcript]);
  }
  return transcripts.flatMap((item, index) => [...(insertions.get(index) ?? []), item])
    .concat(insertions.get(transcripts.length) ?? []);
}
