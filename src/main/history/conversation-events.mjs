import {
  taskCardTurnId, taskResultTurnId, terminalAnnouncementText,
} from '../../shared/task-announcement.mjs';

/** 补回历史卡不按档案排序重新编号；优先沿用活卡或任务身份中的受理序号。 */
export function conversationTaskSeq(record, turns) {
  const card = turns.find((turn) => turn.kind === 'task' && !turn.taskFrozen
    && (turn.taskId ?? turn.taskSnap?.taskId) === record.taskId);
  if (typeof card?.taskSeq === 'number') return card.taskSeq;
  const sequence = Number(/^task-(\d+)-/.exec(record.taskId)?.[1]);
  return sequence > 0 ? sequence : 1;
}

/** 关键任务事实在主进程入史，界面重载或关闭不影响结果归属。 */
export function conversationTurnsForTask(snap) {
  if (!snap?.taskId || !snap.conversationId) return [];
  // 续用（runs 递增）各轮独立落档（bug#15：旧运行记录不被新状态覆盖，A-05）——
  // 首轮 id 保持无后缀（旧档兼容），第 n 轮 id 带 :r{n}。
  const runs = Number(snap.runs) || 1;
  const turns = [{
    id: runs > 1 ? `${taskCardTurnId(snap.taskId)}:r${runs}` : taskCardTurnId(snap.taskId),
    author: 'hemi', kind: 'task',
    text: snap.taskText, createdAt: snap.startedAt ?? snap.log[0]?.at ?? 0,
    taskSeq: snap.seq, taskId: snap.taskId, taskSnap: snap,
  }];
  if (snap.phase !== 'terminal' || snap.verifying) return turns;
  // 050：task-result 回合文本＝交付正文（正文进对话历史——续问时主脑模型的
  // 历史里天然有完整答案，ZCode/DSH 同款）。语音播报走 speechText（announcement），
  // 与这里无关；没有正文终态（denied/blocked 等）沿用播报文案兜底。
  const text = snap.resultText ?? terminalAnnouncementText(snap);
  if (text) turns.push({
    id: taskResultTurnId(snap), author: 'hemi', text, taskId: snap.taskId,
    createdAt: snap.endedAt ?? snap.log.at(-1)?.at ?? 0,
  });
  return turns;
}
