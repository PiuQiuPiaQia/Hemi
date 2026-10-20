/**
 * 048：思考展示的纯函数（无 JSX，node --test 直测；组件与 fixtures 共用）。
 */

/** 时长文案：秒取整；≥60s 用「1m 19s」。 */
export function formatThinkingDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * 最新一行：取最新段落的最后一句；短于 24 字时连同前一句（候选稿口径——
 * 逐 token 流时句子在原位变长、句号后才换句，取「最后一句」即自然实现；
 * 摘要式思考成段到达，整句替换）。
 */
export function latestLineOf(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const last = paragraphs.at(-1) ?? '';
  if (!last) return '';
  const sentences = last
    .split(/(?<=[。！？!?.])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!sentences.length) return '';
  const tail = sentences.at(-1)!;
  if (tail.length >= 24 || sentences.length < 2) return tail;
  return `${sentences.at(-2)}${tail}`;
}

/** 等待占位：起步静默期内不出秒数（多数模型 2s 内就有首个事件，免得一闪而过）。 */
export const WAITING_TIMER_AFTER_MS = 2000;
/** 等待占位：久等改口，在首字门（10s/30s）判超时前先说清「慢在模型侧」。 */
export const WAITING_SLOW_AFTER_MS = 15000;

/** 请求已发出、尚无任何思考/正文事件时的占位文案。 */
export function waitingStatusText(elapsedMs: number): string {
  if (elapsedMs < WAITING_TIMER_AFTER_MS) return '正在想';
  const time = formatThinkingDuration(elapsedMs);
  return elapsedMs < WAITING_SLOW_AFTER_MS ? `正在想 · ${time}` : `等待模型回应 · ${time}`;
}
