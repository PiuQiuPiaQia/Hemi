/**
 * 送主脑模型的历史窗口（提示词缓存友好，2026-10-09）。
 *
 * 旧口径 slice(-32) 每回合滑动一格：对话一过 32 条，窗口起点回回都变，
 * 供应商的前缀缓存在第一条消息就失配，历史部分每轮全量计费。改为起点按
 * STEP 整块前移——至少保留 CONTEXT_TURNS 条、最多 CONTEXT_TURNS+STEP-1 条，
 * 起点在连续 STEP 条新消息内不动，这期间历史前缀逐字节稳定、能命中缓存。
 */

/** 近期目标与追问保留在上下文的最少条数；思考内容不进该消息窗口。 */
export const CONTEXT_TURNS = 32;
/** 窗口起点前移的步长（条）。 */
export const CONTEXT_WINDOW_STEP = 16;

export function contextWindowStart(
  length: number,
  min: number = CONTEXT_TURNS,
  step: number = CONTEXT_WINDOW_STEP,
): number {
  if (length <= min) return 0;
  return Math.floor((length - min) / step) * step;
}

export function contextWindow<T>(entries: readonly T[]): T[] {
  return entries.slice(contextWindowStart(entries.length));
}
