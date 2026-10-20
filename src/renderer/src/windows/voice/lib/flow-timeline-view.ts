/** 060：所有展示时点共用的纯投影。flow 决定位置和身份，档案仅补对应载荷。 */
import type { FlowSnapshotView } from '@shared/protocol';
import type { TranscriptItem } from '@/shared/types';
import { flowPartsToTranscriptParts } from './transcript-parts-view.ts';

export type FlowTimelineProjection = {
  transcripts: TranscriptItem[];
  /** 兼容既有调用方；历史完整性由宿主恢复入口处理。 */
  leftoverTurns: number;
  source: 'flow';
};

type ProjectionCache = Map<string, { dependencies: unknown[]; rows: TranscriptItem[] }>;
const EMPTY_RUN = {};

/** One current conversation/generation only. No historical payload or DOM snapshots retained. */
export function createFlowTimelineProjector() {
  const cache: ProjectionCache = new Map();
  let scope = '';
  return (snapshot: FlowSnapshotView, turns: TranscriptItem[] = []) => {
    const nextScope = `${snapshot.conversationId}:${snapshot.generation}`;
    if (scope !== nextScope) { cache.clear(); scope = nextScope; }
    return projectFlowTimeline(snapshot, turns, cache);
  };
}

export function projectFlowTimeline(
  snapshot: FlowSnapshotView,
  turns: TranscriptItem[] = [],
  cache?: ProjectionCache,
): FlowTimelineProjection {
  const usable = turns.filter((turn) => !turn.withdrawn);
  const timeline = snapshot.timeline ?? [];
  const runs = snapshot.runs ?? {};
  const byId = new Map(usable.map((turn) => [turn.id, turn]));
  const callCounts = new Map<string, number>();
  for (const item of timeline) for (const part of item.kind === 'assistant' ? item.parts : []) {
    if (part.kind === 'delegation' && part.toolCallId) {
      const call = String(part.toolCallId);
      callCounts.set(call, (callCounts.get(call) ?? 0) + 1);
    }
  }
  // 时间线是唯一展示事实；turns 只按身份提供旧载荷，不能整表接管实时流。
  // 局部旧档在 controller 发布前由宿主统一迁移，不在 UI 按场景拼历史和实时尾部。
  const callSources = new Map<string, unknown[]>();
  const tasksByCall = new Map<string, TranscriptItem['taskSnap']>();
  for (const task of Object.values(snapshot.tasks ?? {})) {
    for (const execution of Object.values((task.executions ?? {}) as Record<string, Record<string, unknown>>)) {
      if (execution.toolCallId) {
        tasksByCall.set(String(execution.toolCallId), execution as TranscriptItem['taskSnap']);
        callSources.set(String(execution.toolCallId), [execution]);
      }
    }
    if (task.toolCallId) { tasksByCall.set(String(task.toolCallId), task as TranscriptItem['taskSnap']); callSources.set(String(task.toolCallId), [task]); }
  }
  for (const turn of usable) {
    const call = turn.taskSnap?.toolCallId;
    // 档案提供全量日志／报告，flow 提供该次执行的最新状态。
    if (call) { tasksByCall.set(call, { ...turn.taskSnap, ...tasksByCall.get(call) } as TranscriptItem['taskSnap']); callSources.set(call, [...(callSources.get(call) ?? []), turn.taskSnap]); }
  }
  const transcripts: TranscriptItem[] = [];
  // 062：交付文件入口按文件对象全局去重——同一路径跨运行/主与子 agent 重复声明
  // 只保留时间线上第一个入口（R-04「不再展示一份重复文件卡」；更新只递增
  // contentVersion，不复制第二个入口）。
  const seenDeliverables = new Set<string>();
  const deliverableFiltered = (parts: Array<{ partId: string; kind: string } & Record<string, unknown>>) =>
    parts.filter((part) => {
      if (part?.kind !== 'deliverable' || !part.artifactId) return true;
      if (seenDeliverables.has(String(part.artifactId))) return false;
      seenDeliverables.add(String(part.artifactId));
      return true;
    });
  const validKeys = new Set<string>();
  for (const item of timeline) {
    const run = runs[item.runId] ?? EMPTY_RUN;
    const rowKey = item.kind === 'user' ? item.id : item.itemId;
    validKeys.add(rowKey);
    // Dedupe is ordered across the whole timeline even on a cache hit.
    const filteredParts = item.kind === 'assistant' ? deliverableFiltered(item.parts) : [];
    const archived = byId.get(item.kind === 'user' ? item.id : String((item as { legacyTurnId?: string }).legacyTurnId ?? ''));
    const dependencies: unknown[] = [item, run, archived, ...filteredParts];
    for (const part of filteredParts) if (part.kind === 'delegation') {
      dependencies.push(callCounts.get(String(part.toolCallId ?? '')), snapshot.tasks[String(part.taskId ?? '')], ...(callSources.get(String(part.toolCallId ?? '')) ?? []));
    }
    if (archived?.taskSnap?.toolCallId) dependencies.push(...(callSources.get(archived.taskSnap.toolCallId) ?? []));
    const cached = cache?.get(rowKey);
    if (cached && cached.dependencies.length === dependencies.length && dependencies.every((value, i) => value === cached.dependencies[i])) {
      transcripts.push(...cached.rows);
      continue;
    }
    const rowStart = transcripts.length;
    const remember = () => cache?.set(rowKey, { dependencies, rows: transcripts.slice(rowStart) });
    if (item.kind === 'user') {
      const archived = byId.get(item.id);
      transcripts.push({
        ...archived, id: item.id, author: 'user', text: item.text, inputSource: item.inputSource,
        createdAt: item.deliveredAt ?? item.acceptedAt ?? archived?.createdAt ?? 0,
        attachments: item.attachments ?? archived?.attachments,
        references: (item as { references?: TranscriptItem['references'] }).references ?? archived?.references,
        skills: (item as { skills?: TranscriptItem['skills'] }).skills ?? archived?.skills,
        flow: { runId: item.runId, inputId: item.id, itemId: item.id, partIds: [] },
      });
      remember();
      continue;
    }
    const legacy = item as typeof item & { legacyTurnId?: string; legacyUsage?: TranscriptItem['usage']; legacyThinking?: TranscriptItem['thinking'] };
    if (legacy.legacyTurnId && byId.has(legacy.legacyTurnId)) {
      const archived = byId.get(legacy.legacyTurnId)!;
      const task = archived.taskSnap?.toolCallId ? tasksByCall.get(archived.taskSnap.toolCallId) : null;
      // 原始历史不虚构运行归属；任务状态仍按明确的调用身份更新。
      transcripts.push({ ...archived, ...(archived.kind === 'task' && task ? { taskSnap: task } : {}) });
      remember();
      continue;
    }
    const segments: Array<{ kind: 'body' | 'delegation' | 'notice'; parts: typeof item.parts }> = [];
    for (const part of filteredParts) {
      const kind = part.kind === 'delegation' ? 'delegation' : part.kind === 'notice' ? 'notice' : 'body';
      const last = segments.at(-1);
      if (last && last.kind === kind && kind === 'body') last.parts.push(part);
      else segments.push({ kind, parts: [part] });
    }
    for (const segment of segments) {
      const first = segment.parts[0];
      const id = first === item.parts[0] ? item.itemId : `${item.itemId}:${first.partId}`;
      const flow = { runId: item.runId, itemId: item.itemId, partIds: segment.parts.map((p) => p.partId) };
      const createdAt = Number(run.startedAt) || 0;
      if (segment.kind === 'delegation') {
        const terminal = first.status === 'error' || first.status === 'stopped' || Boolean(run.closedAt);
        const candidate = tasksByCall.get(String(first.toolCallId ?? ''));
        const task = (snapshot.tasks[String(first.taskId ?? '')]
          ?? (candidate && (candidate.rootRunId === item.runId
            || (!candidate.rootRunId && callCounts.get(String(first.toolCallId ?? '')) === 1)) ? candidate : null)
          ?? { key: String(first.toolCallId ?? first.partId), seq: 0, phase: terminal ? 'terminal' : 'running',
            ...(terminal ? { outcome: first.status === 'error' ? 'startfailed' : first.status === 'stopped' ? 'stopped' : 'unknown',
              outcomeReason: first.status === 'error' ? '派单未成功，未启动子任务。' : '本次调用已结束，没有可核对的子任务终态。' } : {}),
            agent: (first.args as Record<string, string> | undefined)?.agent,
            taskText: (first.args as Record<string, string> | undefined)?.description ?? '正在派发子任务', log: [], runs: 1 }) as TranscriptItem['taskSnap'];
        transcripts.push({ id, flow, author: 'hemi', kind: 'task', text: task?.taskText ?? '', createdAt,
          taskId: task?.taskId ?? String(first.taskId ?? ''), taskSnap: task,
          taskFrozen: Boolean(task && snapshot.tasks[task.taskId ?? '']?.toolCallId !== first.toolCallId),
        });
        continue;
      }
      const text = segment.parts.filter((p) => p.kind === 'text').map((p) => String(p.content ?? '')).join('\n\n');
      const notice = segment.parts.filter((p) => p.kind === 'notice').map((p) => String(p.text ?? '')).join('\n');
      const parts = flowPartsToTranscriptParts(segment.parts, { live: !run.closedAt });
      transcripts.push({
        id, flow, author: 'hemi', text: text || notice, createdAt,
        ...(notice && first.level === 'error' ? { kind: 'error' as const } : {}),
        ...(parts?.length ? { parts } : {}),
        ...(!run.closedAt && !run.legacy ? { live: true } : {}),
        ...(run.outcome === 'stopped' ? { replyStatus: 'stopped' as const } : {}),
        ...(legacy.legacyThinking ? { thinking: legacy.legacyThinking } : {}),
        ...(run.usage || legacy.legacyUsage ? { usage: (run.usage ?? legacy.legacyUsage) as TranscriptItem['usage'] } : {}),
      });
    }
    remember();
  }
  if (cache) for (const key of cache.keys()) if (!validKeys.has(key)) cache.delete(key);
  // 首字前的状态也属于这个运行的固定锚点；与首个正式助手项使用同一 key。
  const active = snapshot.activeRunId;
  if (active && !timeline.some((item) => item.kind === 'assistant' && item.runId === active)) {
    transcripts.push({ id: `${active}:a:${String((runs[active]?.inputIds as string[] | undefined)?.[0] ?? 'root')}`, author: 'hemi', text: '', createdAt: Number(runs[active]?.startedAt) || 0,
      live: true, flow: { runId: active, itemId: `${active}:a:${String((runs[active]?.inputIds as string[] | undefined)?.[0] ?? 'root')}`, partIds: [] } });
  }
  return { transcripts, leftoverTurns: 0, source: 'flow' };
}
