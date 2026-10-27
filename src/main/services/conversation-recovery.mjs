import path from 'node:path';
import { snapshotFromRecord } from '../history/task-history.mjs';
import { normalizeRemotePath, remoteDeliveryDenied, resolveDeliveryTargetPath } from '../delivery/register.mjs';
import { projectTaskFact } from './flow-parts-projection.mjs';
import { conversationArtifactId, previewKindOf } from './conversation-deliverables.mjs';

function closeRecoveredTask(task, at) {
  let changed = false, conversationChanged = false;
  if (task.activity) {task.activity=null;changed=true;}
  if (task.permission) {task.permission=null;changed=true;}
  for (const message of task.conversation?.messages ?? []) for (const part of message.parts ?? []) {
    if (part.type === 'thinking' && part.endedAt == null) {
      part.endedAt=task.endedAt ?? at;part.interrupted=true;conversationChanged=true;
    }
    if (part.type === 'tools') for (const call of part.calls ?? []) {
      if (call.state === 'running') {call.state='stopped';conversationChanged=true;}
    }
  }
  if (conversationChanged) task.conversation.revision=(task.conversation.revision ?? 0)+1;
  return changed || conversationChanged;
}

/** 仅恢复仍留在时间线中的调用；任务档案是终态与旧交付的证据，不执行任何工作。 */
export function recoverConversationFlow(snapshot, { readTaskRecord = () => null, workspaceDir = null } = {}) {
  let changed = false;
  const calls = [];
  for (const item of snapshot.timeline ?? []) {
    for (const part of item.parts ?? []) if (part.toolCallId) calls.push({ item, part });
  }
  for (const [id, task] of Object.entries(snapshot.tasks ?? {})) {
    const record = readTaskRecord(id);
    const candidates = calls.filter(({item,part}) => part.toolCallId === task.toolCallId
      && (!part.taskId || part.taskId === id)
      && (!record?.rootRunId || item.runId === record.rootRunId)
      && (!task.rootRunId || item.runId === task.rootRunId));
    const anchor = candidates.find(({part}) => part.taskId === id)
      ?? (candidates.length === 1 ? candidates[0] : null);
    const matches = record && !record.corrupt && record.taskId === id && record.conversationId === snapshot.conversationId
      && record.toolCallId === task.toolCallId && anchor;
    const terminal = matches && (record.endedAt != null || record.interrupted);
    const archived = terminal ? projectTaskFact(snapshotFromRecord(record, 0)).task : null;
    // The last streamed snapshot can be newer than the interrupted task-history record.
    if (archived && !archived.conversation && task.conversation) archived.conversation = task.conversation;
    if (task.phase !== 'terminal' || (archived && (task.outcome !== archived.outcome || task.endedAt !== archived.endedAt))) {
      const recovered = archived ?? {
        ...task, phase: 'terminal', outcome: 'interrupted', permission: null, activity: null,
        endedAt: task.endedAt ?? snapshot.runs?.[task.rootRunId]?.closedAt ?? Date.now(),
        outcomeReason: '应用重启，旧任务已中断；没有继续执行。',
      };
      snapshot.tasks[id] = { ...task, ...recovered, executions: { ...task.executions,
        ...(task.toolCallId ? { [task.toolCallId]: recovered } : {}),
      } };
      changed = true;
    }
    // 续用子会话的每次调用也有独立展示位置；旧执行不能保留假 running。
    for (const [call, execution] of Object.entries(snapshot.tasks[id].executions ?? {})) {
      if (execution.phase === 'terminal') {
        changed=closeRecoveredTask(execution,snapshot.runs?.[task.rootRunId]?.closedAt ?? Date.now()) || changed;
        continue;
      }
      snapshot.tasks[id].executions[call] = archived && call === record.toolCallId ? archived : {
        ...execution, phase: 'terminal', outcome: 'interrupted', permission: null,
        outcomeReason: '应用重启，旧执行已中断。',
      };
      changed = true;
    }
    for (const execution of [snapshot.tasks[id],...Object.values(snapshot.tasks[id].executions ?? {})]) {
      changed=closeRecoveredTask(execution,snapshot.runs?.[task.rootRunId]?.closedAt ?? Date.now()) || changed;
    }
    if (!matches) continue;
    const owner = anchor.item;
    const run = snapshot.runs?.[owner.runId];
    if (!run) continue;
    // 仅消费原 register_delivery 的持久记录，不从回复路径猜测交付。
    for (const file of record.deliverables ?? []) {
      if (file?.kind !== 'file' || !file.path) continue;
      const host = file.host ?? record.workspace?.host ?? null;
      let target;
      if (host) {
        target = normalizeRemotePath(file.path, { dir: record.workspace?.dir, home: record.workspace?.remoteHome });
        if (!target || remoteDeliveryDenied(target, { home: record.workspace?.remoteHome })) continue;
      } else {
        const resolved = resolveDeliveryTargetPath(file.path, { workspaceDir: record.workspace?.dir ?? workspaceDir });
        if (resolved.error) continue;
        target = resolved.target;
      }
      const name = host ? path.posix.basename(target) : path.basename(target);
      const artifactId = conversationArtifactId({ host, target });
      const previous = snapshot.artifacts[artifactId];
      const producers = previous?.producers ?? [];
      if (!producers.some(p => p.runId === owner.runId && p.taskId === id)) {
        const at = file.registeredAt ?? record.endedAt ?? record.updatedAt ?? 0;
        snapshot.artifacts[artifactId] = { ...previous, artifactId, kind: 'file', name,
          path: target, ...(host ? { host } : {}), description: file.description,
          previewKind: previewKindOf(target), producerRunId: previous?.producerRunId ?? owner.runId,
          taskId: previous?.taskId ?? id, contentVersion: previous?.contentVersion ?? 1,
          registeredAt: previous?.registeredAt ?? at,
          producers: [...producers, { runId: owner.runId, taskId: id, generation: run.generation ?? snapshot.generation, at }],
        };
        changed = true;
      }
      if (!(snapshot.timeline ?? []).some(item => (item.parts ?? []).some(part => part.artifactId === artifactId && part.kind === 'deliverable'))) {
        owner.parts.push({ partId: `dl-${artifactId}`, kind: 'deliverable', artifactId, name, ...(host ? { host } : {}) });
        changed = true;
      }
    }
  }
  if (changed) snapshot.revision += 1;
  return { snapshot, changed };
}
