/**
 * 对话流时间序（2026-10-09：思考中切会话再切回，受理语掉到它派生的任务卡下面）。
 * 会话档案按 createdAt 排序（宿主合并），渲染层按到达顺序追加——两边同一口径，
 * 实时画面与重载后的画面才一致。
 */

/**
 * 回合回复的时间戳：派生过任务的回合，受理语排在任务卡之前——卡的 createdAt
 * 是任务受理时刻（回合中途），回执时刻在后会让「好，交给我」落到卡下面。
 */
export function replyCreatedAt(endedAt, taskSubmittedAt) {
  return taskSubmittedAt == null ? endedAt : Math.min(endedAt, taskSubmittedAt - 1);
}

/** 按 createdAt 插入：从尾部回找，只越过严格更晚的条目（同刻保持到达顺序）。 */
export function insertByCreatedAt(list, item) {
  let index = list.length;
  while (index > 0 && list[index - 1].createdAt > item.createdAt) index -= 1;
  return [...list.slice(0, index), item, ...list.slice(index)];
}
