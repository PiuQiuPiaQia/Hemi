import { projectTaskFact } from './flow-parts-projection.mjs';

/** 聚合广播不是单个任务：逐项路由，终态立即冲刷所属会话的过程态。 */
export function createTaskFactPublisher({ flowService, schedule = setTimeout, cancel = clearTimeout }) {
  const pending = new Map();
  const seen = new Map();
  function flush(conversationId) {
    const entry = pending.get(conversationId);
    if (!entry) return;
    cancel(entry.timer);
    pending.delete(conversationId);
    for (const fact of entry.facts.values()) entry.controller.applyFact(fact);
  }
  return {
    publish(snapshot) {
      for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : [snapshot]) {
        const conversationId = task?.conversationId;
        if (!conversationId || !flowService.has(conversationId)) continue;
        const controller = flowService.controllerFor(conversationId);
        const flow = controller.getSnapshot();
        // 编辑撤回后，仍在聚合广播中的旧任务不能再次进入正式流。
        const anchors = flow.timeline.flatMap(item => (item.parts ?? [])
          .filter(part => part.kind === 'delegation' && part.toolCallId === task.toolCallId
            && (!task.rootRunId || item.runId === task.rootRunId))
          .map(part => ({ item, part })));
        if (task.toolCallId && anchors.length !== 1) continue;
        const fact = projectTaskFact(task, { generation: flow.generation });
        if (!fact) continue;
        if (task.toolCallId) {
          const { item, part } = anchors[0];
          if (part.taskId !== fact.task.taskId) controller.applyFact({
            type: 'part-updated', runId: item.runId, partId: part.partId,
            generation: flow.generation, patch: { taskId: fact.task.taskId },
          });
        }
        const key = `${conversationId}:${fact.task.taskId}`;
        const signature = JSON.stringify(fact.task);
        if (seen.get(key) === signature) continue;
        seen.set(key, signature);
        let entry = pending.get(conversationId);
        if (!entry) {
          entry = { controller, facts: new Map(), timer: null };
          pending.set(conversationId, entry);
        }
        entry.facts.set(fact.task.taskId, fact);
        if (task.phase === 'terminal') flush(conversationId);
        else if (!entry.timer) {
          entry.timer = schedule(() => flush(conversationId), 400);
          entry.timer?.unref?.();
        }
      }
    },
    dispose() {
      for (const entry of pending.values()) cancel(entry.timer);
      pending.clear(); seen.clear();
    },
  };
}
