/** 没有正文不等于执行失败；宿主状态不能引导用户重放已受理工作。 */
export function agentReplyText(result) {
  const text = (result?.texts ?? []).join('\n\n').trim();
  if (text) return text;
  if (result?.waitingForBackground) return '任务已交接到后台，结果就绪后会继续处理。';
  if (result?.waitingForUser?.question) return result.waitingForUser.question;
  if (result?.blocked?.reason) return result.blocked.reason;
  if (result?.halted?.reason) return result.halted.reason;
  return result?.toolNames?.length ? '本轮已处理，具体结果见执行记录。' : '本轮没有返回可展示的内容。';
}
