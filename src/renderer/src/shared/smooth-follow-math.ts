/**
 * 对话流平滑跟随的两条判定（use-smooth-follow 的纯函数部分，可单测）。
 *
 * 2026-10-11 用户反馈「对话流轻轻滑动还往上自动弹」，真机实测两处根因：
 * ① 逼近步长按距离 22% 算，剩 1px 时每帧只写 +0.22，浏览器按设备像素取整
 *    写不进去，距离永远是 1——rAF 每秒 60 次写 scrollTop 的死循环
 *    （中转站会话 1 秒 60 次写入，3633.22→3633）；
 * ② 「离底 36px 内就恢复跟随」不分方向：轻轻上滑停在阈值内，scroll 事件又把
 *    跟随打开，下一次重渲染就把视图拽回底部。
 */

/** 一帧的逼近：至少走 1px；剩余不足 1px 直接落到目标并结束。 */
export function followStep(scrollTop: number, target: number, ratio: number): { next: number; done: boolean } {
  const distance = target - scrollTop;
  if (Math.abs(distance) <= 1) return { next: target, done: true };
  const step = distance * ratio;
  return { next: scrollTop + (Math.abs(step) < 1 ? Math.sign(distance) : step), done: false };
}

/**
 * 滚动后跟随状态怎么变：贴底（≤1px）一定恢复；阈值内只有「往下靠近」才恢复；
 * 往上走（滚轮之外的滚动条拖拽也算）一律暂停；其余保持不变。
 */
export function followAfterScroll(
  distanceToBottom: number,
  movedBy: number,
  threshold: number,
): 'pin' | 'unpin' | 'keep' {
  if (distanceToBottom <= 1) return 'pin';
  if (movedBy > 0 && distanceToBottom < threshold) return 'pin';
  if (movedBy < 0) return 'unpin';
  return 'keep';
}
