import type { ConversationDeliverableView, FlowSnapshotView } from './protocol.js';

/** 回卷移除的是生产运行；仍留在正式流中的旧代成果继续可用。 */
export function retainedDeliverables(flow: FlowSnapshotView): ConversationDeliverableView[] {
  const runs = new Set(flow.timeline.map(item => item.runId));
  return (Object.values(flow.artifacts ?? {}).filter(Boolean) as ConversationDeliverableView[])
    .filter(item => !item.producers?.length || item.producers.some(producer => producer.runId
      ? runs.has(producer.runId)
      : producer.taskId ? Boolean(flow.tasks[producer.taskId]) : producer.generation === flow.generation));
}
