/** 只读列表投影：不创建控制器、不恢复或派发任务。离线档案不能冒充在途运行。 */
export function conversationStatus(flow, { live = false, isTaskLive = () => true } = {}) {
  if (!flow || !live) return null;
  if(flow.awaitingUser)return 'waiting';
  const active = ['preparing', 'running', 'stopping'].includes(flow.phase);
  const tasks = Object.values(flow.tasks ?? {}).filter(task => task && typeof task === 'object');
  const working = live && tasks.filter(task => task.phase && task.phase !== 'terminal' && isTaskLive(task));
  if (active && flow.phase !== 'stopping' && String(flow.runs?.[flow.activeRunId]?.activity?.phase ?? '').startsWith('waiting-')) return 'waiting';
  if (active || (working && working.length)) return 'running';
  return null;
}

/**
 * 本进程新收口、应视作「新结果」的主回合（未读与完成通知共用同一口径）：
 * 旧档里的历史运行、停止／中断、准备卡都不算。
 */
export function newSettledRuns(record, flow) {
  return Object.values(flow?.runs ?? {}).filter(run => run
    && ['user', 'queue', 'event'].includes(run.source)
    && ['completed', 'partial', 'failed', 'blocked', 'awaiting-user', 'awaiting-background'].includes(run.outcome)
    && run.closedAt != null && record?.flow?.runs?.[run.runId]?.closedAt == null);
}

/** 新收口的用户／排队／事件回合产生未读；旧档、停止、准备卡和重复保存不产生通知。 */
export function withConversationUnread(record, flow, now = Date.now()) {
  if (!newSettledRuns(record, flow).length) return { ...record, flow };
  // CAS 清读后的新结果也有独立身份，即便同一毫秒收口也不会被旧回执清掉。
  const unreadAt = Math.max(now, (record.unreadAt ?? 0) + 1, (record.lastReadAt ?? 0) + 1);
  return { ...record, flow, unreadAt };
}
