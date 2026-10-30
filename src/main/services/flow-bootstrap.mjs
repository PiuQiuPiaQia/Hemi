/**
 * 057 旧档引导（S2 渲染层前置；S3 迁移的转换函数先行）：没有 flow 快照的旧会话，
 * 打开时按 turns 原存储顺序一次性投影出 flow 快照（契约 §8「旧 turns 按原顺序
 * 投影、缺 ID 用源条目位置作确定迁移身份、不凭正文删重或推测并入关系」）。
 *
 * 纯函数：user 轮 → 用户项；hemi 轮 → 助手段（turn.parts 思考/正文/工具组按序映射，
 * 无 parts 的整条回执落单个 text part）；kind:task → 助手段 delegation part＋
 * flow.tasks 投影；kind:error → notice part。全部条目挂在单一 legacy 伪运行下
 * （runs 只留摘要，不重建执行状态）。
 */
import { createFlowSnapshot, FLOW_SCHEMA_VERSION } from '../../shared/conversation-flow.mjs';
import { projectTaskFact } from './flow-parts-projection.mjs';

const isTurn = (entry) => entry && typeof entry === 'object' && typeof entry.author === 'string';

/** turns（conversation JSON 的 turns 数组）→ FlowSnapshot；空/无 turns 返回 null。 */
export function bootstrapFlowFromTurns(turns, { conversationId } = {}) {
  const list = Array.isArray(turns) ? turns.filter(isTurn) : [];
  if (!list.length) return null;
  const snapshot = createFlowSnapshot({ conversationId: String(conversationId ?? '') });
  const timeline = [];
  const tasks = {};
  let partSeq = 0;
  const partId = (kind) => `legacy:${kind}${(partSeq += 1)}`;

  for (const [index, turn] of list.entries()) {
    const createdAt = Number(turn.createdAt) || 0;
    if (turn.author === 'user') {
      if (turn.withdrawn) continue; // 已撤回的旧排队项不复活
      timeline.push({
        id: typeof turn.id === 'string' && turn.id ? turn.id : `legacy:u${index}`,
        kind: 'user',
        runId: 'legacy',
        text: String(turn.text ?? ''),
        inputSource: turn.inputSource === 'voice' ? 'voice' : 'text',
        attachmentIds: [],
        ...(Array.isArray(turn.attachments) && turn.attachments.length ? { attachments: turn.attachments } : {}),
        // 063：旧档回看带引用与技能标签（无 flow 快照的会话走这里投影）。
        ...(Array.isArray(turn.references) && turn.references.length ? { references: turn.references } : {}),
        ...(Array.isArray(turn.skills) && turn.skills.length ? { skills: turn.skills } : {}),
        acceptedAt: createdAt,
        deliveredAt: createdAt,
      });
      continue;
    }
    if (turn.kind === 'task') {
      const taskId = String(turn.taskId ?? '');
      const snap = turn.taskSnap ?? null;
      const fact = snap ? projectTaskFact(snap) : null;
      if (fact) tasks[fact.task.taskId] = fact.task;
      else if (taskId) tasks[taskId] = { taskId, key: taskId, phase: 'terminal', outcome: 'complete', taskText: String(turn.text ?? '') };
      timeline.push({
        itemId: typeof turn.id === 'string' && turn.id ? turn.id : `legacy:a${index}`,
        legacyTurnId: turn.id,
        kind: 'assistant',
        runId: 'legacy',
        afterInputId: null,
        parts: [{
          partId: partId('d'),
          kind: 'delegation',
          toolCallId: snap?.toolCallId ?? taskId,
          taskId,
          status: 'done',
        }],
      });
      continue;
    }
    const parts = [];
    if (Array.isArray(turn.parts)) {
      for (const part of turn.parts) {
        if (part?.type === 'thinking' && typeof part.text === 'string') {
          // 065：保留思考段起止（旧档回看思考时长、完成态整轮「用时 X」兜底估算都用它）。
          parts.push({
            partId: partId('k'),
            kind: 'thinking',
            content: part.text,
            startedAt: Number(part.startedAt) || 0,
            endedAt: Number(part.endedAt) || 0,
          });
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          parts.push({ partId: partId('t'), kind: 'text', content: part.text });
        } else if (part?.type === 'tools' && Array.isArray(part.calls)) {
          for (const call of part.calls) {
            parts.push({
              partId: partId('w'),
              kind: call.tool === 'task' ? 'delegation' : 'tool',
              toolCallId: String(call.id ?? partId('u')),
              tool: String(call.tool ?? ''),
              status: call.state === 'running' ? 'running' : call.state === 'error' ? 'error' : 'done',
              ...(call.args && typeof call.args === 'object' ? { args: call.args } : {}),
            });
          }
        }
      }
    }
    if (turn.kind === 'error' || (!parts.length && turn.kind === 'error')) {
      parts.push({ partId: partId('n'), kind: 'notice', level: 'error', text: String(turn.text ?? '') });
    } else if (!parts.length) {
      const text = String(turn.text ?? '');
      if (text) parts.push({ partId: partId('t'), kind: 'text', content: text });
    }
    if (!parts.length) continue;
    timeline.push({
      itemId: typeof turn.id === 'string' && turn.id ? turn.id : `legacy:a${index}`,
      legacyTurnId: turn.id,
      kind: 'assistant',
      runId: 'legacy',
      afterInputId: null,
      parts,
      // 旧档回执的思考/用量随段保留（回看展开用；不进模型上下文）。
      ...(turn.thinking ? { legacyThinking: turn.thinking } : {}),
      ...(turn.usage ? { legacyUsage: turn.usage } : {}),
    });
  }

  snapshot.timeline = timeline;
  snapshot.tasks = tasks;
  snapshot.runs = {
    legacy: {
      runId: 'legacy',
      generation: 1,
      source: 'user',
      inputIds: [],
      startedAt: null,
      endedAt: null,
      closedAt: null,
      outcome: null,
      legacy: true,
    },
  };
  snapshot.revision = 1;
  snapshot.schemaVersion = FLOW_SCHEMA_VERSION;
  snapshot.historyVersion = 1;
  return snapshot;
}

