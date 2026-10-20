/** 主进程入史与渲染层播报共用同一文案和稳定身份。 */
export function taskCardTurnId(taskId) {
  return `task-card:${taskId}`;
}

export function taskResultTurnId(snap) {
  return `task-result:${snap.taskId ?? snap.key}:${snap.resultVersion ?? snap.outcome}`;
}

/**
 * 050 语音播报口径：只念 speechText（回炉产的一两句口语交代），绝不念正文——
 * 正文可能带长表与清单（R-14）。speechText 缺失时按终态降级固定短句；正文
 * 在不在屏幕上与语音无关。
 */
export function terminalAnnouncementText(snap) {
  if (snap.speechText != null && String(snap.speechText).trim()) return snap.speechText;
  if (snap.outcome === 'complete') return '任务完成了，详情在屏幕上。';
  if (snap.outcome === 'partial') return '任务部分完成，详情在屏幕上。';
  if (snap.outcome === 'stopped') return '任务已停止，已完成的部分在屏幕上。';
  if (snap.outcome === 'blocked') return '这一步碰到了安全底线，被拦下了；换个说法，我再试试。';
  if (snap.outcome === 'denied') return '这一步没等到你的允许，我先停在这儿。';
  if (snap.outcome === 'unknown') {
    if (/授权.*(超时|被拒)/.test(snap.outcomeReason ?? '')) {
      const executed = (snap.recentToolCalls ?? []).some((call) => call.actionState !== 'not-executed');
      return `${executed ? '已执行部分查询，但后续操作' : '这条任务的操作'}因授权超时或未获允许而受阻，没拿到可核实的结果；需要继续处理的话，直接告诉我。`;
    }
    if (/中断/.test(snap.outcomeReason ?? '')) {
      return '任务执行中断，尚未拿到最终结果；需要继续处理的话，直接告诉我。';
    }
    return '任务已结束，但没有返回明确结果；需要继续处理的话，直接告诉我。';
  }
  return snap.outcomeReason ?? null;
}
