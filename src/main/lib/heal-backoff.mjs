/**
 * 022 全局 Option 钩子自愈重建的退避梯次（纯逻辑，离线可测）。
 *
 * 背景（2026-09-30 晚间会话审计）：看门狗原先用 10s 固定 setInterval——只要
 * 没见过按键事件就每 10 秒重建一次事件 tap，永不收敛。纯语音用户（本产品
 * 主形态）可能整天不碰键盘：重建会以 6 次/分钟无限空转（CGEventTap 反复
 * 建拆 + 日志刷屏 + 每轮 AppleDouble 清扫）。授权确实迟到时需要重试，但
 * 「用户只是没按键」和「tap 是聋的」不可区分，所以只能退避 + 封顶：
 * 梯次走完后停手，把恢复交还给用户手势（设置页开关 / 去授权 / 输入监控
 * 引导都会重置梯次重新来过，见 global-push-to-talk.mjs）。
 */

/** 重建间隔梯次（毫秒）：10s → 30s → 90s → 5m×3，之后封顶停手。 */
export const HEAL_RESTART_DELAYS_MS = [10_000, 30_000, 90_000, 300_000, 300_000, 300_000];

/**
 * 第 attempt 次（1 起）重建前的等待间隔；attempt 超出梯次长度返回 null
 * （＝已达上限，不再重建）。attempt ≤ 0 按第 1 次处理。
 */
export function nextHealRestartDelayMs(attempt) {
  const index = Math.max(1, Math.trunc(attempt)) - 1;
  return index < HEAL_RESTART_DELAYS_MS.length ? HEAL_RESTART_DELAYS_MS[index] : null;
}
