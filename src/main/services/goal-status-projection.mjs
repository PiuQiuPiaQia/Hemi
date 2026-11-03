/** 收口后的异步账本投影只写回发起读取时的控制器、代次与运行集合。
 * 新回合即使已再次收口、回卷或会话被关闭重开，也不能接收旧读取结果。
 * runs/goal 的引用由纯归约器在实际变更时替换；任务、队列等无关更新不影响投影。
 */
export async function publishGoalStatus({conversationId, journal, flowService}) {
  if (!journal || !flowService?.has(conversationId)) return false;
  const controller = flowService.controllerFor(conversationId);
  const before = controller.getSnapshot();
  if (before.phase !== 'idle') return false;
  const {goal} = await journal.goalProjection(conversationId,{generation:before.generation});
  if (!flowService.has(conversationId) || flowService.controllerFor(conversationId) !== controller) return false;
  const current = controller.getSnapshot();
  if (current.phase !== 'idle' || current.generation !== before.generation || current.runs !== before.runs || current.goal !== before.goal) return false;
  return controller.applyFact({type:'goal-status', generation:before.generation, goal:goal ?? null}).applied;
}
