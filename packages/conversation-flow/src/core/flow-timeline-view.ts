/** 060：所有展示时点共用的纯投影。flow 决定位置和身份，档案仅补对应载荷。 */
import type { FlowSnapshotView } from './protocol.js';
import type { ModelRecoveryView, TranscriptItem } from '../types/presentation.js';
import { flowPartsToTranscriptParts } from './transcript-parts-view.js';
import { flowDeliverableParts } from './flow-deliverables.js';

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
  const tailItems = new Map<string, (typeof timeline)[number]>();
  for (const item of timeline) if (item.kind === 'assistant') tailItems.set(item.runId, item);
  const recoveries = new Map<string, {recovery: ModelRecoveryView; index: number}>();
  const recoveryErrors = new Map<string, string>();
  for (const [runId, run] of Object.entries(runs)) {
    const recovery = run.recovery;
    if (!recovery) continue;
    const items = timeline.filter((item): item is Extract<typeof item, {kind: 'assistant'}> => item.kind === 'assistant' && item.runId === runId);
    let target = items.find(item => item.itemId === recovery.anchor?.itemId);
    let index = -1;
    if (target && recovery.anchor) {
      const afterPartId = recovery.anchor.afterPartId;
      index = afterPartId === null ? 0 : target.parts.findIndex(part => part.partId === afterPartId) + 1;
      if (afterPartId !== null && index === 0) {target = undefined; index = -1;}
    }
    // Older snapshots have no anchor. Use their first timestamped output after
    // the interruption, retaining stored order for parts without timestamps.
    if (!target) for (const item of items) {
      const after = item.parts.findIndex(part => Number(part.startedAt) >= recovery.firstFailureAt);
      if (after >= 0) {target = item; index = after; break;}
    }
    target ??= items.at(-1);
    if (target) recoveries.set(target.itemId, {recovery, index: index < 0 ? target.parts.length : index});
    if (['failed', 'expired'].includes(recovery.phase)) {
      for (const item of items) for (const part of item.parts)
        if (part.kind === 'notice' && part.level === 'error') recoveryErrors.set(runId, String(part.text ?? ''));
    }
  }
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
  const deliveryParts = flowDeliverableParts(snapshot);
  const validKeys = new Set<string>();
  for (const item of timeline) {
    const run = runs[item.runId] ?? EMPTY_RUN;
    const rowKey = item.kind === 'user' ? item.id : item.itemId;
    validKeys.add(rowKey);
    const filteredParts = item.kind === 'assistant' ? deliveryParts.get(item.itemId) ?? [] : [];
    const recoveryPosition = item.kind === 'assistant' ? recoveries.get(item.itemId) : undefined;
    const archived = byId.get(item.kind === 'user' ? item.id : String((item as { legacyTurnId?: string }).legacyTurnId ?? ''));
    const isTailItem = tailItems.get(item.runId) === item;
    const dependencies: unknown[] = [item, run, archived, isTailItem, recoveryPosition?.index, recoveryErrors.get(item.runId), ...filteredParts];
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
    const segments: Array<{ kind: 'body' | 'delegation' | 'notice' | 'recovery'; parts: typeof item.parts }> = [];
    const positionedParts = [...filteredParts];
    if (recoveryPosition) {
      const preceding = new Set(item.parts.slice(0, recoveryPosition.index).map(part => part.partId));
      let before = 0;
      for (const [index, part] of positionedParts.entries()) if (preceding.has(part.partId)) before = index + 1;
      positionedParts.splice(before, 0, {kind: 'recovery', partId: `recovery:${recoveryPosition.recovery.id}`});
    }
    for (const part of positionedParts) {
      if (part.kind === 'notice' && part.level === 'error' && recoveryErrors.has(item.runId)) continue;
      const kind = part.kind === 'recovery' ? 'recovery' : part.kind === 'delegation' ? 'delegation' : part.kind === 'notice' ? 'notice' : 'body';
      const last = segments.at(-1);
      if (last && last.kind === kind && kind === 'body') last.parts.push(part);
      else segments.push({ kind, parts: [part] });
    }
    for (const segment of segments) {
      const first = segment.parts[0];
      const id = first.partId === item.parts[0]?.partId ? item.itemId : `${item.itemId}:${first.partId}`;
      const flow = { runId: item.runId, itemId: item.itemId, partIds: segment.parts.map((p) => p.partId) };
      const createdAt = Number(run.startedAt) || 0;
      if (segment.kind === 'recovery' && recoveryPosition) {
        const failure = recoveryErrors.get(item.runId);
        transcripts.push({id: `${item.itemId}:${first.partId}`, flow: {...flow, partIds: []}, author: 'hemi',
          text: failure ?? '', createdAt: recoveryPosition.recovery.firstFailureAt, recovery: recoveryPosition.recovery,
          ...(failure !== undefined ? {kind: 'error' as const} : {})});
        continue;
      }
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
        streaming: !run.closedAt && !run.legacy && !['waiting','connecting','offline'].includes(String(run.recovery?.phase))
          && !String(run.activity?.phase ?? '').startsWith('waiting-')
          && isTailItem && segment.parts.at(-1) === item.parts.at(-1),
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
    const recovery = runs[active]?.recovery;
    const itemId = recovery?.anchor?.itemId ?? `${active}:a:${String((runs[active]?.inputIds as string[] | undefined)?.[0] ?? 'root')}`;
    transcripts.push({ id: recovery ? `${itemId}:recovery:${recovery.id}` : itemId, author: 'hemi', text: '', createdAt: Number(runs[active]?.startedAt) || 0,
      live: true, recovery, flow: { runId: active, itemId, partIds: [] } });
  }
  return { transcripts, leftoverTurns: 0, source: 'flow' };
}