/**
 * 旧的局部 flow 不具备完整历史身份：在恢复边界把权威 turns 整体迁为只读历史，
 * 不在 renderer 按正文／作者猜配两份列表。保留运行账本、队列与交付登记；新回合
 * 从同一 timeline 继续写。调用方必须先备份源记录再提交，不得对在途控制器执行。
 */
export function normalizeFlowHistory(flow, turns, { conversationId = flow?.conversationId } = {}) {
  const list = Array.isArray(turns) ? turns.filter(isTurn) : [];
  const users = new Set((flow?.timeline ?? []).filter(item => item.kind === 'user').map(item => item.id));
  const missingInputIds = list.flatMap((turn, index) => {
    const id = typeof turn.id === 'string' && turn.id ? turn.id : `legacy:u${index}`;
    return turn.author === 'user' && !turn.withdrawn && !users.has(id) ? [id] : [];
  });
  const unversionedHistory = list.length && flow?.historyVersion !== 1
    && Object.values(flow?.runs ?? {}).every(run => run.legacy);
  if (!flow || (flow.schemaVersion ?? 1) > FLOW_SCHEMA_VERSION || (!missingInputIds.length && !unversionedHistory)) {
    return { snapshot: flow, changed: false, missingInputIds };
  }
  const historical = bootstrapFlowFromTurns(list, { conversationId });
  if (!historical) return { snapshot: flow, changed: false, missingInputIds };
  const restored = restoreFlowSnapshot(flow);
  // 原有调用的所属运行是明确身份，保留它供任务／交付恢复校验；其余历史不猜归属。
  const owners = new Map((flow.timeline ?? []).flatMap(item => (item.parts ?? []).flatMap(part =>
    part.toolCallId ? [[part.toolCallId, item.runId]] : [])));
  for (const item of historical.timeline) {
    const owner = item.parts?.map(part => owners.get(part.toolCallId)).find(Boolean);
    if (owner) item.runId = owner;
  }
  const generation = (flow.generation ?? 1) + 1;
  return { changed: true, missingInputIds, snapshot: {
    ...historical,
    ...restored,
    historyVersion: 1,
    revision: flow.revision + 1,
    generation,
    timeline: historical.timeline,
    runs: { ...restored.runs, legacy: { ...historical.runs.legacy, generation } },
    tasks: { ...historical.tasks, ...restored.tasks },
  } };
}

/**
 * 恢复口径（契约 §8：恢复统一将遗留主运行标中断）：读到的持久 flow 若停在
 * 运行中，恢复为 idle＋对应运行 outcome=interrupted；待发送项保留、队列暂停
 * （submitting 按证据回 pending 或 needs-review——无证据即 needs-review）。
 */
export function restoreFlowSnapshot(flow) {
  if (!flow || typeof flow !== 'object') return null;
  const snapshot = structuredClone(flow);
  // Process ownership is recovered by the host, never inferred from a saved UI list.
  snapshot.backgroundJobs=[];
  const at = Date.now();
  for (const run of Object.values(snapshot.runs ?? {})) {
    if (!run.legacy && run.closedAt == null && (run.runId === snapshot.activeRunId || run.outcome == null)) {
      run.outcome = run.outcome ?? 'interrupted';
      run.closedAt = at;
    }
    if (run.closedAt != null) {
      run.endedAt ??= run.closedAt;
      run.activity = null;
      if (run.recovery && !['expired','recovered','stopped'].includes(run.recovery.phase)) run.recovery = { ...run.recovery, phase: 'stopped', nextRetryAt: null, summary: '应用重启，自动恢复已停止。' };
    }
  }
  snapshot.activeRunId = null;
  snapshot.phase = 'idle';
  const notices = new Set(), interruptedTails = new Map();
  for (const item of snapshot.timeline ?? []) {
    const run = snapshot.runs?.[item.runId];
    if (!run || run.closedAt == null) continue;
    for (const part of item.parts ?? []) {
      notices.add(part.partId);
      if (['tool','delegation'].includes(part.kind) && part.status === 'running') part.status = 'stopped';
      if (part.kind === 'thinking' && part.endedAt == null) {
        part.endedAt = run.closedAt; part.interrupted = true;
      }
    }
    if (item.kind === 'assistant' && run.outcome === 'interrupted') interruptedTails.set(item.runId,item);
  }
  for (const [runId,item] of interruptedTails) {
    const partId = `${runId}:restart`;
    if (notices.has(partId)) continue;
    item.parts ??= [];
    item.parts.push({partId,kind:'notice',level:'info',text:'应用已重启，此任务已中断。已有结果已保留，未确认完成的操作不会自动重跑。'});
  }
  snapshot.queuePaused = snapshot.pending?.length ? true : snapshot.queuePaused;
  if (Array.isArray(snapshot.pending)) {
    snapshot.pending = snapshot.pending.map((item) => (
      item.state === 'submitting' ? { ...item, state: 'needs-review' } : item.state === 'editing' ? { ...item, state: 'pending' } : item
    ));
  }
  return snapshot;
}
